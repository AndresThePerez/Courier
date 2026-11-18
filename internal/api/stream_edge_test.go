package api

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/runner"
	"github.com/AndresThePerez/courier/internal/sse"
)

// gatedBus is the broadcaster whose Reset waits for the test, which holds a
// run in the window between being registered (visible on /api/status and
// /api/runs/{id}) and the broadcaster describing it.
type gatedBus struct {
	*sse.Broadcaster
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (g *gatedBus) Reset(id string) {
	g.once.Do(func() { close(g.entered) })
	<-g.release
	g.Broadcaster.Reset(id)
}

// A run is registered a moment before the broadcaster is reset to it. A viewer
// that opens the stream in that gap is watching a run that is still running:
// it must be kept waiting for its events, not told the run is finished.
func TestStreamOfARunNotYetAnnouncedIsNotEndedEarly(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	gate := &gatedBus{Broadcaster: s.bus, entered: make(chan struct{}), release: make(chan struct{})}
	s.mgr = runner.NewManagerAt(s.ex, "test-target", gate, nil, nil)
	srv := httptest.NewServer(s)
	defer srv.Close()
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(gate.release) }) }
	defer release()

	started := make(chan struct{})
	go func() {
		defer close(started)
		if _, err := s.mgr.Start(s.runCtx, payload(2, 100)); err != nil {
			t.Errorf("start: %v", err)
		}
	}()
	select {
	case <-gate.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the manager never reached Reset")
	}
	id := s.mgr.Status().RunID
	if id == "" {
		t.Fatal("no run registered in the gap")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/runs/"+id+"/stream", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	defer resp.Body.Close()

	type outcome struct {
		finishedEarly bool
		status        string
	}
	got := make(chan outcome, 1)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
		var ev string
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				ev = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: ") && ev == runner.EventRunFinished:
				var env struct {
					Data struct {
						Status string `json:"status"`
					} `json:"data"`
				}
				_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &env)
				got <- outcome{true, env.Data.Status}
				return
			}
		}
		got <- outcome{}
	}()

	// Give the handler time to act on what it saw, then let the run proceed.
	select {
	case o := <-got:
		if o.finishedEarly && o.status == "running" {
			t.Errorf("stream ended a still-running run with run_finished status %q", o.status)
		}
	case <-time.After(750 * time.Millisecond):
	}
	release()
	<-started
	waitIdle(t, s)
}

// Whatever a client puts in Last-Event-ID, a finished run's stream replays
// something sensible, ends with run_finished and a retry: line, never hangs,
// and never carries another run's events.
func TestLastEventIDAbuseAlwaysEndsCleanlyAndStaysInTheRun(t *testing.T) {
	c := &clock{}
	s := newServer(t, newTarget(t, 0), c)
	srv := httptest.NewServer(s)
	defer srv.Close()

	first := startRun(t, s, payload(2, 0))
	waitIdle(t, s)
	c.advance(10 * time.Second)
	second := startRun(t, s, payload(3, 0))
	waitIdle(t, s)

	values := []string{
		"", "0", "1", "-1", "+2", "1.5", "1e3", "0x2", " 2 ", "abc", "٣",
		"9223372036854775807", "9223372036854775808", "18446744073709551615",
		"18446744073709551616", strings.Repeat("9", 4096), strings.Repeat("1", 60000),
		"2, 3", "2\t",
	}
	for _, runID := range []string{first, second} {
		for _, v := range values {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/runs/"+runID+"/stream", nil)
			req.Header.Set("Last-Event-ID", v)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				cancel()
				t.Fatalf("run %s Last-Event-ID %.20q: %v", runID, v, err)
			}
			var names, lines []string
			sc := bufio.NewScanner(resp.Body)
			sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
			for sc.Scan() {
				l := sc.Text()
				lines = append(lines, l)
				switch {
				case strings.HasPrefix(l, "event: "):
					names = append(names, strings.TrimPrefix(l, "event: "))
				case strings.HasPrefix(l, "data: "):
					var env struct {
						RunID string `json:"run_id"`
					}
					_ = json.Unmarshal([]byte(strings.TrimPrefix(l, "data: ")), &env)
					if env.RunID != runID {
						t.Errorf("run %s Last-Event-ID %.20q: replayed an event of run %q", runID, v, env.RunID)
					}
				}
			}
			resp.Body.Close()
			if ctx.Err() != nil {
				t.Errorf("run %s Last-Event-ID %.20q: the stream hung", runID, v)
			}
			cancel()
			if resp.StatusCode != http.StatusOK {
				t.Errorf("run %s Last-Event-ID %.20q: status %d", runID, v, resp.StatusCode)
				continue
			}
			if len(names) == 0 || names[len(names)-1] != runner.EventRunFinished {
				t.Errorf("run %s Last-Event-ID %.20q: events %v do not end with run_finished", runID, v, names)
			}
			var tail []string
			for _, l := range lines[max(0, len(lines)-3):] {
				if l != "" {
					tail = append(tail, l)
				}
			}
			if len(tail) == 0 || !strings.HasPrefix(tail[len(tail)-1], "retry: ") {
				t.Errorf("run %s Last-Event-ID %.20q: the last field is %q, want retry:", runID, v, tail)
			}
		}
	}
}

