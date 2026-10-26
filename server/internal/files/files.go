// Package files implements the ADR-0002 Phase 1b Desktop-file bridge: the
// owner's Desktop files served read-only over the same-origin /api/files
// surface, so The Globe in a browser (including tailnet devices holding the
// shared secret) can view files created on this PC.
//
// Security posture (same guard as every /api/* route, plus file rules):
//   - config.AssertAPIRequest runs first on both routes — non-loopback
//     callers need API_SERVER_KEY; there are no anonymous off-loopback reads.
//   - Resolve rejects traversal, path separators, absolute paths, drive
//     letters / ADS streams, Windows-mangled trailing dots/spaces, and any
//     symlink/reparse point whose resolved target escapes GLOBE_FILES_ROOT.
//     Serving goes through OpenResolved: the opened fd is SameFile-verified
//     against the vetted resolution, so a symlink swap between resolution
//     and open (TOCTOU, P2-5) fails closed with 404 instead of serving an
//     unlisted file.
//   - Only allow-listed extensions (GLOBE_FILES_EXT) are listed or served,
//     and only up to GLOBE_FILES_MAX_BYTES per file.
//   - .svg is served as text/plain (never image/svg+xml): inline SVG can
//     carry script, and the bridge is a viewer, not a file manager.
//   - The listing only contains servable files — a disallowed name never
//     appears, so the surface cannot be used to probe the Desktop.
//
// Method note: GET only (HEAD is served by the content sender); anything
// else is a 405. The bridge is read-only by construction — there is no
// write, rename, or delete path.
package files

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/alfirus/theglobe/server/internal/config"
)

// ── env contracts ─────────────────────────────────────────────────────

// DefaultExtList is the default GLOBE_FILES_EXT: the viewable types from the
// Phase 1b card (pdf, images, plain-text family). Both jpg and jpeg spellings
// are accepted; matching is case-insensitive.
const DefaultExtList = "pdf,png,jpg,jpeg,gif,webp,svg,txt,md,csv"

// DefaultMaxBytes is the default GLOBE_FILES_MAX_BYTES: 10 MiB per file.
const DefaultMaxBytes = 10 << 20

// Root returns the bridge root: GLOBE_FILES_ROOT, defaulting to the current
// user's Desktop. Empty means the home directory could not be resolved —
// callers treat that as an empty bridge, never as the filesystem root.
func Root() string {
	if v := strings.TrimSpace(os.Getenv("GLOBE_FILES_ROOT")); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ""
	}
	return filepath.Join(home, "Desktop")
}

// AllowedExts parses GLOBE_FILES_EXT into a lowercase extension set (no
// leading dots). Empty entries are ignored; an empty/unset knob falls back
// to DefaultExtList. Matching is case-insensitive.
func AllowedExts() map[string]bool {
	raw := strings.TrimSpace(os.Getenv("GLOBE_FILES_EXT"))
	if raw == "" {
		raw = DefaultExtList
	}
	out := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		e := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(part), "."))
		if e != "" {
			out[e] = true
		}
	}
	return out
}

// MaxBytes parses GLOBE_FILES_MAX_BYTES. Garbage, zero, or negative values
// fall back to DefaultMaxBytes — a misconfigured knob must fail closed to a
// sane cap, never to unbounded.
func MaxBytes() int64 {
	raw := strings.TrimSpace(os.Getenv("GLOBE_FILES_MAX_BYTES"))
	if raw == "" {
		return DefaultMaxBytes
	}
	if v, err := strconv.ParseInt(raw, 10, 64); err == nil && v > 0 {
		return v
	}
	return DefaultMaxBytes
}

// ── content types ─────────────────────────────────────────────────────

// ContentTypeFor maps a file name to its served Content-Type. The second
// return reports whether the extension is in the allow-list at all (unknown
// extensions are never served, regardless of size).
//
// .svg is deliberately text/plain, not image/svg+xml: inline SVG executes
// script in a browser context, and this bridge previews files — it must not
// become a stored-XSS vector on the owner's Desktop.
func ContentTypeFor(name string) (string, bool) {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	switch ext {
	case "pdf":
		return "application/pdf", true
	case "png":
		return "image/png", true
	case "jpg", "jpeg":
		return "image/jpeg", true
	case "gif":
		return "image/gif", true
	case "webp":
		return "image/webp", true
	case "svg", "txt":
		return "text/plain; charset=utf-8", true
	case "md":
		return "text/markdown; charset=utf-8", true
	case "csv":
		return "text/csv; charset=utf-8", true
	}
	if AllowedExts()[ext] {
		// Operator extended the allow-list with an extension we have no
		// mapping for — serve it as an opaque download, never sniffed.
		return "application/octet-stream", true
	}
	return "", false
}

