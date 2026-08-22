package web

import (
	"io/fs"
	"strings"
	"testing"
)

// requiredIDs is the markup/script sync guard. Every element id any frontend
// module reaches for by name lives here, and the rule is that a task adding an
// id adds it to this list in the same commit.
//
// This test is the only thing standing between a typo in a getElementById call
// and a page that loads, logs nothing, and silently does not work — module
// load failures surface in the browser console and nowhere else, so an
// automated guard on the contract between markup and script is worth more here
// than in a server-rendered app.
var requiredIDs = []string{
	// shell
	"app", "topbar", "brand", "target-label", "run-state", "sidebar-toggle",
	"panes", "panel-sidebar", "panel-main", "panel-rail", "tabs",
	"tab-runner", "tab-editor", "tab-results",
	"panel-runner", "panel-editor", "panel-results",

	// sidebar
	"collections-tree", "workspace-tree", "reset-workspace", "reset-confirm",
	"history-list", "target-note", "target-note-name",

	// request editor
	"editor-empty", "editor-form", "editor-name", "editor-origin", "editor-note",
	"endpoint-select", "param-rows", "add-param", "param-note",
	"assertion-rows", "add-assertion", "assertion-note",
	"send-request", "save-request", "send-status", "send-response",

	// runner sequence
	"sequence-list", "sequence-count", "sequence-note", "select-all", "deselect-all",

	// run config rail and run controls
	"mode-functional", "mode-performance", "mode-note",
	"functional-options", "performance-options",
	"stop-on-failure", "delay-ms", "concurrency", "duration-secs",
	"start-run", "cancel-run", "watch-run", "start-note",
	"run-status-banner", "cooldown-countdown",

	// results — shared header and the live transport's own note
	"results-empty", "results-summary", "download-pdf", "transport-note",

	// results — functional
	"functional-results", "results-filter", "results-rows",

	// results — performance live phase
	"perf-live", "perf-elapsed", "perf-rps", "perf-counters",

	// results — performance dashboard
	"perf-dashboard", "verdict-badge", "sla-ladder", "apdex-block",
	"latency-table", "histogram", "per-request-table", "error-block",
}

// requiredScripts is every module index.html transitively needs. embed.go
// globs js/*.js, so a file that is never written is not a build error — it is
// a 404 at runtime, in the console, on the visitor's machine.
var requiredScripts = []string{
	"js/main.js", "js/store.js", "js/api.js", "js/dom.js",
	"js/workspace.js", "js/render-sidebar.js", "js/render-editor.js",
	"js/render-runner.js", "js/render-results.js",
}

func TestEmbeddedMarkupHasRequiredElements(t *testing.T) {
	html, err := Files.ReadFile("index.html")
	if err != nil {
		t.Fatalf("read index.html: %v", err)
	}
	if _, err := Files.ReadFile("styles.css"); err != nil {
		t.Fatalf("read styles.css: %v", err)
	}
	page := string(html)
	if !strings.Contains(page, `type="module"`) {
		t.Error("index.html must load the frontend as an ES module")
	}
	for _, id := range requiredIDs {
		if !strings.Contains(page, `id="`+id+`"`) {
			t.Errorf("index.html is missing element id %q", id)
		}
	}
}

func TestEmbeddedScriptsArePresent(t *testing.T) {
	for _, name := range requiredScripts {
		if _, err := Files.ReadFile(name); err != nil {
			t.Errorf("missing embedded script %s: %v", name, err)
		}
	}
}

// TestNoInnerHTML is a house rule with teeth: every string this page renders is
// either visitor input or a response body from the target, so one innerHTML is
// a stored-XSS hole with a curated collection as the delivery mechanism.
func TestNoInnerHTML(t *testing.T) {
	scripts, err := fs.Glob(Files, "js/*.js")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(scripts) == 0 {
		t.Fatal("no frontend modules are embedded")
	}
	for _, name := range scripts {
		src, err := Files.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, banned := range []string{"innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"} {
			if strings.Contains(string(src), banned) {
				t.Errorf("%s uses %s; render text with textContent instead", name, banned)
			}
		}
	}
}
