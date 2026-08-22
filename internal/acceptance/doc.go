// Package acceptance holds Courier's end-to-end acceptance matrix.
//
// Every test file in this package carries the `acceptance` build tag, because
// the matrix drives a *running* Courier over HTTP against a *running* target —
// it is not part of `go test ./...` and must never be, or a checkout with no
// target would fail its own unit suite.
//
// Run it with:
//
//	PORT=8084 TARGET_URL=http://127.0.0.1:8081 PPROF_ADDR=off go run ./cmd/server &
//	go test -tags acceptance ./internal/acceptance/ -v -timeout 20m
//
// See acceptance_test.go for the environment variables and for which items
// need the second, stub-backed Courier instance.
//
// This file carries no build tag on purpose: without it the directory has no
// buildable Go files and `go vet ./...` reports the package as broken.
package acceptance
