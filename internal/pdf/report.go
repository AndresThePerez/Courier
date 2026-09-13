// Package pdf renders a stored run report as a single-page PDF.
//
// It is pure Go — no headless browser, no wkhtmltopdf, no font files on disk —
// and fpdf's core Helvetica is the only typeface it uses. That is the whole
// reason the one dependency in go.mod is worth having.
//
// Scope is one page, always. Header, verdict, summary stats, latency
// percentiles, and the SLA ladder as text rows. No histogram bars, no
// per-request performance breakdown, no second page — every list is truncated
// with an "and N more" line rather than allowed to flow. Auto page breaks are
// switched off, so the room checks in this file are the layout, not a hint.
package pdf

import (
	"bytes"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/go-pdf/fpdf"

	"github.com/AndresThePerez/courier/internal/report"
)

// Page geometry, in millimetres on A4 portrait.
const (
	pageW  = 210.0
	pageH  = 297.0
	margin = 14.0

	contentW = pageW - 2*margin
	footerH  = 18.0

	headH = 5.5 // table header row
	rowH  = 5.5 // table body row
	lineH = 4.5 // free-text line
)

// fontFamily is a core PDF font, so nothing has to be embedded or shipped.
const fontFamily = "Helvetica"

// epoch is the creation date used when a report has no start time. Any fixed
// instant would do; what matters is that it is not time.Now, because a
// rendered report must be a pure function of the report.
var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

type rgb struct{ r, g, b int }

var (
	ink   = rgb{26, 28, 34}
	muted = rgb{112, 118, 130}
	hair  = rgb{214, 219, 226}
	shade = rgb{243, 245, 248}
	paper = rgb{255, 255, 255}

	pass    = rgb{20, 122, 76}
	fail    = rgb{178, 42, 42}
	neutral = rgb{104, 110, 122}
)

// Render draws the report and returns the PDF bytes.
//
// The output is deterministic: the same report renders byte-identical every
// time, because both timestamps fpdf would otherwise stamp with time.Now are
// pinned to the run's own start time.
func Render(r *report.Report) ([]byte, error) {
	if r == nil {
		return nil, errors.New("pdf: no report to render")
	}
	d := build(r, true)
	if err := d.pdf.Error(); err != nil {
		return nil, fmt.Errorf("pdf: %w", err)
	}
	var buf bytes.Buffer
	if err := d.pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("pdf: %w", err)
	}
	return buf.Bytes(), nil
}

// Filename is the download name for a report, and the one place the convention
// lives.
func Filename(id string) string { return "courier-" + safeName(id) + ".pdf" }

// doc is one page under construction. y is the pen; bottom is the last line a
// content row may occupy before it would collide with the footer.
type doc struct {
	pdf    *fpdf.Fpdf
	rep    *report.Report
	y      float64
	bottom float64
}

// build lays the page out. compress is false only in tests, which read the
// literal strings back out of the content stream.
func build(r *report.Report, compress bool) *doc {
	f := fpdf.New("P", "mm", "A4", "")
	f.SetCompression(compress)
	// Resource catalogs are written in map order unless this is set, so two
	// renders of the same report would otherwise emit the two Helvetica font
	// objects in whichever order the runtime felt like.
	f.SetCatalogSort(true)

	stamp := r.StartedAt
	if stamp.IsZero() {
		stamp = epoch
	}
	f.SetCreationDate(stamp)
	f.SetModificationDate(stamp)

	f.SetTitle(ascii("Courier run report "+r.ID), false)
	f.SetAuthor("Courier", false)
	f.SetCreator("Courier", false)
	f.SetSubject(ascii(r.Mode+" run against "+r.Target), false)

	f.SetMargins(margin, margin, margin)
	// One page means one page: no auto break, and no accepted manual one either.
	f.SetAutoPageBreak(false, margin)
	f.SetAcceptPageBreakFunc(func() bool { return false })
	f.AddPage()

	d := &doc{pdf: f, rep: r, y: margin, bottom: pageH - margin - footerH}
	d.header()
	d.verdict()
	switch {
	case r.Performance != nil:
		d.performance()
	case r.Functional != nil:
		d.functional()
	default:
		d.section("Results")
		d.para(muted, 8, "This run stored no results. A run still in flight has "+
			"nothing to summarise until its first request completes.")
	}
	d.note()
	d.footer()
	return d
}

// --- page furniture -------------------------------------------------------

