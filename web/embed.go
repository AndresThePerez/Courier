// Package web holds the frontend, embedded into the binary with no build step.
package web

import "embed"

//go:embed index.html styles.css js/*.js
var Files embed.FS
