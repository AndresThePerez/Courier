// Package api is Courier's HTTP layer: the JSON API, the SSE stream, and the
// embedded frontend. Nothing outside this package speaks HTTP to the browser.
package api

import (
	"encoding/json"
	"io/fs"
	"net/http"
)

// Options configures a Server at startup. The target is fixed here and can
// never be influenced by a client request.
type Options struct {
	TargetURL     string // internal base URL requests actually execute against
	TargetDisplay string // friendly name shown in the UI and PDF
}

// Server is Courier's http.Handler.
type Server struct {
	mux  *http.ServeMux
	opts Options
}

// New builds a Server that serves static from the given filesystem.
func New(static fs.FS, opts Options) *Server {
	s := &Server{mux: http.NewServeMux(), opts: opts}
	s.mux.HandleFunc("GET /healthz", s.handleHealthz)
	s.mux.Handle("GET /", http.FileServerFS(static))
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}
