package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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

// Only the embedded files are served. A directory is not a file, so it is a
// 404 and never a listing of the scripts inside it.
func TestDirectoriesAreNotListed(t *testing.T) {
	files := etagStatic()
	files["js/main.js"] = &fstest.MapFile{Data: []byte("import './api.js';")}
	files["js/api.js"] = &fstest.MapFile{Data: []byte("export {};")}
	srv := New(files, Options{TargetURL: "http://127.0.0.1:8081", TargetDisplay: "test-target"})

	for _, path := range []string{"/js/", "/js"} {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", path, rec.Code)
		}
		if body := rec.Body.String(); strings.Contains(body, "main.js") || strings.Contains(body, "api.js") {
			t.Errorf("GET %s lists files: %q", path, body)
		}
		if rec.Header().Get("Content-Security-Policy") == "" || rec.Header().Get("ETag") != "" {
			t.Errorf("GET %s headers = %v, want the security headers and no ETag", path, rec.Header())
		}
	}

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/js/main.js", nil))
	tag := rec.Header().Get("ETag")
	if rec.Code != http.StatusOK || tag == "" || rec.Body.String() != "import './api.js';" {
		t.Fatalf("GET /js/main.js = %d, ETag %q, body %q; want the file with its tag", rec.Code, tag, rec.Body.String())
	}
	again := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/js/main.js", nil)
	req.Header.Set("If-None-Match", tag)
	srv.ServeHTTP(again, req)
	if again.Code != http.StatusNotModified {
		t.Errorf("GET /js/main.js with its ETag = %d, want 304", again.Code)
	}
}

// Only the embedded files are served, however the path is spelled, and the
// files that are served keep their validators.
func TestOnlyEmbeddedFilesAreServedHoweverThePathIsSpelled(t *testing.T) {
	fsys := etagStatic()
	fsys["js/main.js"] = &fstest.MapFile{Data: []byte("export const a = 1;")}
	fsys["js/secret-name.js"] = &fstest.MapFile{Data: []byte("export const b = 2;")}
	srv := httptest.NewServer(New(fsys, Options{TargetURL: "http://192.0.2.1", TargetDisplay: "target.example"}))
	t.Cleanup(srv.Close)
	client := srv.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	get := func(method, path string, hdr ...string) (*http.Response, string) {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+path, nil)
		if len(hdr) == 2 {
			req.Header.Set(hdr[0], hdr[1])
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, string(b)
	}

	for _, p := range []string{"/js", "/js/", "/js/main.js/", "/js/%2e", "/JS/main.js", "/js/main", "/js/secret-name"} {
		resp, body := get(http.MethodGet, p)
		if resp.StatusCode == http.StatusOK {
			t.Errorf("GET %s = 200 %.200s, want no listing and no file", p, body)
		}
		if strings.Contains(body, "main.js") || strings.Contains(body, "secret-name") {
			t.Errorf("GET %s names a file: %.200s", p, body)
		}
		if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("GET %s has no nosniff", p)
		}
	}
	for _, p := range []string{"/js/.", "/js/../js/", "//js/", "/js/%2e%2e/"} {
		resp, body := get(http.MethodGet, p)
		if resp.StatusCode == http.StatusOK || strings.Contains(body, "main.js") {
			t.Errorf("GET %s = %d %.200s, want no listing", p, resp.StatusCode, body)
		}
	}

	resp, body := get(http.MethodGet, "/js/main.js?v=3")
	tag := resp.Header.Get("ETag")
	if resp.StatusCode != http.StatusOK || body != "export const a = 1;" || tag == "" {
		t.Fatalf("GET /js/main.js?v=3 = %d %q ETag %q", resp.StatusCode, body, tag)
	}
	if resp, _ := get(http.MethodGet, "/js/main.js", "If-None-Match", tag); resp.StatusCode != http.StatusNotModified {
		t.Errorf("If-None-Match on main.js = %d, want 304", resp.StatusCode)
	}
	if resp, body := get(http.MethodHead, "/js/main.js"); resp.StatusCode != http.StatusOK || body != "" || resp.Header.Get("ETag") != tag {
		t.Errorf("HEAD /js/main.js = %d body %q ETag %q", resp.StatusCode, body, resp.Header.Get("ETag"))
	}
	for _, p := range []string{"/", "/styles.css", "/knee.svg"} {
		if resp, _ := get(http.MethodGet, p); resp.StatusCode != http.StatusOK || resp.Header.Get("ETag") == "" {
			t.Errorf("GET %s = %d ETag %q, want 200 with an ETag", p, resp.StatusCode, resp.Header.Get("ETag"))
		}
	}
}
