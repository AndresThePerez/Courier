package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/assert"
)

// decodeJSON reads a capped body holding exactly one JSON object whose shape
// is exactly v's. It answers the client and returns false on any failure, so
// callers read as one guard clause.
//
// The cap is enforced by http.MaxBytesReader rather than by trusting
// Content-Length, which a client controls and can simply lie about.
//
// Strict because a key the server does not read is a key the author believes
// does something: a "url" that is silently dropped looks, from the outside,
// exactly like a "url" that is honoured. The same goes for a second "endpoint"
// that quietly wins over the first, and for a key that only matches a field
// because encoding/json folds case.
//
// The body's read is bounded by a place and a deadline (body_reads.go) and
// its check by the bytes of the bodies in it (bodyGate). The body is read in
// full before it enters the gate, so an upload in progress holds a place but
// no room in the check, and the place is given back as the read ends, before
// the body waits for room.
func (s *Server) decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if !isJSONContentType(r.Header.Values("Content-Type")) {
		refuseContentType(w, r)
		return false
	}
	rc := http.NewResponseController(w)
	if !s.reads.take() {
		// The answer does not wait for the body. net/http still drains what it
		// can of the body after answering, within the deadline
		// boundDeclaredBodies set when the request arrived.
		w.Header().Set("Connection", "close")
		answerBusy(w)
		s.metrics.readRefused()
		return false
	}
	held := true
	defer func() {
		if held {
			s.reads.give()
		}
	}()

	body, ok := s.readBody(w, r, rc)
	held = false
	s.reads.give()
	if !ok {
		return false
	}
	n := bodyWeight(len(body))
	if !s.bodies.enter(r.Context(), n) {
		// enter also gives up when the client has gone while its body waited;
		// that answer reaches no one and is not a refusal.
		if r.Context().Err() == nil {
			s.metrics.lineRefused()
		}
		answerBusy(w)
		return false
	}
	defer s.bodies.leave(n)
	if s.bodies.checking != nil {
		s.bodies.checking(n)
	}
	return decodeBody(w, body, v)
}

// readBody reads the body under the size cap and the read deadline. The
// deadline is cleared once the body has arrived, so it does not reach what
// the handler does next. net/http clears it too when a body reaches its end
// and sets it afresh for the next request, so this clear is a statement of
// intent the standard library already keeps, not the only thing that keeps
// it. After a read that failed the deadline is left in place, since the
// connection is closed after the answer and must not wait on the client.
func (s *Server) readBody(w http.ResponseWriter, r *http.Request, rc *http.ResponseController) ([]byte, bool) {
	// A request with no body has nothing to wait for, and the server is
	// already watching its connection for the client going away.
	limited := r.Body != http.NoBody && rc.SetReadDeadline(time.Now().Add(s.readDeadline)) == nil
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBodyBytes))
	if err == nil {
		if limited {
			_ = rc.SetReadDeadline(time.Time{})
		}
		return body, true
	}
	if errors.Is(err, os.ErrDeadlineExceeded) {
		w.Header().Set("Connection", "close")
		writeError(w, http.StatusRequestTimeout, "body", "the body did not arrive within %s", s.readDeadline)
		s.metrics.readTimedOut()
		return nil, false
	}
	answerReadError(w, err)
	return nil, false
}

// answerBusy is the 503 of a body turned away before it is checked.
func answerBusy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", bodyGateRetryAfter)
	writeError(w, http.StatusServiceUnavailable, "", bodyGateBusy)
}

// refuseContentType is the 415, given before the body is read. A declared
// body is then never read, so the connection is closed after the answer
// rather than drained for the next request; boundDeclaredBodies keeps that
// drain within the body read deadline.
func refuseContentType(w http.ResponseWriter, r *http.Request) {
	if r.Body != http.NoBody {
		w.Header().Set("Connection", "close")
	}
	writeError(w, http.StatusUnsupportedMediaType, "body", "Content-Type must be application/json")
}

// answerReadError answers 413 for a body over the cap and 400 for one that
// could not be read.
func answerReadError(w http.ResponseWriter, err error) {
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		writeError(w, http.StatusRequestEntityTooLarge, "body", "payload exceeds the %d byte limit", MaxBodyBytes)
		return
	}
	writeError(w, http.StatusBadRequest, "body", "the body could not be read")
}

