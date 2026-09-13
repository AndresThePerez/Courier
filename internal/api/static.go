package api

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"net/http"
	"strings"
)

// staticHandler serves the embedded UI with a content-derived ETag.
//
// embed.FS file mod times are the zero time, so http.ServeContent writes no
// Last-Modified and computes no ETag, which leaves every cache in the path
// with nothing but its own fill timestamp to revalidate against: two assets
// from one build can carry validators minutes apart, and a redeploy can be
// served stale with no content-based way to notice.
//
// The hash is computed here, at startup, over the embedded bytes. A
// content-hashed filename scheme would be the other answer and it would import
// a build step, which this project does not have and is not getting.
type staticHandler struct {
	files http.Handler
	etags map[string]string
}

func newStaticHandler(f fs.FS) *staticHandler {
	tags := make(map[string]string)
	_ = fs.WalkDir(f, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		b, rerr := fs.ReadFile(f, p)
		if rerr != nil {
			return nil
		}
		sum := sha256.Sum256(b)
		// Twelve bytes is plenty for a cache validator and keeps the header
		// short. Strong rather than weak: the bytes are the bytes.
		tags["/"+p] = `"` + hex.EncodeToString(sum[:12]) + `"`
		return nil
	})
	return &staticHandler{files: http.FileServerFS(f), etags: tags}
}

func (h *staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if p == "/" {
		p = "/index.html"
	}
	if tag, ok := h.etags[p]; ok {
		w.Header().Set("ETag", tag)
		if etagMatches(r.Header.Get("If-None-Match"), tag) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	h.files.ServeHTTP(w, r)
}

// etagMatches handles the two forms a client actually sends: a single tag, and
// a comma-separated list. A bare "*" matches anything that exists.
func etagMatches(header, tag string) bool {
	if header == "" {
		return false
	}
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || candidate == tag {
			return true
		}
	}
	return false
}
