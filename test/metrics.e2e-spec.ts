import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";

const TEST_METRICS_TOKEN = "test-metrics-token-for-ci";

describe("MetricsController (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = TEST_METRICS_TOKEN;
    app = await createTestApp();
  });

  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  describe("authentication", () => {
    it("GET /metrics returns 403 with no Authorization header", async () => {
      await request(app.getHttpServer()).get("/metrics").expect(403);
    });

    it("GET /metrics returns 403 with wrong token", async () => {
      await request(app.getHttpServer())
        .get("/metrics")
        .set("Authorization", "Bearer wrong-token")
        .expect(403);
    });

    it("GET /metrics returns 403 when Authorization header has no Bearer prefix", async () => {
      await request(app.getHttpServer())
        .get("/metrics")
        .set("Authorization", TEST_METRICS_TOKEN)
        .expect(403);
    });
  });

  describe("authorised access", () => {
    it("GET /metrics returns prometheus metrics with valid token", async () => {
      const res = await request(app.getHttpServer())
        .get("/metrics")
        .set("Authorization", `Bearer ${TEST_METRICS_TOKEN}`)
        .expect(200);

      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.text).toContain("vortex_http_requests_total");
      expect(res.text).toContain("vortex_http_request_duration_seconds");
      expect(res.text).toContain("vortex_http_request_errors_total");
      expect(res.text).toContain("vortex_intent_state_transitions_total");
      expect(res.text).toContain("vortex_ws_connections_active");
    });

    it("GET /metrics includes default metrics (process_cpu)", async () => {
      const res = await request(app.getHttpServer())
        .get("/metrics")
        .set("Authorization", `Bearer ${TEST_METRICS_TOKEN}`)
        .expect(200);
      expect(res.text).toContain("vortex_process_cpu_seconds");
    });
  });

  it("labels HTTP request metrics with the routed API version", async () => {
    await request(app.getHttpServer()).get("/api/v1/stats").expect(200);
    const res = await request(app.getHttpServer()).get("/metrics").expect(200);

    expect(res.text).toContain('version="v1"');
  });
});