// decodeBody holds body to v's shape and decodes it into v, answering 400
// when it does not fit.
func decodeBody(w http.ResponseWriter, body []byte, v any) bool {
	if field, msg, ok := checkBody(body, reflect.TypeOf(v)); !ok {
		writeError(w, http.StatusBadRequest, field, "%s", msg)
		return false
	}

	// checkBody has already held every key and value to v's shape; this decode
	// cannot meet an unknown field unless the walk and the type have drifted.
	if err := decodeChecked(body, v); err != nil {
		// A backstop; its text is Go's and is not shown.
		writeError(w, http.StatusBadRequest, "body", "the body does not match the expected shape")
		return false
	}
	return true
}

// decodeChecked is the decode that follows checkBody. The walk has already
// refused every key v lacks; the decoder refuses them again so that a payload
// type growing a shape the walk does not model is still held to its fields,
// rather than having an unknown key silently dropped.
func decodeChecked(body []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

// isJSONContentType accepts exactly one Content-Type naming application/json,
// with no parameter but an optional UTF-8 charset: JSON on the wire is UTF-8.
func isJSONContentType(values []string) bool {
	if len(values) != 1 {
		return false
	}
	mt, params, err := mime.ParseMediaType(values[0])
	if err != nil || mt != "application/json" {
		return false
	}
	for k, v := range params {
		if k != "charset" || !strings.EqualFold(v, "utf-8") {
			return false
		}
	}
	return true
}

// checkBody validates body against the shape of t (a pointer to the payload
// type) and returns the offending field and a message when it does not fit.
// Messages describe JSON, never Go: a visitor has no use for a struct name.
func checkBody(body []byte, t reflect.Type) (field, msg string, ok bool) {
	dec := json.NewDecoder(bytes.NewReader(body))
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		var syn *json.SyntaxError
		switch {
		case errors.As(err, &syn):
			return "body", fmt.Sprintf("malformed JSON at byte %d", syn.Offset), false
		case errors.Is(err, io.EOF):
			return "body", "body must hold exactly one JSON value", false
		default: // io.ErrUnexpectedEOF: the body stops inside a value
			return "body", fmt.Sprintf("malformed JSON at byte %d", len(body)), false
		}
	}
	if len(bytes.TrimLeft(body[dec.InputOffset():], " \t\r\n")) > 0 {
		return "body", "body must hold exactly one JSON value", false
	}
	if raw[0] != '{' {
		return "body", "body must be a JSON object", false
	}

	w := shapeWalk{b: raw}
	if se := w.value(t, 0); se != nil {
		return se.field, se.msg, false
	}
	return "", "", true
}

// shapeError is a value that does not fit the payload's shape, at a field in
// the same notation the validator uses (sequence[2].params.q).
type shapeError struct{ field, msg string }

// maxFieldLen bounds the field an error body names. Within the schema a field
// is a handful of short segments; only nesting inside an untyped value can
// make one longer.
const maxFieldLen = 200

// shapePath is where the walk is, kept as segments on one reused stack and
// rendered only when an error names it.
//
// A body nests ten thousand levels deep inside an assertion's value within the
// size cap. A path string built per level, and held by every level beneath it,
// costs the square of the depth: about a gigabyte for one request. Inside an
// untyped value the stack also stops growing past what a field could show, so
// its size is set by the schema, not by the body.
type shapePath struct {
	segs []pathSeg
	// dropped counts the levels below the deepest segment kept. Levels are
	// dropped only from the bottom, so push and pop stay in step.
	dropped int
}

// pathSeg is an object key, or an array index when isKey is false.
type pathSeg struct {
	key   string
	index int
	isKey bool
}

// maxUntypedSegs is how far below a typed value segments are kept: a segment
// renders as at least two characters, so a deeper path cannot fit in a field.
const maxUntypedSegs = maxFieldLen / 2

func (p *shapePath) push(sg pathSeg, typed int) {
	if p.dropped > 0 || len(p.segs)-typed >= maxUntypedSegs {
		p.dropped++
		return
	}
	p.segs = append(p.segs, sg)
}

