package assert

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// searchBody builds a payload the shape and size of a real Pokesearch
// /api/search response: 24 cards, five facet groups, ~35-40KB. Benchmarking
// against a toy document would flatter the decode step, which is the part that
// actually costs anything.
func searchBody(tb testing.TB) []byte {
	tb.Helper()
	results := make([]map[string]any, 24)
	for i := range results {
		results[i] = map[string]any{
			"id": fmt.Sprintf("base1-%d", i+1), "name": fmt.Sprintf("Charizard %d", i),
			"supertype": "Pokémon", "subtypes": []string{"Stage 2", "EX"},
			"hp": 120 + i, "types": []string{"Fire", "Colorless"},
			"evolves_from": "Charmeleon",
			"attacks": []map[string]any{
				{"name": "Fire Spin", "cost": []string{"Fire", "Fire", "Fire", "Fire"}, "damage": "100",
					"text": "Discard 2 Energy cards attached to Charizard in order to use this attack."},
				{"name": "Slash", "cost": []string{"Colorless", "Colorless"}, "damage": "30", "text": ""},
			},
			"abilities":                []map[string]any{{"name": "Energy Burn", "type": "Poké-Power", "text": strings.Repeat("energy ", 20)}},
			"weaknesses":               []map[string]any{{"type": "Water", "value": "×2"}},
			"resistances":              []map[string]any{{"type": "Fighting", "value": "-30"}},
			"retreat_cost":             []string{"Colorless", "Colorless", "Colorless"},
			"rarity":                   "Rare Holo",
			"artist":                   "Mitsuhiro Arita",
			"flavor_text":              strings.Repeat("Spits fire hot enough to melt boulders. ", 3),
			"national_pokedex_numbers": []int{6},
			"number":                   fmt.Sprint(i + 1), "set_id": "base1", "set_name": "Base",
			"set_series": "Base", "set_total": 102, "release_date": "1999-01-09",
			"image_small": "https://images.example/base1/4.png",
			"image_large": "https://images.example/base1/4_hires.png",
		}
	}
	facet := func(n int) []map[string]any {
		out := make([]map[string]any, n)
		for i := range out {
			out[i] = map[string]any{"value": fmt.Sprintf("value-%d", i), "count": 100 - i}
		}
		return out
	}
	body, err := json.Marshal(map[string]any{
		"total": 20324, "page": 1, "pages": 400, "page_size": 24, "took_ms": 9,
		"results": results,
		"facets": map[string]any{
			"supertype": facet(3), "types": facet(11), "rarity": facet(38),
			"set_series": facet(17), "sets": facet(173),
		},
	})
	if err != nil {
		tb.Fatalf("marshal: %v", err)
	}
	return body
}

func BenchmarkLookupShallow(b *testing.B) {
	d := benchDoc(b)
	b.ReportAllocs()
	for b.Loop() {
		if _, _, err := Lookup(d, "$.total"); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkLookupDeep(b *testing.B) {
	d := benchDoc(b)
	b.ReportAllocs()
	for b.Loop() {
		if _, _, err := Lookup(d, "$.results[23].attacks[0].cost[3]"); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkLookupMiss(b *testing.B) {
	d := benchDoc(b)
	b.ReportAllocs()
	for b.Loop() {
		if _, _, err := Lookup(d, "$.results[0].nope"); err != nil {
			b.Fatal(err)
		}
	}
}

func benchDoc(b *testing.B) any {
	b.Helper()
	var v any
	if err := json.Unmarshal(searchBody(b), &v); err != nil {
		b.Fatalf("unmarshal: %v", err)
	}
	return v
}

// NewTarget is the per-response cost the executor pays before any assertion
// runs. It is the reason Target decodes once instead of once per assertion.
func BenchmarkNewTarget(b *testing.B) {
	body := searchBody(b)
	b.SetBytes(int64(len(body)))
	b.ReportAllocs()
	for b.Loop() {
		if tg := NewTarget(200, 9.5, body); tg.DecodeErr != nil {
			b.Fatal(tg.DecodeErr)
		}
	}
}

func BenchmarkEvaluate(b *testing.B) {
	tg := NewTarget(200, 9.5, searchBody(b))
	for _, tc := range []struct {
		name string
		a    Assertion
	}{
		{"status", Assertion{Type: "status", Op: "eq", Value: float64(200)}},
		{"latency", Assertion{Type: "latency", Op: "lt", Value: float64(50)}},
		{"json_gt", Assertion{Type: "json", Path: "$.total", Op: "gt", Value: float64(0)}},
		{"json_count", Assertion{Type: "json", Path: "$.facets.sets", Op: "count", Value: float64(173)}},
		{"json_contains", Assertion{Type: "json", Path: "$.results[0].name", Op: "contains", Value: "chari"}},
		{"json_exists", Assertion{Type: "json", Path: "$.results[23].abilities[0].name", Op: "exists"}},
		{"body_contains", Assertion{Type: "body_contains", Op: "contains", Value: "Mitsuhiro"}},
	} {
		b.Run(tc.name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				if out := Evaluate(tc.a, tg); out.Error != "" {
					b.Fatal(out.Error)
				}
			}
		})
	}
}

// The worst realistic case: a request carrying the full cap of 20 assertions,
// decode included. This is the number the "hot path stays lean" claim rests on.
func BenchmarkEvaluateAllAtCap(b *testing.B) {
	body := searchBody(b)
	as := make([]Assertion, 0, 20)
	as = append(as,
		Assertion{Type: "status", Op: "eq", Value: float64(200)},
		Assertion{Type: "latency", Op: "lt", Value: float64(50)},
		Assertion{Type: "body_contains", Op: "contains", Value: "results"},
		Assertion{Type: "json", Path: "$.facets.sets", Op: "count", Value: float64(173)},
	)
	for len(as) < 20 {
		i := len(as)
		as = append(as, Assertion{Type: "json", Path: fmt.Sprintf("$.results[%d].name", i), Op: "contains", Value: "Charizard"})
	}
	b.SetBytes(int64(len(body)))
	b.ReportAllocs()
	for b.Loop() {
		if _, ok := EvaluateAll(as, NewTarget(200, 9.5, body)); !ok {
			b.Fatal("assertions did not pass")
		}
	}
}
