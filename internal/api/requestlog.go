package api

import "net/http"

// withRequestID logs one line per request that arrived through the edge,
// carrying Cloudflare's own cf-ray. The edge supplies it on every request and
// nothing read it, which left an operator no way to join a visitor's report to
// a log line. The cf-ray is what makes that join possible, so every request
// that arrives through the edge logs a line, static assets and the status poll
// included. Requests without the header, meaning local and test traffic, log
// nothing.
func (s *Server) withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ray := r.Header.Get("CF-Ray"); ray != "" {
			s.log.Info("request received",
				"event", EventRequestReceived,
				"method", r.Method,
				"path", r.URL.Path,
				"cf_ray", ray)
		}
		next.ServeHTTP(w, r)
	})
}