func (p *shapePath) pop() {
	if p.dropped > 0 {
		p.dropped--
		return
	}
	p.segs = p.segs[:len(p.segs)-1]
}

// fail reports msg at the current position. typed is how many segments lead to
// the nearest value the schema types: a position inside an untyped value whose
// full path will not fit is named by that value instead, which is still the
// thing the editor can highlight.
func (p *shapePath) fail(typed int, msg string) *shapeError {
	field, ok := renderPath(p.segs, maxFieldLen)
	if !ok || p.dropped > 0 {
		field, ok = renderPath(p.segs[:typed], maxFieldLen)
	}
	if !ok {
		field = clipRunes(field, maxFieldLen)
	}
	if field == "" {
		field = "body"
	}
	return &shapeError{field, msg}
}

// renderPath writes segs in the validator's notation, each key clipped, and
// reports whether the result fits in limit characters. It stops writing once
// it is past the limit, so a deep path costs no more than a short one.
func renderPath(segs []pathSeg, limit int) (string, bool) {
	var b strings.Builder
	for _, sg := range segs {
		if utf8.RuneCountInString(b.String()) > limit {
			return b.String(), false
		}
		if !sg.isKey {
			b.WriteByte('[')
			b.WriteString(strconv.Itoa(sg.index))
			b.WriteByte(']')
			continue
		}
		if b.Len() > 0 {
			b.WriteByte('.')
		}
		b.WriteString(assert.Clip(sg.key))
	}
	out := b.String()
	return out, utf8.RuneCountInString(out) <= limit
}

// clipRunes cuts s to at most n characters, the last three of them "...",
// never splitting a character.
// Not assert.Clip: here the "..." counts inside n, so a field stays within maxFieldLen.
func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	count := 0
	for i := range s {
		if count == n-3 {
			return s[:i] + "..."
		}
		count++
	}
	return s
}

// shapeWalk checks a JSON value against a Go type by reading its bytes in
// place. checkBody hands it only a value the decoder has already accepted, so
// it is well-formed and at most the decoder's nesting limit deep, which is
// what bounds the recursion here. The walk does not rely on that to be safe:
// every byte read is bounds-checked, and bytes that are not JSON end the walk
// with a malformed-JSON error, never a panic or a loop. Each step consumes at
// least one byte, so the recursion is bounded by the input on any bytes.
//
// A walk over encoding/json's tokens would cost a decode, an interface value
// and, after every key, a syntax error allocated and thrown away: a few hundred
// bytes per key, which ten thousand nested keys turn into megabytes.
type shapeWalk struct {
	b    []byte
	i    int
	path shapePath
}

// malformed is the walk's answer to bytes that are not JSON.
func (w *shapeWalk) malformed() *shapeError {
	return &shapeError{"body", fmt.Sprintf("malformed JSON at byte %d", w.i)}
}

// peek returns the byte at w.i, or false at the end of the input.
func (w *shapeWalk) peek() (byte, bool) {
	if w.i >= len(w.b) {
		return 0, false
	}
	return w.b[w.i], true
}

// expect moves past c, or reports that the next byte is not c.
func (w *shapeWalk) expect(c byte) bool {
	if b, ok := w.peek(); !ok || b != c {
		return false
	}
	w.i++
	return true
}

// literal moves past lit, or reports that the input does not hold it here.
func (w *shapeWalk) literal(lit string) bool {
	if !bytes.HasPrefix(w.b[w.i:], []byte(lit)) {
		return false
	}
	w.i += len(lit)
	return true
}

func (w *shapeWalk) skipSpace() {
	for w.i < len(w.b) {
		switch w.b[w.i] {
		case ' ', '\t', '\r', '\n':
			w.i++
		default:
			return
		}
	}
}

// skipString moves past the string starting at w.i and returns its bytes,
// quotes included, or false when there is no whole string there.
func (w *shapeWalk) skipString() ([]byte, bool) {
	start := w.i
	if !w.expect('"') {
		return nil, false
	}
	for ; w.i < len(w.b); w.i++ {
		switch w.b[w.i] {
		case '\\':
			w.i++
		case '"':
			w.i++
			return w.b[start:w.i], true
		}
	}
	return nil, false
}

