package api

import (
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"time"
)

// DefaultPprofAddr is where profiling listens unless PPROF_ADDR says otherwise.
// The host half is not configurable in spirit: StartPprof refuses to bind
// anything that is not loopback.
const DefaultPprofAddr = "127.0.0.1:6060"

// Pprof is the profiling listener. It is a separate http.Server on its own
// loopback socket, never a route on the public mux.
//
// The reason is the same one that makes the endpoint catalog a closed set: this
// is an anonymous public demo, and /debug/pprof/ hands out heap dumps, the
// command line, and a /profile handler that will happily pin a core for thirty
// seconds on request. Reaching it should require already being on the box —
// `ssh` then `curl localhost:6060`, or `docker exec`.
type Pprof struct {
	ln  net.Listener
	srv *http.Server
}

// StartPprof binds a profiling listener and serves it in the background.
//
// It returns an error rather than binding when addr is not loopback. That
// refusal is the enforcement: a deploy that sets PPROF_ADDR=0.0.0.0:6060 —
// by habit, or by copying a compose file — fails loudly instead of quietly
// publishing the process's memory to the internet.
func StartPprof(addr string, log *slog.Logger) (*Pprof, error) {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	if err := requireLoopback(addr); err != nil {
		return nil, err
	}

	// Its own mux. Importing net/http/pprof registers these on
	// http.DefaultServeMux as a side effect, and Courier never serves that mux —
	// but registering them explicitly here means the profiling surface is a
	// visible list rather than an import's side effect.
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("pprof listen on %s: %w", addr, err)
	}
	p := &Pprof{
		ln:  ln,
		srv: &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second},
	}
	log.Info("pprof listening", "event", "pprof_listening", "addr", ln.Addr().String())
	go func() {
		if err := p.srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Error("pprof stopped", "event", "pprof_stopped", "err", err.Error())
		}
	}()
	return p, nil
}

// Addr is the address actually bound, which matters when addr asked for port 0.
func (p *Pprof) Addr() string { return p.ln.Addr().String() }

// Close stops the profiling listener.
func (p *Pprof) Close() error { return p.srv.Close() }

// requireLoopback rejects any bind address that is reachable from off the box.
//
// An empty host (":6060") is rejected too: that binds every interface, which is
// the exact mistake this guard exists to catch, and it is the shape a copied
// snippet usually has.
func requireLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("pprof address %q: %w", addr, err)
	}
	if host == "" {
		return fmt.Errorf("pprof address %q binds every interface; use %s", addr, DefaultPprofAddr)
	}
	if host == "localhost" {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("pprof address %q: host must be a loopback IP or localhost", addr)
	}
	if !ip.IsLoopback() {
		return fmt.Errorf("pprof address %q is not loopback; profiling must not be reachable off the box", addr)
	}
	return nil
}
