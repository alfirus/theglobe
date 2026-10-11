// Package server wires the globe-server HTTP surface (ADR-0002 Phase 1).
//
// Phase 1 owns NO /api/* route implementations — the seven SvelteKit routes
// stay the default until Phase 3. What this package does own:
//   - GET /healthz: process liveness (outside /api/*, so Phase 2's ports
//     cannot collide with it);
//   - the assertApiRequest guard on every /api/* path (unknown paths get the
//     guard first, then a JSON 404 — proving the middleware order Phase 2
//     will rely on);
//   - secret-free request logging (method, path, status, bytes, wall ms —
//     never headers, query strings or bodies).
package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/alfirus/theglobe/server/internal/config"
	"github.com/alfirus/theglobe/server/internal/files"
)

// Handler is the globe-server HTTP handler: logging middleware outside the
// guard, guard outside the mux.
type Handler struct {
	mux *http.ServeMux
	out io.Writer
}

// NewHandler builds the Phase 1 handler. out receives request log lines;
// nil writes to stderr.
func NewHandler(out io.Writer) *Handler {
	if out == nil {
		out = os.Stderr
	}
	h := &Handler{mux: http.NewServeMux(), out: out}
	h.mux.HandleFunc("/healthz", h.handleHealthz)
	// Phase 1b: the Desktop-file bridge. Exact path serves the listing;
	// the subtree serves one file per name. Both run the shared guard
	// first (files.HandleList/HandleFile call AssertAPIRequest), so auth
	// is identical to every other /api/* route.
	h.mux.HandleFunc("/api/files", files.HandleList)
	h.mux.HandleFunc("/api/files/", h.handleFile)
	// Phase 1 has no other /api/* implementations. Every remaining /api/*
	// the guard (rule parity from day one) and then gets a JSON 404 — Phase 2
	// replaces this subtree route by route.
	h.mux.HandleFunc("/api/", h.handleAPIFallback)
	return h
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (h *Handler) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"service": "globe-server", "status": "ok"})
}

// handleFile serves GET /api/files/:name. A bare trailing "/api/files/"
// (empty name) is treated as the listing for convenience.
func (h *Handler) handleFile(w http.ResponseWriter, r *http.Request) {
	name, _ := strings.CutPrefix(r.URL.Path, "/api/files/")
	if name == "" {
		files.HandleList(w, r)
		return
	}
	files.HandleFile(w, r, name)
}

func (h *Handler) handleAPIFallback(w http.ResponseWriter, r *http.Request) {
	if apiErr := config.AssertAPIRequest(r); apiErr != nil {
		apiErr.Write(w)
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]string{"error": "Not found"})
}

// statusRecorder captures the status code and byte count for logging.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

// ServeHTTP applies secret-free request logging around the mux. The log
// record carries routing metadata only: method, path (never the query
// string), status, bytes, wall-clock ms. Headers and bodies are never read
// here, so key material cannot leak through this path by construction.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	rec := &statusRecorder{ResponseWriter: w}
	h.mux.ServeHTTP(rec, r)
	if rec.status == 0 {
		rec.status = http.StatusOK
	}
	record := map[string]any{
		"ts":     start.UTC().Format(time.RFC3339Nano),
		"scope":  "http",
		"event":  "http_request",
		"level":  "info",
		"method": r.Method,
		"path":   r.URL.Path,
		"status": rec.status,
		"bytes":  rec.bytes,
		"ms":     time.Since(start).Milliseconds(),
	}
	data, err := json.Marshal(record)
	if err != nil {
		fmt.Fprintln(h.out, "[glob] http_request {\"logEncodeError\":true}")
		return
	}
	fmt.Fprintf(h.out, "[glob] http_request %s\n", data)
}