// key reads an object key as encoding/json will see it, escapes resolved and
// invalid UTF-8 replaced, so the key checked is the key decoded.
func (w *shapeWalk) key() (string, bool) {
	quoted, ok := w.skipString()
	if !ok {
		return "", false
	}
	inner := quoted[1 : len(quoted)-1]
	if bytes.IndexByte(inner, '\\') < 0 && utf8.Valid(inner) {
		return string(inner), true
	}
	var k string
	_ = json.Unmarshal(quoted, &k)
	return k, true
}

// value checks the value at w.i against t. A nil t (an `any` field) accepts
// any value, though duplicate keys are still refused. typed is the depth of
// the nearest typed value at or above this one.
func (w *shapeWalk) value(t reflect.Type, typed int) *shapeError {
	w.skipSpace()
	for t != nil && t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	c, ok := w.peek()
	if !ok {
		return w.malformed()
	}
	if c == 'n' { // null leaves a field at its zero value
		if !w.literal("null") {
			return w.malformed()
		}
		return nil
	}
	untyped := false
	if t != nil {
		// An `any` field is itself a typed position; only what it holds is not.
		typed = len(w.path.segs)
		if t.Kind() == reflect.Interface {
			t, untyped = nil, true
		}
	}
	mismatch := func(got string) *shapeError {
		return w.path.fail(typed, fmt.Sprintf("expected %s, got %s", jsonKind(t), got))
	}
	switch c {
	case '{', '[':
		se := w.array
		got := "an array"
		if c == '{' {
			se, got = w.object, "an object"
		}
		if err := se(t, typed); err != nil {
			return err
		}
		// An `any` field holds one scalar. The only one in the payloads is an
		// assertion's value, which `exists` ignores and every other operator
		// compares with a number or a string; a structure there is kept, and
		// stored in the run's report, replay log and frames, so a body could
		// fill each of those with a quarter of a megabyte of it. It is walked
		// first so that a fault inside it is still named where it is.
		if untyped {
			return w.path.fail(typed, "expected a number, a string, true, false or null, got "+got)
		}
		return nil
	case '"':
		if _, ok := w.skipString(); !ok {
			return w.malformed()
		}
		if t != nil && t.Kind() != reflect.String {
			return mismatch("a string")
		}
	case 't', 'f':
		lit := "false"
		if c == 't' {
			lit = "true"
		}
		if !w.literal(lit) {
			return w.malformed()
		}
		if t != nil && t.Kind() != reflect.Bool {
			return mismatch("a boolean")
		}
	default:
		start := w.i
		for w.i < len(w.b) && strings.IndexByte("+-.0123456789eE", w.b[w.i]) >= 0 {
			w.i++
		}
		if w.i == start {
			return w.malformed()
		}
		n := json.Number(w.b[start:w.i])
		return checkNumber(n, t, func() *shapeError {
			return w.path.fail(typed, fmt.Sprintf("the number %s is out of range", assert.Clip(n.String())))
		}, mismatch)
	}
	return nil
}

func (w *shapeWalk) object(t reflect.Type, typed int) *shapeError {
	var fields map[string]reflect.Type
	switch {
	case t == nil:
	case t.Kind() == reflect.Struct:
		fields = structFields.of(t)
	case t.Kind() == reflect.Map:
	default:
		return w.path.fail(typed, fmt.Sprintf("expected %s, got an object", jsonKind(t)))
	}
	w.i++ // '{'
	// Objects in a payload hold a few keys, and nesting is where the count of
	// objects is large, so a set is only built past a handful of keys.
	var few [4]string
	keys := few[:0]
	var seen map[string]bool
	for n := 0; ; n++ {
		w.skipSpace()
		if c, ok := w.peek(); !ok {
			return w.malformed()
		} else if c == '}' {
			w.i++
			return nil
		}
		if n > 0 {
			if !w.expect(',') {
				return w.malformed()
			}
			w.skipSpace()
		}
		key, ok := w.key()
		if !ok {
			return w.malformed()
		}
		w.skipSpace()
		if !w.expect(':') {
			return w.malformed()
		}

		if seen[key] || (seen == nil && slices.Contains(keys, key)) {
			w.path.push(pathSeg{key: key, isKey: true}, typed)
			se := w.path.fail(typed, fmt.Sprintf("duplicate key %q", assert.Clip(key)))
			w.path.pop()
			return se
		}
		switch {
		case seen != nil:
			seen[key] = true
		case len(keys) < cap(keys):
			keys = append(keys, key)
		default:
			seen = make(map[string]bool, 2*len(keys))
			for _, k := range keys {
				seen[k] = true
			}
			seen[key] = true
		}

		var elem reflect.Type
		switch {
		case t == nil:
		case fields != nil:
			ft, known := fields[key]
			if !known {
				return w.path.fail(typed, fmt.Sprintf("unknown field %q", assert.Clip(key)))
			}
			elem = ft
		default:
			elem = t.Elem()
		}
		w.path.push(pathSeg{key: key, isKey: true}, typed)
		se := w.value(elem, typed)
		w.path.pop()
		if se != nil {
			return se
		}
	}
}