func (d *doc) header() {
	d.font("B", 20)
	d.text(ink)
	d.pdf.SetXY(margin, d.y)
	d.pdf.CellFormat(contentW/2, 9, "COURIER", "", 0, "L", false, 0, "")

	d.font("", 8.5)
	d.text(muted)
	d.pdf.CellFormat(contentW/2, 9, "API test and load report", "", 0, "R", false, 0, "")
	d.y += 10
	d.rule()
	d.y += 3

	r := d.rep
	d.metaRow("Run", r.ID, "Mode", r.Mode)
	d.metaRow("Started", timestamp(r.StartedAt), "Status", r.Status)
	d.metaRow("Duration", durText(r.DurationMs), "Config", configText(r))

	target := r.Target
	if target == "" {
		target = "(not recorded)"
	}
	d.metaWide("Target", target+" (executed via internal network)")
	d.y += 3
}

// metaRow is two label/value pairs side by side.
func (d *doc) metaRow(l1, v1, l2, v2 string) {
	half := contentW / 2
	d.metaPair(margin, half, l1, v1)
	d.metaPair(margin+half, half, l2, v2)
	d.y += rowH
}

func (d *doc) metaWide(label, value string) {
	d.metaPair(margin, contentW, label, value)
	d.y += rowH
}

func (d *doc) metaPair(x, w float64, label, value string) {
	const labelW = 19.0
	d.font("B", 7.5)
	d.text(muted)
	d.pdf.SetXY(x, d.y)
	d.pdf.CellFormat(labelW, rowH, ascii(label), "", 0, "L", false, 0, "")

	d.font("", 8.5)
	d.text(ink)
	d.pdf.SetXY(x+labelW, d.y)
	d.pdf.CellFormat(w-labelW, rowH, d.clip(value, w-labelW), "", 0, "L", false, 0, "")
}

// verdict is the coloured band. A cancelled or expired run gets the neutral
// N/A band (docs/deviations.md N15): those numbers are real, but they do not describe what
// the SLOs measure, so the page withholds the judgement rather than colouring
// one in.
func (d *doc) verdict() {
	label, headline, band := verdictOf(d.rep)

	d.fill(band)
	d.pdf.Rect(margin, d.y, contentW, 12, "F")

	d.text(paper)
	d.font("B", 13)
	d.pdf.SetXY(margin+4, d.y)
	d.pdf.CellFormat(contentW*0.5, 12, "VERDICT: "+label, "", 0, "L", false, 0, "")

	d.font("", 8.5)
	d.pdf.SetXY(margin+contentW*0.5, d.y)
	d.pdf.CellFormat(contentW*0.5-4, 12, d.clip(headline, contentW*0.5-4), "", 0, "R", false, 0, "")
	d.y += 12 + 2

	for _, reason := range verdictReasons(d.rep) {
		if !d.room(lineH) {
			break
		}
		d.line(muted, 8, "- "+reason)
	}
	d.y += 2
}

func (d *doc) note() {
	if d.rep.Note == "" || !d.room(lineH+6) {
		return
	}
	d.y += 2
	d.section("Note")
	d.line(muted, 8, d.rep.Note)
}

// footer sits at a fixed height, which is what makes bottom a real budget for
// everything above it. It is the one block allowed to draw below that budget,
// so it takes the remaining space back before it starts.
func (d *doc) footer() {
	d.y = pageH - margin - footerH
	d.bottom = pageH - margin
	d.rule()
	d.y += 2.5

	for _, l := range closedLoopNote {
		d.line(muted, 7, l)
	}

	d.font("", 7)
	d.text(muted)
	d.pdf.SetXY(margin, d.y)
	d.pdf.CellFormat(contentW/2, lineH, "Courier - "+ascii(d.rep.ID), "", 0, "L", false, 0, "")
	d.pdf.CellFormat(contentW/2, lineH, "Page 1 of 1", "", 0, "R", false, 0, "")
}

// closedLoopNote is split into fixed lines rather than wrapped, so the sentence
// the README makes a point of is one string on the page and not a wrap away
// from being two.
var closedLoopNote = []string{
	"Courier is a closed-loop tester: workers wait for each response before issuing the next, like hey, not open-loop fixed-rate like vegeta.",
	"Under saturation that understates tail latency (coordinated omission). Latencies are measured client-side, on the same internal network as the target.",
}

// --- performance ----------------------------------------------------------

