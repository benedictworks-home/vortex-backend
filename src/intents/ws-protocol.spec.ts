import {
  negotiateProtocol,
  resolveProtocol,
  WS_CLOSE_UNSUPPORTED_PROTOCOL,
  WS_CLOSE_REASON_UNSUPPORTED,
  WS_PROTOCOL_V1,
  WS_SUPPORTED_PROTOCOLS,
} from "./ws-protocol";

describe("ws-protocol — negotiateProtocol (HTTP upgrade handshake)", () => {
  it("accepts vortex.v1 and echoes it back", () => {
    expect(negotiateProtocol(new Set([WS_PROTOCOL_V1]))).toBe(WS_PROTOCOL_V1);
  });

  it("returns empty string when no subprotocol is offered (do not invent one)", () => {
    // RFC 6455: server MUST NOT send Sec-WebSocket-Protocol if client didn't.
    // resolveProtocol treats "" as the no-subprotocol default (vortex.v1).
    expect(negotiateProtocol(new Set())).toBe("");
  });

  it("picks vortex.v1 when client offers multiple protocols including v1", () => {
    expect(negotiateProtocol(new Set(["vortex.v2", WS_PROTOCOL_V1, "unknown"]))).toBe(WS_PROTOCOL_V1);
  });

  it("echoes the first offered token for unknown-only protocols (enables post-upgrade close)", () => {
    // Echoing back a token lets the ws client complete the upgrade so
    // handleConnection can close with code 1002 (observable by the client).
    const result = negotiateProtocol(new Set(["vortex.v2", "something-else"]));
    // The first inserted element is "vortex.v2".
    expect(result).toBe("vortex.v2");
    // Must not be a supported protocol.
    expect(WS_SUPPORTED_PROTOCOLS.has(result)).toBe(false);
  });

  it("echoes the single unknown token for a single unknown protocol", () => {
    expect(negotiateProtocol(new Set(["vortex.v99"]))).toBe("vortex.v99");
  });
});

describe("ws-protocol — resolveProtocol (post-upgrade connection check)", () => {
  it("accepts vortex.v1 with correct version", () => {
    const result = resolveProtocol(WS_PROTOCOL_V1);
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.version).toBe(WS_PROTOCOL_V1);
  });

  it("accepts empty string as no-subprotocol default (vortex.v1)", () => {
    // "" means negotiateProtocol saw no offered protocol and returned "".
    // resolveProtocol defaults to vortex.v1 so the connection proceeds.
    const result = resolveProtocol("");
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.version).toBe(WS_PROTOCOL_V1);
  });

  it("rejects an unknown non-empty protocol string (echoed token)", () => {
    // These are tokens negotiateProtocol echoed back for unknown-only offers.
    // handleConnection must close with 1002 when it sees these.
    expect(resolveProtocol("vortex.v2").accepted).toBe(false);
    expect(resolveProtocol("unknown").accepted).toBe(false);
    expect(resolveProtocol("vortex.v1.beta").accepted).toBe(false);
  });

  it("rejects a protocol that is a prefix of v1", () => {
    expect(resolveProtocol("vortex").accepted).toBe(false);
  });
});

describe("ws-protocol — constants", () => {
  it("close code is 1002 (RFC 6455 §7.4.1 Protocol Error)", () => {
    expect(WS_CLOSE_UNSUPPORTED_PROTOCOL).toBe(1002);
  });

  it("close reason mentions vortex.v1", () => {
    expect(WS_CLOSE_REASON_UNSUPPORTED).toContain("vortex.v1");
  });

  it("supported protocols set contains vortex.v1", () => {
    expect(WS_SUPPORTED_PROTOCOLS.has(WS_PROTOCOL_V1)).toBe(true);
  });
});
