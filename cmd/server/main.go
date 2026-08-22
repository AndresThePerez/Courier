// Command server is the single Courier binary: JSON API, SSE, PDF, and the
// embedded frontend. It only ever talks to one target, fixed at startup.
package main

import (
	"log"
	"net/http"
	"os"

	"github.com/AndresThePerez/courier/internal/api"
	"github.com/AndresThePerez/courier/web"
)

func main() {
	port := envOr("PORT", "8080")
	opts := api.Options{
		TargetURL:     envOr("TARGET_URL", "http://127.0.0.1:8085"),
		TargetDisplay: envOr("TARGET_DISPLAY", "pokesearch.andrestheperez.com"),
	}
	log.Printf("courier listening on :%s (target %s)", port, opts.TargetURL)
	log.Fatal(http.ListenAndServe(":"+port, api.New(web.Files, opts)))
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