func (d *doc) performance() {
	p := d.rep.Performance
	o := p.Overall

	d.section("Summary")
	cols := evenCols(6, "Requests", "OK", "Errors", "Aborted", "Success", "Throughput")
	d.tableHead(cols)
	d.tableRow(cols, []string{
		count(o.Requests),
		count(o.OK),
		count(o.Errors),
		count(o.Aborted),
		fmt.Sprintf("%.1f%%", o.SuccessRatio),
		fmt.Sprintf("%.1f req/s", o.RequestsPerSec),
	}, ink, "", 9)
	d.y += 3

	d.section("Latency (ms)")
	lat := evenCols(7, "min", "avg", "p50", "p90", "p95", "p99", "max")
	d.tableHead(lat)
	d.tableRow(lat, []string{
		ms(o.Latency.Min), ms(o.Latency.Avg), ms(o.Latency.P50),
		ms(o.Latency.P90), ms(o.Latency.P95), ms(o.Latency.P99), ms(o.Latency.Max),
	}, ink, "", 9)
	d.y += 3

	// The ladder stays, as text rows: no bars to draw, and the numbers are
	// the point.
	d.section("SLA ladder")
	// A report stored before the gate was recorded has a zero SLO. Print the
	// provenance only when there is provenance to print, rather than a row of
	// zeros that would read as a real gate.
	if p.SLO.P95Ms > 0 && p.SLO.CalibrationDate != "" {
		d.line(muted, 7.5, fmt.Sprintf("Gate: p95 under %.0fms and error rate under %.2f%%, calibrated %s against the %s sequence.",
			p.SLO.P95Ms, 100*p.SLO.MaxErrorRate, p.SLO.CalibrationDate, p.SLO.CalibrationSequence))
	}
	d.line(muted, 7.5, "Share of completed responses at or under each tier. Aborted dispatches are not in the denominator.")
	// The tiers the run was judged by, not the tiers this build happens to
	// define. An older stored report carries none, so fall back to the constants.
	tiers := p.SLO.LadderMs
	if len(tiers) != 3 {
		tiers = []float64{report.SLATier1Ms, report.SLATier2Ms, report.SLATier3Ms}
	}
	for _, t := range []struct {
		label string
		pct   float64
	}{
		{fmt.Sprintf("under %.0fms", tiers[0]), o.SLA.Under50},
		{fmt.Sprintf("under %.0fms", tiers[1]), o.SLA.Under150},
		{fmt.Sprintf("under %.0fms", tiers[2]), o.SLA.Under300},
	} {
		if !d.room(rowH) {
			break
		}
		d.font("", 9)
		d.text(ink)
		d.pdf.SetXY(margin, d.y)
		d.pdf.CellFormat(40, rowH, t.label, "", 0, "L", false, 0, "")
		d.font("B", 9)
		d.pdf.CellFormat(24, rowH, fmt.Sprintf("%.1f%%", t.pct), "", 0, "R", false, 0, "")
		d.y += rowH
	}
	d.y += 3

	d.section("Apdex")
	a := o.Apdex
	apdexT := p.SLO.ApdexTMs
	if apdexT == 0 {
		apdexT = report.ApdexTMs
	}
	d.line(ink, 9, fmt.Sprintf("Apdex (T=%.0fms)  %.3f  %s", apdexT, a.Score, a.Rating))
	d.line(muted, 8, fmt.Sprintf("satisfied %d  -  tolerating %d  -  frustrated %d",
		a.Satisfied, a.Tolerating, a.Frustrated))
	d.y += 3

	d.section("Errors")
	d.line(ink, 8, "Status codes: "+statusLine(o.StatusCounts))
	d.line(ink, 8, "Error kinds: "+kindLine(o.ErrorKinds))
	if p.OverrunMs > 0 {
		d.line(muted, 8, fmt.Sprintf("Wall clock overran the requested duration by %dms "+
			"while in-flight requests drained.", p.OverrunMs))
	}
}

// --- functional -----------------------------------------------------------

