package api

import (
	"reflect"
	"strings"
	"testing"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

// manyObjects is a run body at the size cap made of empty requests: the most
// JSON objects a body can hold, each one a payload type the walk must look up.
func manyObjects() string {
	const prefix, suffix = `{"mode":"functional","sequence":[`, `]}`
	n := (MaxBodyBytes - len(prefix) - len(suffix) + 1) / len(`{},`)
	return prefix + strings.TrimSuffix(strings.Repeat(`{},`, n), ",") + suffix
}

// BenchmarkCheckBodyManyObjects is the shape check alone over the body that
// holds the most objects.
func BenchmarkCheckBodyManyObjects(b *testing.B) {
	body := []byte(manyObjects())
	typ := reflect.TypeOf(&sandbox.RunRequest{})
	b.SetBytes(int64(len(body)))
	b.ReportAllocs()
	for b.Loop() {
		if _, _, ok := checkBody(body, typ); !ok {
			b.Fatal("a well-formed body was refused")
		}
	}
}