func (w *shapeWalk) array(t reflect.Type, typed int) *shapeError {
	var elem reflect.Type
	if t != nil {
		if t.Kind() != reflect.Slice && t.Kind() != reflect.Array {
			return w.path.fail(typed, fmt.Sprintf("expected %s, got an array", jsonKind(t)))
		}
		elem = t.Elem()
	}
	w.i++ // '['
	for i := 0; ; i++ {
		w.skipSpace()
		if c, ok := w.peek(); !ok {
			return w.malformed()
		} else if c == ']' {
			w.i++
			return nil
		}
		if i > 0 && !w.expect(',') {
			return w.malformed()
		}
		w.path.push(pathSeg{index: i}, typed)
		se := w.value(elem, typed)
		w.path.pop()
		if se != nil {
			return se
		}
	}
}

// checkNumber holds a number to what encoding/json will accept for t, so the
// decode that follows cannot fail on it.
func checkNumber(n json.Number, t reflect.Type, outOfRange func() *shapeError, mismatch func(string) *shapeError) *shapeError {
	kind := reflect.Float64
	if t != nil {
		kind = t.Kind()
	}
	switch kind {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		if _, err := strconv.ParseInt(n.String(), 10, t.Bits()); err != nil {
			if errors.Is(err, strconv.ErrRange) {
				return outOfRange()
			}
			return mismatch("the number " + assert.Clip(n.String()))
		}
	case reflect.Float32, reflect.Float64:
		bits := 64
		if t != nil {
			bits = t.Bits()
		}
		if _, err := strconv.ParseFloat(n.String(), bits); err != nil {
			return outOfRange()
		}
	default:
		return mismatch("a number")
	}
	return nil
}

// fieldCache holds each struct type's field map, built on its first use and
// only read after that. A body at the size cap holds tens of thousands of JSON
// objects; building a map for each one cost several allocations apiece
// (BenchmarkCheckBodyManyObjects). Its keys are the struct types reachable
// from the payload types, so it never grows past a handful of entries.
type fieldCache struct{ m sync.Map } // reflect.Type -> map[string]reflect.Type

// structFields is the one cache every request shares.
var structFields fieldCache

func (c *fieldCache) of(t reflect.Type) map[string]reflect.Type {
	if f, ok := c.m.Load(t); ok {
		return f.(map[string]reflect.Type)
	}
	f, _ := c.m.LoadOrStore(t, jsonFields(t))
	return f.(map[string]reflect.Type)
}

// jsonFields maps each JSON key of a struct to its field type, by the exact
// tag name only.
func jsonFields(t reflect.Type) map[string]reflect.Type {
	out := make(map[string]reflect.Type, t.NumField())
	for f := range t.Fields() {
		if !f.IsExported() {
			continue
		}
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if name == "-" {
			continue
		}
		if name == "" {
			name = f.Name
		}
		out[name] = f.Type
	}
	return out
}

// jsonKind names what a Go type accepts, in JSON's vocabulary.
func jsonKind(t reflect.Type) string {
	if t == nil {
		return "a JSON value"
	}
	switch t.Kind() {
	case reflect.String:
		return "a string"
	case reflect.Bool:
		return "true or false"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return "a whole number"
	case reflect.Float32, reflect.Float64:
		return "a number"
	case reflect.Struct, reflect.Map:
		return "an object"
	case reflect.Slice, reflect.Array:
		return "an array"
	default:
		return "a JSON value"
	}
}
