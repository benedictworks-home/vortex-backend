import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";
import { SEED_SOLVER_KEYPAIRS } from "../src/solvers/solvers.seed";
import { IntentsService } from "../src/intents/intents.service";

const ALPHA_ADDR = SEED_SOLVER_KEYPAIRS.ALPHA.publicKey();
const GAMMA_ADDR = SEED_SOLVER_KEYPAIRS.GAMMA.publicKey();

describe("Solvers Reputation v2 (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /api/v1/solvers/:address/reputation", () => {
    it("200s for a seeded solver and returns the full reputation shape", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/solvers/${ALPHA_ADDR}/reputation`)
        .expect(200);

      expect(typeof res.body.score).toBe("number");
      expect(res.body.score).toBeGreaterThanOrEqual(0);
      expect(res.body.score).toBeLessThanOrEqual(1);

      // Five components.
      expect(typeof res.body.components.fillRate).toBe("number");
      expect(typeof res.body.components.latency).toBe("number");
      expect(typeof res.body.components.slashes).toBe("number");
      expect(typeof res.body.components.quoteHonour).toBe("number");
      expect(typeof res.body.components.volume).toBe("number");

      // Five weights summing to 1.
      const weights = res.body.weights;
      expect(typeof weights.fillRate).toBe("number");
      const sum = weights.fillRate + weights.latency + weights.slashes + weights.quoteHonour + weights.volume;
      expect(Math.abs(sum - 1)).toBeLessThan(1e-6);

      expect(typeof res.body.decayHalflifeSeconds).toBe("number");
      expect(res.body.decayHalflifeSeconds).toBeGreaterThan(0);
      expect(typeof res.body.evaluatedAtEpoch).toBe("number");
      expect(Array.isArray(res.body.history)).toBe(true);
    });

    it("404s for an unknown address", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/solvers/NOPE/reputation")
        .expect(404);
      expect(res.body.error).toBe("Solver not found");
    });

    it("returns the trailing snapshot history respecting ?limit", async () => {
      const resDefault = await request(app.getHttpServer())
        .get(`/api/v1/solvers/${ALPHA_ADDR}/reputation`)
        .expect(200);
      expect(Array.isArray(resDefault.body.history)).toBe(true);

      const resLimit = await request(app.getHttpServer())
        .get(`/api/v1/solvers/${ALPHA_ADDR}/reputation?limit=2`)
        .expect(200);
      expect(resLimit.body.history.length).toBeLessThanOrEqual(2);
    });
  });

  describe("GET /api/v1/solvers/leaderboard sort=reputation", () => {
    beforeAll(async () => {
      // Give ALPHA and BETA distinct event profiles via intents so the
      // reputation ordering is deterministic for the sort check.
      const intents = app.get(IntentsService);
      const all = await intents.getAll();
      if (all.length >= 2) {
        const now = Math.floor(Date.now() / 1000);
        // First two intents go to ALPHA as perfect fills.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await intents.update(all[0].intentId, {
          solver: ALPHA_ADDR,
          state: "filled",
          filledAt: now,
          fillAmount: "5000",
          acceptedAt: now - 60,
          deadlineAt: now + 240,
          amountInUsd: 5000,
        } as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await intents.update(all[1].intentId, {
          solver: ALPHA_ADDR,
          state: "filled",
          filledAt: now - 10,
          fillAmount: "7500",
          acceptedAt: now - 10 - 45,
          deadlineAt: now - 10 + 255,
          amountInUsd: 7500,
        } as any);
      }
    });

    it("returns sort=reputation in the payload body", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/solvers/leaderboard?sort=reputation")
        .expect(200);
      expect(res.body.sort).toBe("reputation");
      expect(res.body.window).toBeDefined();
    });

    it("rejects an invalid sort key", async () => {
      await request(app.getHttpServer())
        .get("/api/v1/solvers/leaderboard?sort=oops")
        .expect(400);
    });

    it("when sort=reputation, entries are non-increasing by reputationScore", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/solvers/leaderboard?sort=reputation&window=all")
        .expect(200);
      const scores = res.body.solvers.map(
        (s: { reputationScore: number }) => s.reputationScore,
      );
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1] + 1e-9).toBeGreaterThanOrEqual(scores[i]);
      }
    });

    it("default sort=fills still works (backward compat)", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/solvers/leaderboard")
        .expect(200);
      expect(res.body.sort).toBe("fills");
    });

    it("sort=reputation + window=24h combines without 500ing", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/solvers/leaderboard?sort=reputation&window=24h")
        .expect(200);
      expect(res.body.window).toBe("24h");
      expect(res.body.sort).toBe("reputation");
    });
  });

  describe("GET /api/v1/solvers/:address/stats uses the new reputation formula", () => {
    it("stats now exposes reputationComponents alongside the score", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/solvers/${GAMMA_ADDR}/stats`)
        .expect(200);
      expect(typeof res.body.reputationScore).toBe("number");
      expect(typeof res.body.reputationComponents).toBe("object");
      expect(typeof res.body.reputationComponents.fillRate).toBe("number");
    });
  });
});
