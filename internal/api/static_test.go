package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

// etagStatic is a fixture of its own rather than server_test.go's testStatic,
// which carries index.html alone. A validator test needs more than one file:
// with a single asset a constant tag would satisfy every assertion here. The
// three names match the ones web/embed.go actually embeds, and the bytes are
// deliberately distinct so the hashes have to differ.
func etagStatic() fstest.MapFS {
	return fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>courier</html>")},
		"styles.css": &fstest.MapFile{Data: []byte("body{background:#101214}")},
		"knee.svg":   &fstest.MapFile{Data: []byte("<svg viewBox=\"0 0 10 10\"></svg>")},
	}
}

func etagServer(t *testing.T) *Server {
	t.Helper()
	return New(etagStatic(), Options{TargetURL: "http://127.0.0.1:8081", TargetDisplay: "pokesearch.andrestheperez.com"})
}

func TestEmbeddedAssetsCarryAStrongETag(t *testing.T) {
	srv := etagServer(t)
	for _, path := range []string{"/", "/styles.css"} {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		tag := rec.Header().Get("ETag")
		if tag == "" {
			t.Fatalf("%s carries no ETag", path)
		}
		if tag[0] != '"' {
			t.Errorf("%s ETag = %q, want a strong quoted tag and not a W/ prefix", path, tag)
		}

		again := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("If-None-Match", tag)
		srv.ServeHTTP(again, req)
		if again.Code != http.StatusNotModified {
			t.Errorf("%s with a matching If-None-Match = %d, want 304", path, again.Code)
		}
	}
}

// Different bytes, different validator. Without this the tag could be a
// constant and every assertion above would still pass.
func TestETagsDifferBetweenAssets(t *testing.T) {
	srv := etagServer(t)
	seen := make(map[string]string)
	for _, path := range []string{"/", "/styles.css", "/knee.svg"} {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		tag := rec.Header().Get("ETag")
		if other, clash := seen[tag]; clash {
			t.Errorf("%s and %s share the ETag %s", path, other, tag)
		}
		seen[tag] = path
	}
}
