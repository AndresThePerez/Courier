package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Every route, including the ones that answer an error and the stream route,
// because a policy that covers only the HTML is the shape of this defect.
func TestSecurityHeadersOnEveryRoute(t *testing.T) {
	want := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "no-referrer",
		"Permissions-Policy":     "camera=(), microphone=(), geolocation=()",
		"X-Frame-Options":        "DENY",
	}
	paths := []string{
		"/", "/styles.css", "/js/main.js", "/healthz", "/metrics",
		"/api/status", "/api/collections", "/api/runs",
		"/api/runs/no-such-run", "/api/runs/no-such-run/stream", "/no-such-path",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			testServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
			for k, v := range want {
				if got := rec.Header().Get(k); got != v {
					t.Errorf("%s = %q, want %q", k, got, v)
				}
			}
			csp := rec.Header().Get("Content-Security-Policy")
			if !strings.Contains(csp, "default-src 'self'") {
				t.Errorf("CSP = %q, want a default-src 'self' policy", csp)
			}
			if strings.Contains(csp, "unsafe-inline") || strings.Contains(csp, "unsafe-eval") {
				t.Errorf("CSP = %q: the frontend has no inline script, no style attribute and no eval, so no unsafe- directive belongs here", csp)
			}
			if !strings.Contains(csp, "https://static.cloudflareinsights.com") {
				t.Errorf("CSP = %q, must allow the beacon the edge injects into the page", csp)
			}
		})
	}
}
