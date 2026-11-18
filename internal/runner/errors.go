package runner

// The sentences a visitor reads for a dispatch that failed.
//
// They are fixed because Go's transport errors are not fit to show: they name
// the target's internal address (in production a container hostname and
// port) and speak the dialler's vocabulary. The raw error is the operator's;
// it is logged once per failed dispatch under EventDispatchFailed and never
// serialized.
const (
	// MsgConnection is a dispatch that got no status line: refused, reset,
	// unresolvable, or a handshake that failed.
	MsgConnection = "could not connect to the target"

	// MsgDropped is a dispatch whose status line arrived and whose body did not.
	MsgDropped = "the connection dropped while reading the response"

	// MsgAborted is Courier's own cancel, shutdown or deadline.
	MsgAborted = "stopped by Courier before a response arrived"
)

// MsgTimeout names the per-request ceiling, derived from ClientTimeout so the
// sentence cannot drift from the limit it describes.
var MsgTimeout = "the target did not respond within " + ClientTimeout.String()

// PublicError is the sentence a visitor sees for r, or "" when it succeeded.
// The error kind decides it; a connection failure splits on whether a status
// line had arrived first.
func (r Response) PublicError() string {
	switch {
	case r.Err == nil:
		return ""
	case r.ErrKind == ErrKindAborted:
		return MsgAborted
	case r.ErrKind == ErrKindTimeout:
		return MsgTimeout
	case r.Status != 0:
		return MsgDropped
	default:
		return MsgConnection
	}
}
