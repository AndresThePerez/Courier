// Command server is the single Courier binary: JSON API, SSE, PDF, and the
// embedded frontend. It only ever talks to one target, fixed at startup.
package main

import (
	"log/slog"
	"net/http"
	"os"

	"github.com/AndresThePerez/courier/internal/api"
	"github.com/AndresThePerez/courier/web"
)

func main() {
	// JSON to stdout, so `docker logs courier | jq` is the whole observability
	// story. The logger is built here and passed down explicitly rather than
	// installed as a package global: a run's log trail is part of its
	// behaviour, and behaviour that reaches through a global is behaviour a
	// test cannot pin down. See internal/runner.NewManager.
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	port := envOr("PORT", "8080")
	opts := api.Options{
		TargetURL:     envOr("TARGET_URL", "http://127.0.0.1:8081"),
		TargetDisplay: envOr("TARGET_DISPLAY", "pokesearch.andrestheperez.com"),
	}

	log.Info("courier starting",
		"event", "server_starting",
		"port", port,
		"target_url", opts.TargetURL,
		"target_display", opts.TargetDisplay)

	// Phase 4 threads this logger into api.New so the run manager and the SSE
	// broadcaster log into the same stream.
	if err := http.ListenAndServe(":"+port, api.New(web.Files, opts)); err != nil {
		log.Error("courier stopped", "event", "server_stopped", "err", err.Error())
		os.Exit(1)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