func (d *doc) functional() {
	f := d.rep.Functional
	c := tally(f)

	d.section("Summary")
	cols := evenCols(6, "Passed", "Failed", "Skipped", "Requests", "Duration", "Avg latency")
	d.tableHead(cols)
	d.tableRow(cols, []string{
		count(c.passed), count(c.failed), count(c.skipped), count(c.total),
		durText(d.rep.DurationMs), ms(c.avgMs) + " ms",
	}, ink, "", 9)
	d.y += 3

	failures := failedResults(f)
	// Reserve the failures block and the truncation line before the results
	// table is allowed to spend the rest of the page.
	reserve := rowH
	if len(failures) > 0 {
		reserve += 6 + lineH*float64(min(len(failures), maxFailureLines))
	}

	d.section("Requests")
	res := []col{
		{"#", 8, "L"},
		{"Request", 46, "L"},
		{"Endpoint", 24, "L"},
		{"Query", 46, "L"},
		{"Status", 16, "R"},
		{"Latency", 22, "R"},
		{"Result", 20, "R"},
	}
	d.tableHead(res)

	shown := 0
	for _, r := range f.Results {
		if !d.room(rowH + reserve) {
			break
		}
		outcome, tone := resultTone(r)
		base := ink
		if r.Skipped {
			base = muted
		}
		// The outcome column carries the colour and the row does not: a fully
		// tinted row is harder to read, not easier.
		top := d.y
		d.tableRow(res, []string{
			fmt.Sprintf("%d", r.Index+1),
			r.Name,
			r.Endpoint,
			r.Query,
			statusText(r),
			latencyText(r),
		}, base, "", 8)

		last := res[len(res)-1]
		d.font("B", 8)
		d.text(tone)
		d.pdf.SetXY(pageW-margin-last.w, top)
		d.pdf.CellFormat(last.w, rowH, outcome, "", 0, last.align, false, 0, "")
		shown++
	}
	if rest := len(f.Results) - shown; rest > 0 {
		d.line(muted, 8, fmt.Sprintf("... and %s not shown", plural(rest, "more request", "more requests")))
	}

	if len(failures) == 0 {
		return
	}
	d.y += 2
	d.section("Failures")
	for i, r := range failures {
		if i == maxFailureLines || !d.room(lineH) {
			d.line(muted, 8, fmt.Sprintf("... and %s not shown",
				plural(len(failures)-i, "more failure", "more failures")))
			break
		}
		d.line(fail, 8, failureLine(r))
	}
}

// maxFailureLines keeps the failures block inside the page budget. The results
// table above it already names every failed request; this section is the detail,
// and detail is what gets truncated first.
const maxFailureLines = 4

func failedResults(f *report.Functional) []report.RequestResult {
	var out []report.RequestResult
	for _, r := range f.Results {
		if !r.Skipped && !r.Passed {
			out = append(out, r)
		}
	}
	return out
}

// failureLine is one failed request, expected-vs-actual, on one line.
func failureLine(r report.RequestResult) string {
	head := fmt.Sprintf("#%d %s: ", r.Index+1, r.Name)
	if r.Error != "" {
		kind := r.ErrorKind
		if kind == "" {
			kind = "error"
		}
		return head + kind + " - " + r.Error
	}
	for _, o := range r.Assertions {
		if o.Passed {
			continue
		}
		a := o.Assertion
		what := a.Type
		if a.Path != "" {
			what += " " + a.Path
		}
		return head + fmt.Sprintf("%s %s %s, got %s", what, a.Op, o.Expected, o.Actual)
	}
	return head + fmt.Sprintf("status %d", r.Status)
}

type counts struct {
	total, passed, failed, skipped int
	avgMs                          float64
}

// tally counts the results array rather than reading Functional's counters.
// Those carry json:"-" (docs/deviations.md N6), so a report that came back through JSON
// has them zeroed — and the results array is the single source of truth either
// way.
func tally(f *report.Functional) counts {
	var c counts
	var sum float64
	var measured int
	for _, r := range f.Results {
		c.total++
		switch {
		case r.Skipped:
			c.skipped++
		case r.Passed:
			c.passed++
		default:
			c.failed++
		}
		if !r.Skipped && r.LatencyMs > 0 {
			sum += r.LatencyMs
			measured++
		}
	}
	// A run still in flight has fewer results than the sequence it is walking.
	if f.Total > c.total {
		c.total = f.Total
	}
	if measured > 0 {
		c.avgMs = sum / float64(measured)
	}
	return c
}

func resultTone(r report.RequestResult) (string, rgb) {
	switch {
	case r.Skipped:
		return "SKIP", muted
	case r.Passed:
		return "PASS", pass
	default:
		return "FAIL", fail
	}
}

func statusText(r report.RequestResult) string {
	if r.Skipped {
		return "-"
	}
	if r.Status == 0 {
		if r.ErrorKind != "" {
			return r.ErrorKind
		}
		return "-"
	}
	return fmt.Sprintf("%d", r.Status)
}

func latencyText(r report.RequestResult) string {
	if r.Skipped || r.LatencyMs == 0 {
		return "-"
	}
	return ms(r.LatencyMs) + " ms"
}

// --- verdict --------------------------------------------------------------

