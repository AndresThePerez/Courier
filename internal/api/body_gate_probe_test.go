package api

// What the tests read of the body gate. Only tests read these, so they live
// here rather than in the gate, which keeps no count for them.

// load reports the weight in the check and the weight in line.
func (g *bodyGate) load() (inside, queued int64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.inside, g.queued
}

// waiting reports how many bodies are in line.
func (g *bodyGate) waiting() int64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	return int64(len(g.line))
}
