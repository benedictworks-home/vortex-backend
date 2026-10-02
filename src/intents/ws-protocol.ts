/**
 * WebSocket protocol versioning for the Vortex intent feed (issue #456).
 *
 * The gateway advertises a named subprotocol so clients can detect a
 * version mismatch before they send any messages.
 *
 * Negotiation rules
 * -----------------
 * 1. Client sends `Sec-WebSocket-Protocol: vortex.v1`  -> accepted; server
 *    echoes `vortex.v1` in the handshake response.
 * 2. Client sends no subprotocol header                 -> accepted with
 *    default `vortex.v1` (backward-compatible: existing bots that do not
 *    set a subprotocol keep working).  The server echoes nothing back
 *    (empty string from negotiateProtocol) because the client did not
 *    request a protocol token.
 * 3. Client sends an unrecognised subprotocol            -> the server echoes
 *    one of the offered tokens (so the ws library completes the HTTP upgrade
 *    without throwing "Server sent no subprotocol"), then `handleConnection`
 *    closes the socket with code 1002 (Protocol Error) and a reason string.
 *
 * Why not return `false` from `handleProtocols` for unknown protocols?
 * ---------------------------------------------------------------------
 * Returning `false` causes the `ws` library to send HTTP 400 before a
 * WebSocket connection exists.  The client-side `ws` library then throws
 * "Server sent no subprotocol" -- the close code 1002 is never observable.
 * Accepting the upgrade and closing in `handleConnection` lets the client
 * see close code 1002 with a descriptive reason string.
 *
 * Why echo "" (nothing) when no protocol was offered?
 * ---------------------------------------------------
 * RFC 6455 requires that the server MUST NOT include a
 * `Sec-WebSocket-Protocol` response header unless the client sent one.
 * Echoing `vortex.v1` when the client offered nothing violates this rule
 * and causes the ws client library to error before the connection opens.
 */

/** The single supported protocol identifier. */
export const WS_PROTOCOL_V1 = "vortex.v1";

/** All protocol versions the server will accept. */
export const WS_SUPPORTED_PROTOCOLS: ReadonlySet<string> = new Set([WS_PROTOCOL_V1]);

/**
 * WebSocket close code for an unrecognised protocol version.
 * RFC 6455 §7.4.1 — "1002 indicates that an endpoint is terminating the
 * connection due to a protocol error."
 */
export const WS_CLOSE_UNSUPPORTED_PROTOCOL = 1002;

/** Human-readable close reason sent alongside close code 1002. */
export const WS_CLOSE_REASON_UNSUPPORTED = "Unsupported protocol version. Use vortex.v1.";

/**
 * `handleProtocols` callback for the underlying `ws.Server`.
 *
 * Always returns a string (never `false`) so the HTTP upgrade always succeeds
 * and `handleConnection` can close with code 1002 for unknown versions --
 * giving the client a descriptive WS reason string.
 *
 * Three cases:
 *
 * 1. Client offered no subprotocol header (empty set)
 *    -> return `""` (echo nothing).  The ws library will not set a
 *      `Sec-WebSocket-Protocol` response header, which is correct: the client
 *      did not request one so we must not invent one.  `resolveProtocol`
 *      treats `""` as "accepted with default vortex.v1".
 *
 * 2. Client offered `vortex.v1` (possibly alongside others)
 *    -> return `"vortex.v1"` so the server echoes it in the upgrade response.
 *
 * 3. Client offered only unknown protocols
 *    -> echo the first offered token back.  This lets the ws client library
 *      complete the upgrade (avoiding "Server sent no subprotocol").
 *      `resolveProtocol` will see a non-v1 non-empty string and return
 *      `{ accepted: false }`, triggering close 1002 in `handleConnection`.
 *
 * @param protocols  Set of protocol strings the client offered (may be empty).
 * @returns          The agreed protocol string (never `false`).
 */
export function negotiateProtocol(protocols: Set<string>): string {
  // No subprotocol offered -> echo nothing (client did not ask for one).
  if (protocols.size === 0) return "";

  // Client offered at least one protocol -- pick the first supported one.
  for (const p of protocols) {
    if (WS_SUPPORTED_PROTOCOLS.has(p)) return p;
  }

  // No supported match -- echo the first offered token so the ws client
  // library completes the HTTP upgrade.  handleConnection closes with 1002.
  return [...protocols][0];
}

/**
 * Determine the effective protocol for an already-upgraded connection.
 *
 * Called inside `handleConnection` after the HTTP upgrade has completed.
 * By the time this is called, `negotiateProtocol` has already run:
 *
 * - `client.protocol === ""` -> the client sent no subprotocol header;
 *   we default to vortex.v1 (backward-compatible).
 * - `client.protocol === "vortex.v1"` -> the client explicitly offered v1.
 * - Any other non-empty string -> the client offered only unknown protocols;
 *   `negotiateProtocol` echoed back the first token.  Close with 1002.
 *
 * @param protocol  The `ws.WebSocket.protocol` string on the server side.
 * @returns  `{ accepted: true, version }` or `{ accepted: false }`.
 */
export function resolveProtocol(
  protocol: string,
): { accepted: true; version: string } | { accepted: false } {
  // "" means no subprotocol was offered -> default to vortex.v1.
  if (protocol === "" || protocol === WS_PROTOCOL_V1) {
    return { accepted: true, version: WS_PROTOCOL_V1 };
  }
  // Any other non-empty value: unknown protocol echoed by negotiateProtocol.
  return { accepted: false };
}
