/**
 * WebSocket protocol versioning — contract / e2e tests (issue #456).
 *
 * Verifies:
 * 1. No subprotocol header → accepted, connected frame includes version=vortex.v1
 * 2. vortex.v1 subprotocol → accepted, server echoes vortex.v1
 * 3. Unknown subprotocol → connection closed with code 1002
 * 4. GET /docs/ws returns AsyncAPI YAML (Content-Type: application/x-yaml)
 */

import { INestApplication } from "@nestjs/common";
import request from "supertest";
import WebSocket from "ws";
import { createTestApp } from "./utils/create-test-app";
import { WS_PROTOCOL_V1, WS_CLOSE_UNSUPPORTED_PROTOCOL } from "../src/intents/ws-protocol";

describe("WS protocol versioning (issue #456)", () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
  });

  afterAll(async () => {
    await app.close();
  });

  // ── helper ────────────────────────────────────────────────────────────────

  function wsConnect(
    protocols?: string | string[],
  ): Promise<{ ws: WebSocket; firstMessage: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`, protocols);
      ws.once("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          resolve({ ws, firstMessage: msg });
        } catch (e) {
          reject(e);
        }
      });
      ws.once("error", reject);
    });
  }

  function wsConnectExpectClose(
    protocols: string | string[],
  ): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`, protocols);
      ws.once("close", (code, reasonBuf) => {
        resolve({ code, reason: reasonBuf.toString() });
      });
      ws.once("error", reject);
      // Safety timeout — if no close arrives within 2 s, fail the test.
      setTimeout(() => reject(new Error("timeout waiting for close")), 2000);
    });
  }

  // ── 1. No subprotocol → default v1, version in connected frame ────────────

  it("accepts connections with no subprotocol and returns version=vortex.v1 in connected frame", async () => {
    const { ws, firstMessage } = await wsConnect();
    try {
      expect(firstMessage.type).toBe("connected");
      expect(firstMessage.version).toBe(WS_PROTOCOL_V1);
    } finally {
      ws.close();
    }
  });

  // ── 2. vortex.v1 subprotocol → accepted, echoed ───────────────────────────

  it("accepts connections with vortex.v1 subprotocol and echoes it", async () => {
    const { ws, firstMessage } = await wsConnect(WS_PROTOCOL_V1);
    try {
      expect(ws.protocol).toBe(WS_PROTOCOL_V1);
      expect(firstMessage.type).toBe("connected");
      expect(firstMessage.version).toBe(WS_PROTOCOL_V1);
    } finally {
      ws.close();
    }
  });

  it("connected frame includes seq field", async () => {
    const { ws, firstMessage } = await wsConnect(WS_PROTOCOL_V1);
    try {
      expect(typeof firstMessage.seq).toBe("number");
    } finally {
      ws.close();
    }
  });

  // ── 3. Unknown subprotocol → close 1002 ──────────────────────────────────

  it("closes with code 1002 when client offers an unknown subprotocol", async () => {
    const { code, reason } = await wsConnectExpectClose("vortex.v99");
    expect(code).toBe(WS_CLOSE_UNSUPPORTED_PROTOCOL);
    expect(reason).toContain("vortex.v1");
  });

  it("closes with code 1002 for a completely foreign protocol", async () => {
    const { code } = await wsConnectExpectClose("some-other-protocol");
    expect(code).toBe(WS_CLOSE_UNSUPPORTED_PROTOCOL);
  });

  // ── 4. GET /docs/ws returns AsyncAPI YAML ─────────────────────────────────

  it("GET /docs/ws returns 200 with AsyncAPI YAML content", async () => {
    const res = await request(app.getHttpServer())
      .get("/docs/ws")
      .expect(200);

    expect(res.headers["content-type"]).toMatch(/yaml/);
    expect(res.text).toContain("asyncapi:");
    expect(res.text).toContain("vortex.v1");
  });

  it("GET /docs/ws contains the vortex.v1 protocol identifier", async () => {
    const res = await request(app.getHttpServer()).get("/docs/ws").expect(200);
    expect(res.text).toContain(WS_PROTOCOL_V1);
  });

  it("GET /docs/ws describes the connected message type", async () => {
    const res = await request(app.getHttpServer()).get("/docs/ws").expect(200);
    expect(res.text).toContain("connected");
    expect(res.text).toContain("intent_created");
  });
});