// Every frame is exactly id, event, data and a blank line; the data is one
// line of JSON that does not repeat the id; nothing but the retry: line comes
// after run_finished.
func TestStreamFrameFormatIsStrictSSE(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	srv := httptest.NewServer(s)
	defer srv.Close()

	id := startRun(t, s, payload(3, 0))
	waitIdle(t, s)

	resp, err := http.Get(srv.URL + "/api/runs/" + id + "/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var raw strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		raw.Write(buf[:n])
		if err != nil {
			break
		}
	}
	body := raw.String()
	if strings.Contains(body, "\r") {
		t.Errorf("stream carries a carriage return: %q", body)
	}
	blocks := strings.Split(strings.TrimSuffix(body, "\n\n"), "\n\n")
	if len(blocks) < 3 {
		t.Fatalf("stream = %q", body)
	}
	last := blocks[len(blocks)-1]
	if !strings.HasPrefix(last, "retry: ") || strings.Contains(last, "\n") {
		t.Errorf("final block = %q, want the single retry: line", last)
	}
	for i, blk := range blocks[:len(blocks)-1] {
		lines := strings.Split(blk, "\n")
		if len(lines) != 3 || !strings.HasPrefix(lines[0], "id: ") ||
			!strings.HasPrefix(lines[1], "event: ") || !strings.HasPrefix(lines[2], "data: ") {
			t.Errorf("block %d is not id/event/data: %q", i, blk)
			continue
		}
		var env map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(lines[2], "data: ")), &env); err != nil {
			t.Errorf("block %d data is not JSON: %v", i, err)
		}
		if _, ok := env["id"]; ok {
			t.Errorf("block %d envelope repeats the id: %v", i, env)
		}
	}
}

// A viewer that hangs up mid-run gives its slot back while the run carries on,
// and a stream to the finished run, opened and dropped in a loop, leaves no
// subscriber behind.
func TestDisconnectedViewersReleaseTheirSlots(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	srv := httptest.NewServer(s)
	defer srv.Close()

	id := startRun(t, s, payload(4, 400))
	var cancels []context.CancelFunc
	for range 10 {
		ctx, cancel := context.WithCancel(context.Background())
		cancels = append(cancels, cancel)
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/runs/"+id+"/stream", nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("open stream: %v", err)
		}
		defer resp.Body.Close()
	}
	if n := s.bus.Subscribers(); n != 10 {
		t.Fatalf("subscribers = %d, want 10", n)
	}
	if !s.mgr.Status().Running {
		t.Fatal("the run ended before the viewers hung up; the test proves nothing")
	}
	for _, cancel := range cancels {
		cancel()
	}
	waitFor(t, "hung-up viewers to release their slots", func() bool { return s.bus.Subscribers() == 0 })
	waitIdle(t, s)

	for range 50 {
		got := framesWithIDs(t, srv.URL, id, "")
		if len(got) == 0 || got[len(got)-1].name != runner.EventRunFinished {
			t.Fatalf("finished run's stream = %+v", got)
		}
	}
	waitFor(t, "finished-run streams to leave no subscriber", func() bool { return s.bus.Subscribers() == 0 })
}
