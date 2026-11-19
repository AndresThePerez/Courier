package api

import (
	"os"
	"regexp"
	"strconv"
	"testing"
)

// The container's Go runtime is given a memory limit below the container's
// own, with room left for what the runtime does not count (the binary, thread
// stacks, the kernel's socket buffers charged to the container). A
// GOMEMLIMIT at or above mem_limit, or missing, lets the heap grow until the
// kernel kills the process instead of the collector working harder first.
func TestTheContainersGoMemoryLimitSitsBelowItsMemoryLimit(t *testing.T) {
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
	limit, soft := size(mem), size(gomem)
	if soft*4 > limit*3 {
		t.Errorf("GOMEMLIMIT is %d bytes and mem_limit %d: the Go limit must leave at least a quarter of the container to what the runtime does not count", soft, limit)
	}
	if soft*2 < limit {
		t.Errorf("GOMEMLIMIT is %d bytes and mem_limit %d: under half the container, the collector would run hard long before memory is short", soft, limit)
	}
}
