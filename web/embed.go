// Package web holds the frontend, embedded into the binary with no build step.
package web

import "embed"

// knee.svg is the pre-rendered saturation curve. It is a
// static file rather than a chart drawn at runtime: the numbers on it are a
// record of a measurement against a known corpus on known hardware, and a
// curve that redrew itself from whatever the last run happened to return would
// make the claim it is there to support unfalsifiable.
//
//go:embed index.html styles.css knee.svg js/*.js
var Files embed.FS
