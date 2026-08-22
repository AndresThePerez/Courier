package api

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"testing/fstest"

	"github.com/AndresThePerez/courier/internal/collections"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

func testStatic() fs.FS {
	return fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>courier</html>")}}
}

func testServer(t *testing.T) *Server {
	t.Helper()
	return New(testStatic(), Options{TargetURL: "http://127.0.0.1:8081", TargetDisplay: "pokesearch.andrestheperez.com"})
}

func TestHealthz(t *testing.T) {
	rec := httptest.NewRecorder()
	testServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("status field = %v, want ok", body["status"])
	}
}

// The editor's parameter dropdown is built from the catalog this endpoint
// serves, which is what makes the sandbox visible rather than merely enforced.
func TestCollectionsEndpointCarriesTheCatalog(t *testing.T) {
	rec := httptest.NewRecorder()
	testServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/collections", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var body struct {
		Collections []collections.Collection `json:"collections"`
		Endpoints   []sandbox.Endpoint       `json:"endpoints"`
		Target      string                   `json:"target"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Collections) == 0 {
		t.Error("no collections; the demo opens empty")
	}
	if len(body.Endpoints) == 0 {
		t.Fatal("no endpoint catalog; the editor has no parameter dropdown to build")
	}
	if body.Target == "" {
		t.Error("no target name; the UI cannot say what it is testing against")
	}

	search := body.Endpoints[0]
	if search.ID != "search" {
		t.Fatalf("endpoints[0] = %q, want search", search.ID)
	}
	if !slices.Contains(search.Params, "q") {
		t.Errorf("search params %v are missing q", search.Params)
	}
	// The catalog is the one source of truth for the allowlist, so this asserts
	// a property rather than a key count: nothing outside Pokesearch's
	// documented contract has crept in.
	if slices.Contains(search.Params, "url") || slices.Contains(search.Params, "target") {
		t.Errorf("search params %v contain a key that could influence the host", search.Params)
	}
	for _, ep := range body.Endpoints {
		if ep.Path == "" || ep.Method != http.MethodGet {
			t.Errorf("endpoint %q is not a well-formed GET target: %+v", ep.ID, ep)
		}
	}
}

func TestServesEmbeddedIndex(t *testing.T) {
	rec := httptest.NewRecorder()
	testServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK || rec.Body.Len() == 0 {
		t.Fatalf("index: status %d, %d bytes", rec.Code, rec.Body.Len())
	}
}