// verdictOf returns the band label, the one-line headline beside it, and the
// band colour.
func verdictOf(r *report.Report) (string, string, rgb) {
	headline := headlineOf(r)

	// A partial run is never judged, whatever the numbers say. The "partial
	// data" half of the label belongs to truncation alone, which is why it is
	// decided here, from the status, rather than from the verdict string.
	if r.Status == report.StatusCancelled || r.Status == report.StatusExpired {
		return report.VerdictNA + " - partial data", headline, neutral
	}

	switch {
	case r.Performance != nil:
		switch r.Performance.Verdict {
		case report.VerdictPass:
			return report.VerdictPass, headline, pass
		case report.VerdictFail:
			return report.VerdictFail, headline, fail
		default:
			// Withheld, not truncated: the status check above already took the
			// stopped runs, so this run finished and its numbers are complete.
			// Only the judgement is missing, and calling that partial data would
			// contradict the reason printed beside it.
			return report.VerdictNA, headline, neutral
		}

	case r.Functional != nil:
		c := tally(r.Functional)
		switch {
		case c.failed > 0:
			return report.VerdictFail, headline, fail
		case c.passed > 0:
			return report.VerdictPass, headline, pass
		default:
			return report.VerdictNA + " - nothing was asserted", headline, neutral
		}

	default:
		return report.VerdictNA + " - no results", headline, neutral
	}
}

func headlineOf(r *report.Report) string {
	switch {
	case r.Performance != nil:
		o := r.Performance.Overall
		return fmt.Sprintf("%s  -  p95 %s ms  -  %s",
			plural(o.Requests, "request", "requests"), ms(o.Latency.P95),
			plural(o.Errors, "error", "errors"))
	case r.Functional != nil:
		c := tally(r.Functional)
		return fmt.Sprintf("%d passed / %d failed / %d skipped of %d", c.passed, c.failed, c.skipped, c.total)
	default:
		return "no results recorded"
	}
}

func verdictReasons(r *report.Report) []string {
	if r.Status == report.StatusCancelled || r.Status == report.StatusExpired {
		return []string{"the run stopped early, so the SLO gates are not applied to it — the numbers below are what it did measure"}
	}
	if r.Performance != nil {
		return r.Performance.VerdictReasons
	}
	return nil
}

// --- drawing primitives ---------------------------------------------------

func (d *doc) font(style string, size float64) { d.pdf.SetFont(fontFamily, style, size) }
func (d *doc) text(c rgb)                      { d.pdf.SetTextColor(c.r, c.g, c.b) }
func (d *doc) fill(c rgb)                      { d.pdf.SetFillColor(c.r, c.g, c.b) }

func (d *doc) room(h float64) bool { return d.y+h <= d.bottom }

func (d *doc) rule() {
	d.pdf.SetDrawColor(hair.r, hair.g, hair.b)
	d.pdf.SetLineWidth(0.3)
	d.pdf.Line(margin, d.y, pageW-margin, d.y)
}

func (d *doc) section(title string) {
	if !d.room(6 + headH) {
		return
	}
	d.font("B", 9.5)
	d.text(ink)
	d.pdf.SetXY(margin, d.y)
	d.pdf.CellFormat(contentW, 6, ascii(title), "", 0, "L", false, 0, "")
	d.y += 6
}

// line writes one clipped line of text and advances the pen.
func (d *doc) line(c rgb, size float64, s string) {
	if !d.room(lineH) {
		return
	}
	d.font("", size)
	d.text(c)
	d.pdf.SetXY(margin, d.y)
	d.pdf.CellFormat(contentW, lineH, d.clip(s, contentW), "", 0, "L", false, 0, "")
	d.y += lineH
}

// para writes wrapped text. Only the two fixed-shape blurbs use it; everything
// that a test reads back goes through line, which never splits a string.
func (d *doc) para(c rgb, size float64, s string) {
	if !d.room(lineH) {
		return
	}
	d.font("", size)
	d.text(c)
	d.pdf.SetXY(margin, d.y)
	d.pdf.MultiCell(contentW, lineH, ascii(s), "", "L", false)
	d.y = d.pdf.GetY()
}

type col struct {
	title string
	w     float64
	align string
}

// evenCols splits the content width equally between the named columns.
func evenCols(n int, titles ...string) []col {
	w := contentW / float64(n)
	out := make([]col, 0, len(titles))
	for i, t := range titles {
		align := "R"
		if i == 0 {
			align = "L"
		}
		out = append(out, col{t, w, align})
	}
	return out
}

