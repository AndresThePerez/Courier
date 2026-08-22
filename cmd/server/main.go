// Command server is the single Courier binary: JSON API, SSE, PDF, and the
// embedded frontend. It only ever talks to one target, fixed at startup.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/AndresThePerez/courier/internal/api"
	"github.com/AndresThePerez/courier/web"
)

// Shutdown budgets. drainTimeout is the outer one because it is the one that
// bounds real work: a 50-worker run cancelled at SIGTERM still has up to a
// 10-second client timeout of in-flight requests to finish, and those requests
// are what the report and the budget debit are made of.
const (
	drainTimeout    = 35 * time.Second
	shutdownTimeout = 10 * time.Second
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
		Logger:        log,
	}

	courier := api.New(web.Files, opts)

	// Profiling lives on its own loopback socket and is never a route on the
	// public mux. PPROF_ADDR=off disables it; anything that is not loopback is
	// refused rather than bound.
	if addr := envOr("PPROF_ADDR", api.DefaultPprofAddr); addr != "off" {
		pp, err := api.StartPprof(addr, log)
		if err != nil {
			// Not fatal: a misconfigured profiler must not take the demo down.
			log.Warn("pprof not started", "event", "pprof_refused", "addr", addr, "err", err.Error())
		} else {
			defer pp.Close()
		}
	}

	log.Info("courier starting",
		"event", "server_starting",
		"port", port,
		"target_url", opts.TargetURL,
		"target_display", opts.TargetDisplay)

	srv := &http.Server{
		Addr:    ":" + port,
		Handler: courier,
		// The only timeout an SSE server may set: a write or idle timeout would
		// cut live streams at the deadline, which is the one thing this design
		// cannot tolerate. Slow-header attacks are still bounded.
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.ListenAndServe() }()

	select {
	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("courier stopped", "event", "server_stopped", "err", err.Error())
			os.Exit(1)
		}

	case <-ctx.Done():
		stop() // a second signal kills the process rather than being swallowed
		log.Info("courier shutting down", "event", "server_shutdown")

		// Order matters. Cancelling the run first releases the SSE handlers and
		// bounds the drain by one in-flight request instead of a whole run;
		// only then can Shutdown finish, because Shutdown waits on active
		// handlers and a live stream is an active handler by design.
		drainCtx, cancelDrain := context.WithTimeout(context.Background(), drainTimeout)
		if err := courier.Close(drainCtx); err != nil {
			log.Warn("run did not drain in time", "event", "server_drain_timeout", "err", err.Error())
		}
		cancelDrain()

		shutCtx, cancelShut := context.WithTimeout(context.Background(), shutdownTimeout)
		if err := srv.Shutdown(shutCtx); err != nil {
			log.Warn("http shutdown incomplete", "event", "server_shutdown_timeout", "err", err.Error())
		}
		cancelShut()
		log.Info("courier stopped", "event", "server_stopped")
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
