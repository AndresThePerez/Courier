// Package assert holds Courier's declarative assertion model: a deliberately
// tiny JSON-path subset (dot fields + array indexes) and a pure evaluator.
// No JSONPath library, no filters, no wildcards — nothing to sandbox.
package assert

import (
	"fmt"
	"strconv"
	"strings"
)

// segment is one step of a parsed path: either a field name or an array index.
type segment struct {
	field   string
	index   int
	isIndex bool
}

// parsePath validates a path and splits it into segments. Parsing is entirely
// independent of any document, which is what lets ValidateAssertion reject a
// malformed path before a response exists. The grammar is exactly:
//
//	path    = "$" *( "." field | "[" int "]" )
//	field   = 1*( any char except "." and "[" )
//
// A negative index parses cleanly; it simply resolves to nothing at lookup
// time, because "out of range" is a miss, not a malformed path.
func parsePath(path string) ([]segment, error) {
	if path != "$" && !strings.HasPrefix(path, "$.") && !strings.HasPrefix(path, "$[") {
		return nil, fmt.Errorf("path must start with $: %q", path)
	}
	var segs []segment
	rest := path[1:]
	for rest != "" {
		switch rest[0] {
		case '.':
			rest = rest[1:]
			end := strings.IndexAny(rest, ".[")
			if end < 0 {
				end = len(rest)
			}
			field := rest[:end]
			if field == "" {
				return nil, fmt.Errorf("empty field name in %q", path)
			}
			segs = append(segs, segment{field: field})
			rest = rest[end:]
		case '[':
			closing := strings.IndexByte(rest, ']')
			if closing < 0 {
				return nil, fmt.Errorf("unclosed [ in %q", path)
			}
			idx, err := strconv.Atoi(rest[1:closing])
			if err != nil {
				return nil, fmt.Errorf("bad array index in %q", path)
			}
			segs = append(segs, segment{index: idx, isIndex: true})
			rest = rest[closing+1:]
		default:
			return nil, fmt.Errorf("unexpected %q in %q", rest[0], path)
		}
	}
	return segs, nil
}

// ValidatePath reports whether path is syntactically well-formed.
func ValidatePath(path string) error {
	_, err := parsePath(path)
	return err
}

// Lookup walks a decoded JSON document (the result of json.Unmarshal into any).
// found=false means the path is valid but resolves to nothing; err != nil means
// the path itself is malformed. An explicit JSON null is found with a nil value,
// which is why the two are reported separately.
func Lookup(doc any, path string) (any, bool, error) {
	segs, err := parsePath(path)
	if err != nil {
		return nil, false, err
	}
	cur := doc
	for _, s := range segs {
		if s.isIndex {
			arr, ok := cur.([]any)
			if !ok {
				return nil, false, nil
			}
			if s.index < 0 || s.index >= len(arr) {
				return nil, false, nil
			}
			cur = arr[s.index]
			continue
		}
		obj, ok := cur.(map[string]any)
		if !ok {
			return nil, false, nil
		}
		v, ok := obj[s.field]
		if !ok {
			return nil, false, nil
		}
		cur = v
	}
	return cur, true, nil
}
