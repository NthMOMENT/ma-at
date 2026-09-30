// Mirrors ma-at-web's lib/proofState.ts redact() exactly — kept as a local
// copy rather than a shared package since the two are separate npm projects
// (same reasoning as that file's own header comment).
//
// Applied here at WRITE time — inside alert() (prover_pipeline.ts, before the
// alerts.log line) and inside setAlert/recordAlertReason/setRejected
// (intent_state.ts, before alertReason/rejectReason are persisted to the
// per-intent state file) — so a leaked secret (e.g. an Alchemy RPC URL's API
// key, surfaced via a reqwest/viem error message) never reaches disk in the
// first place. ma-at-web's own redact() on top of this, applied when
// /api/proofs serves these fields, is defense in depth on top of this, not
// the only line of defense — see intent_state.ts's IntentState.alertReason
// doc comment.
export function redact(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    // Long-opaque-token pass, with two exemptions: an 0x-prefixed hash/ID
    // (existing), and a SCREAMING_SNAKE_CASE token (new) — an env var NAME
    // like ARBITRUM_INTENT_MANAGER_ADDRESS can legitimately appear in a
    // prove.rs "not set" message and is never itself a secret (only its
    // VALUE would be, and values never reach these messages — see prove.rs's
    // intent_manager_address()). A bare (non-0x-prefixed) hex ID is NOT
    // exempted here — deliberately: it's indistinguishable by shape alone
    // from a raw hex-encoded private key, so callers that want an ID to
    // survive redaction must format it with an "0x" prefix (this codebase's
    // own convention — see prover_pipeline.ts's alert() call sites) rather
    // than relying on this function to guess.
    //
    // Third exemption: a lowercase snake_case reason code (e.g.
    // insufficient_available_capital, from solver_routing.ts's exclusion
    // reasons) — letters only, at least one underscore. Anchored to the END
    // of the whole token (not \b, which stops at a hyphen) so a secret
    // glued on after a snake_case prefix ("some_code-Xy9...") still gets
    // redacted as one token. Digits deliberately excluded: every real reason
    // code is letters-only, and it keeps prefixed keys like test_fixture_0000...
    // out of this exemption.
    .replace(/\b(?!0x)(?![A-Z][A-Z0-9_]*\b)(?![a-z]+(?:_[a-z]+)+(?![A-Za-z0-9_-]))[A-Za-z0-9_-]{24,}\b/g, "[redacted]");
}

// Gate 5D-fix: the console-output half of the same guarantee — every
// viem/TronGrid/network error logged to stdout/stderr (which PM2 persists
// to log files) must be redacted first, exactly like alertReason/
// rejectReason already are before they reach disk. Centralized here (rather
// than each caller reimplementing "err instanceof Error ? err.message :
// String(err)") so it's directly unit-testable without importing any
// entrypoint file (listener.ts, tron_listener.ts) and its boot side effects
// — see redact_gate.test.ts.
export function redactError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redact(message);
}