func (d *doc) tableHead(cols []col) {
	if !d.room(headH) {
		return
	}
	d.fill(shade)
	d.text(muted)
	d.font("B", 7.5)
	x := margin
	for _, c := range cols {
		d.pdf.SetXY(x, d.y)
		d.pdf.CellFormat(c.w, headH, ascii(c.title), "", 0, c.align, true, 0, "")
		x += c.w
	}
	d.y += headH
}

func (d *doc) tableRow(cols []col, vals []string, c rgb, style string, size float64) {
	if !d.room(rowH) {
		return
	}
	d.font(style, size)
	d.text(c)
	x := margin
	for i, cl := range cols {
		v := ""
		if i < len(vals) {
			v = vals[i]
		}
		d.pdf.SetXY(x, d.y)
		d.pdf.CellFormat(cl.w, rowH, d.clip(v, cl.w-1.5), "", 0, cl.align, false, 0, "")
		x += cl.w
	}
	d.y += rowH
}

// clip fits a string to a width in the current font, so a long request name
// ends in ".." instead of running over the next column.
func (d *doc) clip(s string, w float64) string {
	s = ascii(s)
	if w <= 0 || d.pdf.GetStringWidth(s) <= w {
		return s
	}
	for len(s) > 1 {
		s = s[:len(s)-1]
		if d.pdf.GetStringWidth(s+"..") <= w {
			return s + ".."
		}
	}
	return ""
}

// --- formatting -----------------------------------------------------------

// ascii keeps the page inside what a core PDF font can draw. Request names and
// query strings are visitor-supplied, and a stray multi-byte rune would
// otherwise render as mojibake.
func ascii(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r == '\n' || r == '\r' || r == '\t':
			b.WriteByte(' ')
		case r < 0x20:
			// control characters: dropped
		case r < 0x7f:
			b.WriteRune(r)
		case r == '—' || r == '–' || r == '·':
			b.WriteByte('-')
		case r == '“' || r == '”':
			b.WriteByte('"')
		case r == '‘' || r == '’':
			b.WriteByte('\'')
		case r == '…':
			b.WriteString("...")
		default:
			b.WriteByte('?')
		}
	}
	return b.String()
}

// safeName reduces a run id to something safe in a Content-Disposition header
// and on every filesystem.
func safeName(id string) string {
	var b strings.Builder
	for _, r := range ascii(id) {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	if b.Len() == 0 {
		return "report"
	}
	return b.String()
}

func ms(v float64) string { return fmt.Sprintf("%.1f", v) }

func count(n int) string { return fmt.Sprintf("%d", n) }

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

func durText(msTotal int64) string {
	if msTotal >= 1000 {
		return fmt.Sprintf("%.2f s", float64(msTotal)/1000)
	}
	return fmt.Sprintf("%d ms", msTotal)
}

func timestamp(t time.Time) string {
	if t.IsZero() {
		return "(not recorded)"
	}
	return t.UTC().Format("2006-01-02 15:04:05 MST")
}

func configText(r *report.Report) string {
	if r.Performance != nil || r.Mode == "performance" {
		return fmt.Sprintf("%d workers x %ds", r.Config.Concurrency, r.Config.DurationSecs)
	}
	parts := []string{fmt.Sprintf("%dms delay", r.Config.DelayMs)}
	if r.Config.StopOnFailure {
		parts = append(parts, "stop on first failure")
	}
	return strings.Join(parts, ", ")
}

// statusLine renders the status histogram in a stable order. 0 is the code the
// tally uses for a dispatch that never produced a response.
func statusLine(counts map[int]int) string {
	if len(counts) == 0 {
		return "none recorded"
	}
	codes := make([]int, 0, len(counts))
	for code := range counts {
		codes = append(codes, code)
	}
	slices.Sort(codes)

	parts := make([]string, 0, len(codes))
	for _, code := range codes {
		label := fmt.Sprintf("%d", code)
		if code == 0 {
			label = "no response"
		}
		parts = append(parts, fmt.Sprintf("%s x%d", label, counts[code]))
	}
	return strings.Join(parts, "   ")
}

func kindLine(kinds map[string]int) string {
	if len(kinds) == 0 {
		return "none"
	}
	names := make([]string, 0, len(kinds))
	for k := range kinds {
		names = append(names, k)
	}
	sort.Strings(names)

	parts := make([]string, 0, len(names))
	for _, k := range names {
		parts = append(parts, fmt.Sprintf("%s x%d", k, kinds[k]))
	}
	return strings.Join(parts, "   ")
}
