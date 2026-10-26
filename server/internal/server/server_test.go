// Tests for the Phase 1 HTTP surface: liveness, guard-before-404 ordering,
// and the secret-free logging guarantee (C4 rule — the log must never carry
// key material even when the request does).
package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func doRequest(t *testing.T, h http.Handler, method, target string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, target, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestHealthz(t *testing.T) {
	t.Setenv("API_SERVER_KEY", "")
	h := NewHandler(nil)

	w := doRequest(t, h, http.MethodGet, "http://127.0.0.1:8787/healthz", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("healthz status = %d", w.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" || body["service"] != "globe-server" {
		t.Errorf("healthz body = %v", body)
	}

	w = doRequest(t, h, http.MethodPost, "http://127.0.0.1:8787/healthz", nil)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("healthz POST status = %d, want 405", w.Code)
	}
}

func TestAPIFallback_GuardRunsBefore404(t *testing.T) {
	t.Setenv("API_SERVER_KEY", "")
	h := NewHandler(nil)

	// Admitted request, unknown route → JSON 404.
	w := doRequest(t, h, http.MethodGet, "http://localhost:5173/api/nope", nil)
	if w.Code != http.StatusNotFound {
		t.Errorf("unknown /api/* status = %d, want 404", w.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("404 body is not JSON: %v", err)
	}
	if body["error"] != "Not found" {
		t.Errorf("404 body = %v", body)
	}

	// Guard rejects before the 404: foreign origin → 403, not 404.
	w = doRequest(t, h, http.MethodGet, "http://localhost:5173/api/nope",
		map[string]string{"Origin": "https://evil.example.com"})
	if w.Code != http.StatusForbidden {
		t.Errorf("guard status = %d, want 403", w.Code)
	}
}

func TestRequestLog_NeverCarriesSecrets(t *testing.T) {
	t.Setenv("API_SERVER_KEY", "")
	var logs bytes.Buffer
	h := NewHandler(&logs)

	secret := "Bearer super-secret-value"
	w := doRequest(t, h, http.MethodGet,
		"http://localhost:5173/api/nope?apiKey=super-secret-value&token=abc",
		map[string]string{"Authorization": secret, "X-Api-Key": "super-secret-value"})
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d", w.Code)
	}

	out := logs.String()
	for _, leaked := range []string{"super-secret-value", "apiKey=super-secret-value", "token=abc", "Authorization"} {
		if strings.Contains(out, leaked) {
			t.Errorf("request log leaks %q:\n%s", leaked, out)
		}
	}
	// ...but routing metadata is present.
	for _, want := range []string{`"method":"GET"`, `"path":"/api/nope"`, `"status":404`} {
		if !strings.Contains(out, want) {
			t.Errorf("request log misses %s:\n%s", want, out)
		}
	}
	// Query string must not appear (path only).
	if strings.Contains(out, "?") {
		t.Errorf("request log must carry path only, no query:\n%s", out)
	}
}
