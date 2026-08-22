package web

import (
	"strings"
	"testing"
)

func TestEmbeddedMarkupHasRequiredElements(t *testing.T) {
	html, err := Files.ReadFile("index.html")
	if err != nil {
		t.Fatalf("read index.html: %v", err)
	}
	if _, err := Files.ReadFile("styles.css"); err != nil {
		t.Fatalf("read styles.css: %v", err)
	}
	if _, err := Files.ReadFile("js/main.js"); err != nil {
		t.Fatalf("read js/main.js: %v", err)
	}
	page := string(html)
	if !strings.Contains(page, `type="module"`) {
		t.Error("index.html must load the frontend as an ES module")
	}
	for _, id := range []string{"app", "collections-tree", "panel-runner"} {
		if !strings.Contains(page, `id="`+id+`"`) {
			t.Errorf("index.html is missing element id %q", id)
		}
	}
}
