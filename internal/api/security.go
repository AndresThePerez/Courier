package api

import "net/http"

// The policy is strict because the frontend earns it: there is no inline
// script, no style element, no style attribute, no inline handler, no
// innerHTML and no eval anywhere in web/, so neither 'unsafe-inline' nor
// 'unsafe-eval' is needed. Two renderers assign element.style.width from
// script, which looks like it needs 'unsafe-inline' and does not: CSP governs
// style elements and style attributes parsed from markup, never CSSOM
// mutation. Do not weaken style-src for those two lines.
//
// static.cloudflareinsights.com is the one external origin, because the edge
// injects its own analytics beacon into the page and a self-only script-src
// blocks it. Keeping the policy here rather than in an edge rule is the point:
// it is reviewed beside the HTML it has to allow.
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self' https://static.cloudflareinsights.com; " +
	"style-src 'self'; " +
	"img-src 'self' data:; " +
	"connect-src 'self' https://cloudflareinsights.com; " +
	"object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// secureHeaders sets the response policy on every route, the event stream
// included. A header set that stops at the HTML is a header set a reviewer
// checks and finds missing.
func secureHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		// frame-ancestors in the CSP is the modern control; X-Frame-Options is
		// the one older clients still read, and the two agree.
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}
