// Tests for the P2-4 loopback throttle and the P2-5 OpenResolved hardening
// plus the rate-limit wiring on the HTTP handlers.
package files

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/alfirus/theglobe/server/internal/config"
)

// ── OpenResolved (P2-5) ─────────────────────────────────────────────

func TestOpenResolved_ServesVerifiedBytes(t *testing.T) {
	root := seedRoot(t, map[string]string{"note.txt": "verified-bytes"})
	f, fi, err := OpenResolved(root, "note.txt")
	if err != nil {
		t.Fatalf("OpenResolved = %v, want admission", err)
	}
	defer f.Close()
	if fi.Size() != int64(len("verified-bytes")) {
		t.Errorf("size = %d, want %d", fi.Size(), len("verified-bytes"))
	}
	buf := make([]byte, len("verified-bytes"))
	if _, err := f.Read(buf); err != nil || string(buf) != "verified-bytes" {
		t.Errorf("read = %q, %v — want the resolved file's bytes", buf, err)
	}
}

func TestOpenResolved_SymlinkSwapFailsClosed(t *testing.T) {
	root := seedRoot(t, map[string]string{"real.txt": "real"})
	outside := t.TempDir()
	evil := filepath.Join(outside, "evil.txt")
	if err := os.WriteFile(evil, []byte("evil"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(filepath.Join(root, "real.txt"), link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	// Swap the symlink inside the resolve→open window.
	oldHook := resolveOpenHook
	resolveOpenHook = func() {
		_ = os.Remove(link)
		_ = os.Symlink(evil, link)
	}
	defer func() { resolveOpenHook = oldHook }()

	if _, _, err := OpenResolved(root, "link.txt"); err != ErrNotFound {
		t.Errorf("OpenResolved swapped symlink = %v, want ErrNotFound", err)
	}
}

func TestOpenResolved_DirectoryFailsClosed(t *testing.T) {
	root := t.TempDir()
	if _, _, err := OpenResolved(root, "link.txt"); err != ErrNotFound {
		t.Errorf("OpenResolved missing = %v, want ErrNotFound", err)
	}
}

// ── rate-limit wiring (P2-4) ────────────────────────────────────────

func TestHandleFile_RateLimitedAfterBurst(t *testing.T) {
	config.ResetRateLimits()
	t.Cleanup(config.ResetRateLimits)
	root := seedRoot(t, map[string]string{"a.txt": "x"})
	var last *httptest.ResponseRecorder
	for i := 0; i < 130; i++ {
		last = serveFile(t, root, "a.txt", nil)
	}
	if last.Code != http.StatusTooManyRequests {
		t.Fatalf("130th-hit status = %d, want 429", last.Code)
	}
	if last.Header().Get("Retry-After") == "" {
		t.Error("429 is missing the Retry-After header")
	}
}

func TestHandleList_RateLimitedAfterBurst(t *testing.T) {
	config.ResetRateLimits()
	t.Cleanup(config.ResetRateLimits)
	root := seedRoot(t, map[string]string{"a.txt": "x"})
	t.Setenv("GLOBE_FILES_ROOT", root)
	t.Setenv("API_SERVER_KEY", "")
	var last *httptest.ResponseRecorder
	for i := 0; i < 130; i++ {
		r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8787/api/files", nil)
		w := httptest.NewRecorder()
		HandleList(w, r)
		last = w
	}
	if last.Code != http.StatusTooManyRequests {
		t.Fatalf("130th-hit status = %d, want 429", last.Code)
	}
}
