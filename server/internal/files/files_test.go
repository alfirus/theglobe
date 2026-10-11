// Tests for the Phase 1b Desktop-file bridge: name sanitisation, symlink
// containment, allow-list + size-cap enforcement, guard-before-serve
// ordering, and the listing contract.
package files

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func seedRoot(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func serveFile(t *testing.T, root, name string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	t.Setenv("GLOBE_FILES_ROOT", root)
	t.Setenv("GLOBE_FILES_EXT", "")
	t.Setenv("GLOBE_FILES_MAX_BYTES", "")
	r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8787/api/files/"+name, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	HandleFile(w, r, name)
	return w
}

// ── Resolve: traversal ────────────────────────────────────────────────

func TestResolve_RejectsTraversal(t *testing.T) {
	root := seedRoot(t, map[string]string{"ok.txt": "hi"})
	for _, name := range []string{
		"..", ".", "../secret.txt", "a/b.txt", `a\b.txt`,
		"/etc/passwd", `C:\Windows\a.txt`, "C:evil.txt", "a:stream.txt",
		"", "   ", "trailing. ", "trailing..", "a/../b.txt",
	} {
		if _, err := Resolve(root, name); err == nil {
			t.Errorf("Resolve(%q) admitted, want rejection", name)
		}
	}
	if _, err := Resolve(root, "ok.txt"); err != nil {
		t.Errorf("Resolve(ok.txt) = %v, want admission", err)
	}
}

func TestResolve_MissingIsNotFound(t *testing.T) {
	root := seedRoot(t, nil)
	if _, err := Resolve(root, "nope.txt"); err != ErrNotFound {
		t.Errorf("Resolve(missing) = %v, want ErrNotFound", err)
	}
}

func TestResolve_RejectsDirectories(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(root, "sub"); err != ErrNotFound {
		t.Errorf("Resolve(dir) = %v, want ErrNotFound", err)
	}
}

// ── Resolve: symlinks ─────────────────────────────────────────────────

func TestResolve_RejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(root, "link.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := Resolve(root, "link.txt"); err == nil {
		t.Error("Resolve escaping symlink admitted, want rejection")
	} else if got := serveFile(t, root, "link.txt", nil); got.Code != http.StatusForbidden {
		t.Errorf("escaping symlink status = %d, want 403", got.Code)
	}
}

func TestResolve_AllowsSymlinkInsideRoot(t *testing.T) {
	root := seedRoot(t, map[string]string{"real.txt": "inside"})
	if err := os.Symlink(filepath.Join(root, "real.txt"), filepath.Join(root, "alias.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := Resolve(root, "alias.txt"); err != nil {
		t.Errorf("Resolve inside symlink = %v, want admission", err)
	}
}

// ── env knobs ─────────────────────────────────────────────────────────

func TestMaxBytes_FallsBackClosed(t *testing.T) {
	for _, v := range []string{"", "garbage", "0", "-5"} {
		t.Setenv("GLOBE_FILES_MAX_BYTES", v)
		if got := MaxBytes(); got != DefaultMaxBytes {
			t.Errorf("GLOBE_FILES_MAX_BYTES=%q → %d, want %d", v, got, DefaultMaxBytes)
		}
	}
	t.Setenv("GLOBE_FILES_MAX_BYTES", "1024")
	if got := MaxBytes(); got != 1024 {
		t.Errorf("GLOBE_FILES_MAX_BYTES=1024 → %d", got)
	}
}

func TestAllowedExts_Parsing(t *testing.T) {
	t.Setenv("GLOBE_FILES_EXT", "PDF, .md ,,txt")
	allowed := AllowedExts()
	for _, e := range []string{"pdf", "md", "txt"} {
		if !allowed[e] {
			t.Errorf("ext %q not allowed, want allowed", e)
		}
	}
	if allowed["exe"] {
		t.Error("exe allowed, want denied")
	}
}

// ── serve: allow-list + cap + headers ─────────────────────────────────

func TestHandleFile_ServesWithInlineDisposition(t *testing.T) {
	root := seedRoot(t, map[string]string{"hello.txt": "bridge bytes"})
	t.Setenv("API_SERVER_KEY", "")
	w := serveFile(t, root, "hello.txt", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/plain; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
	if d := w.Header().Get("Content-Disposition"); !strings.HasPrefix(d, "inline;") {
		t.Errorf("Content-Disposition = %q, want inline", d)
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("missing X-Content-Type-Options: nosniff")
	}
	if strings.TrimSpace(w.Body.String()) != "bridge bytes" {
		t.Errorf("body = %q", w.Body.String())
	}
}

func TestHandleFile_SvgServedAsText(t *testing.T) {
	root := seedRoot(t, map[string]string{"pic.svg": "<svg></svg>"})
	t.Setenv("API_SERVER_KEY", "")
	w := serveFile(t, root, "pic.svg", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/plain; charset=utf-8" {
		t.Errorf("svg Content-Type = %q, want text/plain (no script execution)", ct)
	}
}

func TestHandleFile_RejectsDisallowedType(t *testing.T) {
	root := seedRoot(t, map[string]string{"run.exe": "MZ"})
	t.Setenv("API_SERVER_KEY", "")
	if w := serveFile(t, root, "run.exe", nil); w.Code != http.StatusForbidden {
		t.Errorf("exe status = %d, want 403", w.Code)
	}
}

func TestHandleFile_RejectsOverCap(t *testing.T) {
	root := seedRoot(t, map[string]string{"big.txt": strings.Repeat("x", 2048)})
	t.Setenv("API_SERVER_KEY", "")
	t.Setenv("GLOBE_FILES_ROOT", root)
	t.Setenv("GLOBE_FILES_MAX_BYTES", "1024")
	r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8787/api/files/big.txt", nil)
	w := httptest.NewRecorder()
	HandleFile(w, r, "big.txt")
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversize status = %d, want 413", w.Code)
	}
}

func TestHandleFile_TraversalIs400(t *testing.T) {
	root := seedRoot(t, nil)
	t.Setenv("API_SERVER_KEY", "")
	if w := serveFile(t, root, "../secret.txt", nil); w.Code != http.StatusBadRequest {
		t.Errorf("traversal status = %d, want 400", w.Code)
	}
}

func TestHandleFile_MethodNotAllowed(t *testing.T) {
	root := seedRoot(t, map[string]string{"a.txt": "x"})
	t.Setenv("GLOBE_FILES_ROOT", root)
	t.Setenv("API_SERVER_KEY", "")
	r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8787/api/files/a.txt", nil)
	w := httptest.NewRecorder()
	HandleFile(w, r, "a.txt")
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST status = %d, want 405", w.Code)
	}
}

