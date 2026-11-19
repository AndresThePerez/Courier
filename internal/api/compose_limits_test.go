package api

import (
	"fmt"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The container's Go runtime is given a memory limit below the container's
// own, with room left for what the runtime does not count (the binary, thread
// stacks, the kernel's socket buffers charged to the container). A
// GOMEMLIMIT at or above mem_limit, or missing, lets the heap grow until the
// kernel kills the process instead of the collector working harder first.
func TestTheContainersGoMemoryLimitSitsBelowItsMemoryLimit(t *testing.T) {
	limit, soft := composeMemoryLimits(t)
	if soft*4 > limit*3 {
		t.Errorf("GOMEMLIMIT is %d bytes and mem_limit %d: the Go limit must leave at least a quarter of the container to what the runtime does not count", soft, limit)
	}
	if soft*2 < limit {
		t.Errorf("GOMEMLIMIT is %d bytes and mem_limit %d: under half the container, the collector would run hard long before memory is short", soft, limit)
	}
}

// composeMemoryLimits reads the container's mem_limit and its GOMEMLIMIT, in
// bytes, from docker-compose.yml.
func composeMemoryLimits(t *testing.T) (limit, soft int64) {
	t.Helper()
	raw, err := os.ReadFile("../../docker-compose.yml")
	if err != nil {
		t.Fatal(err)
	}
	compose := string(raw)
	units := map[string]int64{"k": 1 << 10, "m": 1 << 20, "g": 1 << 30, "KiB": 1 << 10, "MiB": 1 << 20, "GiB": 1 << 30}

	mem := regexp.MustCompile(`(?m)^\s+mem_limit:\s*(\d+)(k|m|g)\s*$`).FindStringSubmatch(compose)
	if mem == nil {
		t.Fatal("docker-compose.yml sets no mem_limit in k, m or g")
	}
	// Compose keeps the last of a variable set twice, so a second, larger
	// setting below the first would win unseen. The variable must be set
	// exactly once, in the list form with a literal value
	// (- GOMEMLIMIT=192MiB); any other spelling (the mapping form, a quoted
	// value, a ${GOMEMLIMIT:-...} default) fails on purpose, so the limit
	// stays readable from the file.
	if n := len(regexp.MustCompile(`(?m)^[^#\n]*\bGOMEMLIMIT\b`).FindAllString(compose, -1)); n != 1 {
		t.Fatalf("docker-compose.yml sets GOMEMLIMIT %d times, want once", n)
	}
	gomem := regexp.MustCompile(`(?m)^\s+-\s*GOMEMLIMIT=(\d+)(KiB|MiB|GiB)\s*$`).FindStringSubmatch(compose)
	if gomem == nil {
		t.Fatal("docker-compose.yml sets no GOMEMLIMIT in KiB, MiB or GiB")
	}
	size := func(m []string) int64 {
		n, err := strconv.ParseInt(m[1], 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		return n * units[m[2]]
	}
	return size(mem), size(gomem)
}

// perReadBytes is what one body read to the cap holds while it is read, about
// 380 KB (body_reads.go): io.ReadAll's buffer grows in steps, so a body of
// MaxBodyBytes sits in a buffer larger than itself.
// TestAStalledReadHoldsWhatTheBoundAssumes measures it.
const perReadBytes = 380_000

// The worst case body_reads.go and N47 state, summed from the constants: every
// place holding a body read to the cap, the gate's line full of bodies at the
// cap, and the check full of the widest bodies at the cap, each allocating
// wideDecodeBound. It must sit within the GOMEMLIMIT the container is given,
// or a change to one constant would leave the comment's sum behind unseen.
func TestTheBodyBoundsAddUpWithinTheGoMemoryLimit(t *testing.T) {
	_, soft := composeMemoryLimits(t)
	reads := int64(MaxBodyReads) * perReadBytes
	line := int64(MaxBodyWaiters) * MaxBodyBytes
	checks := int64(MaxBodyChecks) * wideDecodeBound
	if sum := reads + line + checks; sum > soft {
		t.Errorf("the reads (%d x %d), the line (%d x %d) and the checks (%d x %d) hold up to %d bytes, over the GOMEMLIMIT of %d",
			MaxBodyReads, perReadBytes, MaxBodyWaiters, MaxBodyBytes, MaxBodyChecks, wideDecodeBound, sum, soft)
	}
}

// liveHeap is the heap still in use after a full collection.
func liveHeap() int64 {
	var m runtime.MemStats
	runtime.GC()
	runtime.GC()
	runtime.ReadMemStats(&m)
	return int64(m.HeapAlloc)
}

// A read stalled one byte before the end of a body at the cap holds no more
// than perReadBytes, with a quarter to spare for what the measurement cannot
// tell apart (the connection's own buffers and goroutine). The heap is
// compared with the same server once the reads have ended.
func TestAStalledReadHoldsWhatTheBoundAssumes(t *testing.T) {
	const k = 32
	s, srv := newBodyServer(t, newTarget(t, 0), time.Minute)
	addr := srv.Listener.Addr().String()
	head := fmt.Sprintf("POST /api/send HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n", MaxBodyBytes)
	body := strings.Repeat(" ", MaxBodyBytes-1)
	conns := make([]interface{ Close() error }, 0, k)
	for range k {
		conns = append(conns, rawPost(t, addr, head, body))
	}
	waitFor(t, "every stalled body to hold a place", func() bool { return readsHeld(s) == k })
	// The reads have their bodies once the live heap stops growing: the same
	// to within 64 KiB over four readings in a row.
	held, last, still := liveHeap(), int64(0), 0
	waitFor(t, "the stalled reads to have their bodies", func() bool {
		last, held = held, liveHeap()
		if d := held - last; d < 64<<10 && d > -(64<<10) {
			still++
		} else {
			still = 0
		}
		return still >= 3
	})
	for _, c := range conns {
		_ = c.Close()
	}
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 })
	per := (held - liveHeap()) / k
	t.Logf("a stalled read holds %d bytes", per)
	if per < MaxBodyBytes/2 {
		t.Fatalf("a stalled read holds %d bytes, under half the body it has read: the measurement measured nothing", per)
	}
	if per > perReadBytes*5/4 {
		t.Errorf("a stalled read holds %d bytes, over perReadBytes (%d) with a quarter to spare", per, perReadBytes)
	}
}