// ── path safety ───────────────────────────────────────────────────────

// Resolve validates a user-supplied file name against root and returns the
// resolved absolute path. It rejects:
//   - empty names, "." / "..", absolute paths, drive letters and ADS
//     streams (any ":"), path separators (both slashes), CR/LF (header
//     injection), and Windows-mangled trailing dots/spaces;
//   - anything that is not a regular file after full symlink resolution;
//   - any resolved path that escapes root (symlink/reparse-point breakout,
//     including a malicious root swap — root itself is resolved too).
//
// Callers map ErrNotFound to 404 and every other error to 400/403 via
// resolveStatus below.
func Resolve(root, name string) (string, error) {
	resolved, _, err := resolve(root, name)
	return resolved, err
}

// resolveOpenHook runs between path resolution and open inside OpenResolved.
// Nil in production; tests set it to simulate a symlink swap in the window.
var resolveOpenHook func()

// OpenResolved resolves name and opens the result as a single verified step
// (P2-5 TOCTOU hardening): the served bytes come from the opened fd, and the
// fd is verified to be the file Resolve just vetted before any byte is
// served. A swap of the resolved target between resolution and open —
// symlink retarget or rename-over — fails closed with ErrNotFound instead of
// serving an unlisted file.
//
// Identity check is belt-and-braces across platforms: os.SameFile is exact
// where the OS exposes file IDs (Linux), and size+mtime revalidation covers
// platforms where it does not (Windows SameFile compares only
// attributes/timestamps/size, so same-size rapid replacements compare equal).
func OpenResolved(root, name string) (*os.File, os.FileInfo, error) {
	resolved, info, err := resolve(root, name)
	if err != nil {
		return nil, nil, err
	}
	if resolveOpenHook != nil {
		resolveOpenHook()
	}
	f, err := os.Open(resolved)
	if err != nil {
		return nil, nil, ErrNotFound
	}
	fi, err := f.Stat()
	if err != nil ||
		!fi.Mode().IsRegular() ||
		!os.SameFile(info, fi) ||
		fi.Size() != info.Size() ||
		!fi.ModTime().Equal(info.ModTime()) {
		_ = f.Close()
		return nil, nil, ErrNotFound
	}
	return f, fi, nil
}