// ── guard ordering: identical auth to /api/* ──────────────────────────

func TestFiles_GuardRunsBeforeServe(t *testing.T) {
	root := seedRoot(t, map[string]string{"a.txt": "x"})
	t.Setenv("GLOBE_FILES_ROOT", root)
	t.Setenv("API_SERVER_KEY", "shared-secret")

	// Off-loopback without the secret → 401, even for a real file.
	r := httptest.NewRequest(http.MethodGet, "http://10.9.9.9:8787/api/files/a.txt", nil)
	w := httptest.NewRecorder()
	HandleFile(w, r, "a.txt")
	if w.Code != http.StatusUnauthorized {
		t.Errorf("off-loopback no-key status = %d, want 401", w.Code)
	}

	// Same request with the secret → through to the file.
	r = httptest.NewRequest(http.MethodGet, "http://10.9.9.9:8787/api/files/a.txt", nil)
	r.Header.Set("X-API-Key", "shared-secret")
	w = httptest.NewRecorder()
	HandleFile(w, r, "a.txt")
	if w.Code != http.StatusOK {
		t.Errorf("off-loopback with-key status = %d, want 200", w.Code)
	}

	// Foreign origin → 403 before any file logic.
	r = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8787/api/files", nil)
	r.Header.Set("Origin", "https://evil.example.com")
	w = httptest.NewRecorder()
	HandleList(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("foreign-origin list status = %d, want 403", w.Code)
	}
}

// ── listing ───────────────────────────────────────────────────────────

func TestHandleList_OnlyServableFiles(t *testing.T) {
	root := seedRoot(t, map[string]string{
		"a.txt":   "ok",
		"b.pdf":   "%PDF",
		"run.exe": "MZ",
		"noext":   "x",
	})
	t.Setenv("GLOBE_FILES_ROOT", root)
	t.Setenv("API_SERVER_KEY", "")
	r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8787/api/files", nil)
	w := httptest.NewRecorder()
	HandleList(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200", w.Code)
	}
	var got []Entry
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, e := range got {
		names = append(names, e.Name)
		if e.Size <= 0 || e.Modified == "" || e.ContentType == "" {
			t.Errorf("entry %+v missing size/modified/contentType", e)
		}
	}
	if len(got) != 2 || names[0] != "a.txt" || names[1] != "b.pdf" {
		t.Errorf("listing = %v, want [a.txt b.pdf]", names)
	}
}

func TestHandleList_MissingRootIsEmpty(t *testing.T) {
	t.Setenv("GLOBE_FILES_ROOT", filepath.Join(t.TempDir(), "no-such-dir"))
	t.Setenv("API_SERVER_KEY", "")
	r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8787/api/files", nil)
	w := httptest.NewRecorder()
	HandleList(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if strings.TrimSpace(w.Body.String()) != "[]" {
		t.Errorf("body = %q, want []", w.Body.String())
	}
}
