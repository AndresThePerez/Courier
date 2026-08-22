package assert

import (
	"encoding/json"
	"testing"
)

const sample = `{
  "total": 42,
  "page": 1,
  "results": [
    {"name": "Charizard", "hp": 120, "types": ["Fire"]},
    {"name": "Alakazam", "hp": null}
  ],
  "facets": {"types": [{"value": "Fire", "count": 7}]}
}`

func doc(t *testing.T) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(sample), &v); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return v
}

func TestLookup(t *testing.T) {
	tests := []struct {
		name  string
		path  string
		want  any
		found bool
	}{
		{"root object", "$", nil, true},
		{"top-level number", "$.total", float64(42), true},
		{"array element field", "$.results[0].name", "Charizard", true},
		{"nested array", "$.results[0].types[0]", "Fire", true},
		{"nested object", "$.facets.types[0].count", float64(7), true},
		{"whole array", "$.results", nil, true},
		{"explicit null is present", "$.results[1].hp", nil, true},
		{"missing field", "$.nope", nil, false},
		{"missing nested field", "$.results[0].nope", nil, false},
		{"index out of range", "$.results[9]", nil, false},
		{"negative index", "$.results[-1]", nil, false},
		{"field on non-object", "$.total.nope", nil, false},
		{"index into non-array", "$.total[0]", nil, false},
	}
	d := doc(t)
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, found, err := Lookup(d, tc.path)
			if err != nil {
				t.Fatalf("Lookup(%q) error: %v", tc.path, err)
			}
			if found != tc.found {
				t.Fatalf("found = %v, want %v", found, tc.found)
			}
			if tc.want != nil && got != tc.want {
				t.Errorf("value = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestLookupPathErrors(t *testing.T) {
	for _, path := range []string{"", "results", "$results", "$.", "$..name", "$.results[", "$.results[a]", "$.results[]", "$[0]x"} {
		if _, _, err := Lookup(doc(t), path); err == nil {
			t.Errorf("Lookup(%q) = nil error, want a path error", path)
		}
	}
}

// A top-level array is a legitimate document shape: $[0] must resolve.
func TestLookupTopLevelArray(t *testing.T) {
	var arr any
	if err := json.Unmarshal([]byte(`[{"name":"Charizard"},{"name":"Alakazam"}]`), &arr); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got, found, err := Lookup(arr, "$[1].name")
	if err != nil || !found || got != "Alakazam" {
		t.Errorf("Lookup($[1].name) = %#v/%v/%v, want Alakazam/true/nil", got, found, err)
	}
}

// Path syntax is validated independently of the document, which is what lets
// ValidateAssertion reject a malformed path with no response in hand.
func TestLookupValidatesSyntaxAgainstNilDoc(t *testing.T) {
	if _, found, err := Lookup(nil, "$.total"); err != nil || found {
		t.Errorf("valid path on nil doc = found %v err %v, want false/nil", found, err)
	}
	if _, _, err := Lookup(nil, "$.results["); err == nil {
		t.Error("malformed path on nil doc must still report a path error")
	}
}