func resolve(root, name string) (string, os.FileInfo, error) {
	if strings.TrimSpace(name) == "" {
		return "", nil, fmt.Errorf("empty file name")
	}
	if strings.ContainsAny(name, `/\`) {
		return "", nil, fmt.Errorf("file name must not contain path separators")
	}
	if filepath.IsAbs(name) || strings.Contains(name, ":") {
		return "", nil, fmt.Errorf("file name must be a bare file name")
	}
	if name == "." || name == ".." {
		return "", nil, fmt.Errorf("file name must be a bare file name")
	}
	if strings.ContainsAny(name, "\r\n") {
		return "", nil, fmt.Errorf("file name contains control characters")
	}
	if strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
		// Windows strips trailing dots/spaces on write, so "report." and
		// "report" would name the same file — reject the ambiguous form.
		return "", nil, fmt.Errorf("file name must not end with a dot or space")
	}
	if filepath.Clean(name) != name {
		return "", nil, fmt.Errorf("file name is not canonical")
	}

	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", nil, err
	}
	resolvedRoot, err := filepath.EvalSymlinks(absRoot)
	if err != nil {
		return "", nil, ErrNotFound
	}
	candidate := filepath.Join(absRoot, name)
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", nil, ErrNotFound
	}
	rel, err := filepath.Rel(resolvedRoot, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", nil, fmt.Errorf("file escapes the bridge root: %w", errEscape)
	}
	st, err := os.Stat(resolved)
	if err != nil {
		return "", nil, ErrNotFound
	}
	if !st.Mode().IsRegular() {
		return "", nil, ErrNotFound
	}
	return resolved, st, nil
}

// ErrNotFound marks “no such servable file” (missing, directory, or special
// file). ErrEscape marks a resolved-path breakout past the root.
var (
	ErrNotFound = fmt.Errorf("file not found")
	errEscape   = fmt.Errorf("escape")
)

// ── listing ───────────────────────────────────────────────────────────

// Entry is one row of the GET /api/files listing.
type Entry struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	Modified    string `json:"modified"`
	ContentType string `json:"contentType"`
}

// List returns the servable files under root: regular files whose extension
// is allow-listed and whose size is within the cap, ordered by name. A
// missing/unreadable root yields an empty list (200 with []), never an
// error — the bridge shows “no files”, not a stack trace. Candidates that
// fail Resolve (escaping symlinks, races) are skipped, not surfaced.
func List(root string) []Entry {
	if strings.TrimSpace(root) == "" {
		return []Entry{}
	}
	allowed := AllowedExts()
	cap := MaxBytes()
	dir, err := os.ReadDir(root)
	if err != nil {
		return []Entry{}
	}
	out := []Entry{}
	for _, de := range dir {
		if de.IsDir() {
			continue
		}
		name := de.Name()
		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
		if !allowed[ext] {
			continue
		}
		ct, ok := ContentTypeFor(name)
		if !ok {
			continue
		}
		resolved, err := Resolve(root, name)
		if err != nil {
			continue
		}
		st, err := os.Stat(resolved)
		if err != nil || !st.Mode().IsRegular() || st.Size() > cap {
			continue
		}
		out = append(out, Entry{
			Name:        name,
			Size:        st.Size(),
			Modified:    st.ModTime().UTC().Format(time.RFC3339),
			ContentType: ct,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// ── HTTP ──────────────────────────────────────────────────────────────

func writeErr(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// HandleList serves GET /api/files: the JSON listing. The shared guard runs
// first — identical auth to every /api/* route.
func HandleList(w http.ResponseWriter, r *http.Request) {
	if apiErr := config.AssertAPIRequest(r); apiErr != nil {
		apiErr.Write(w)
		return
	}
	if limited := config.CheckRateLimit(config.BucketFilesList, time.Now()); limited != nil {
		config.WriteRateLimited(w, config.BucketFilesList)
		return
	}
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(List(Root()))
}

// HandleFile serves GET /api/files/:name: the file bytes with an inline
// disposition for viewable types. Guard first, then name validation.
func HandleFile(w http.ResponseWriter, r *http.Request, name string) {
	if apiErr := config.AssertAPIRequest(r); apiErr != nil {
		apiErr.Write(w)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeErr(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if limited := config.CheckRateLimit(config.BucketFiles, time.Now()); limited != nil {
		config.WriteRateLimited(w, config.BucketFiles)
		return
	}
	if decoded, err := url.PathUnescape(name); err == nil {
		name = decoded
	}
	// Single verified open (P2-5): the fd below is SameFile-verified against
	// the vetted resolution — a symlink swap in between fails closed.
	f, fi, err := OpenResolved(Root(), name)
	if err != nil {
		writeErr(w, resolveStatus(err), resolveMessage(err))
		return
	}
	defer f.Close()
	ct, ok := ContentTypeFor(name)
	if !ok {
		writeErr(w, http.StatusForbidden, "File type is not allowed")
		return
	}
	st := fi
	if st.Size() > MaxBytes() {
		writeErr(w, http.StatusRequestEntityTooLarge, "File exceeds the size limit")
		return
	}
	safe := strings.ReplaceAll(name, `"`, "")
	safe = strings.ReplaceAll(safe, "\r", "")
	safe = strings.ReplaceAll(safe, "\n", "")
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"; filename*=UTF-8''%s`, safe, url.PathEscape(name)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, name, st.ModTime(), f)
}

func resolveStatus(err error) int {
	if err == ErrNotFound {
		return http.StatusNotFound
	}
	if strings.Contains(err.Error(), errEscape.Error()) {
		return http.StatusForbidden
	}
	return http.StatusBadRequest
}

func resolveMessage(err error) string {
	if err == ErrNotFound {
		return "File not found"
	}
	if strings.Contains(err.Error(), errEscape.Error()) {
		return "File escapes the bridge root"
	}
	return "Invalid file name"
}
