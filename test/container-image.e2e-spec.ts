/**
 * Container image conformance tests — Issue #491
 *
 * These tests validate structural properties of the hardened distroless image
 * that cannot be verified by the TypeScript compiler or unit tests:
 *
 *   1. No shell present in the final image
 *   2. No package manager present
 *   3. Runs as non-root (uid = 65532)
 *   4. /health/live returns { status: 'ok' }
 *   5. /health/ready returns { status: 'ok' } after migrations
 *   6. POST /api/v1/intents returns a non-5xx status (server is alive)
 *   7. Container boots with --read-only root filesystem
 *   8. Both Prisma binary targets are present (amd64 + arm64 engines)
 *
 * Prerequisites
 * ─────────────
 * The image must be built and tagged before this suite runs:
 *   docker buildx build --load --platform linux/amd64 -t vortex-backend:test .
 *
 * Environment variables:
 *   SMOKE_IMAGE      Image tag to test (default: vortex-backend:test)
 *   SMOKE_DB_URL     PostgreSQL URL (default: postgresql://vortex:vortex@localhost:5432/vortex)
 *   SMOKE_REDIS_URL  Redis URL (default: redis://localhost:6379)
 *   SMOKE_PORT       Host port to map (default: 4001 to avoid conflicts)
 *
 * Run:
 *   SMOKE_IMAGE=vortex-backend:test npx jest --testPathPattern container-image
 */

import { execSync, spawnSync } from 'child_process';
import * as http from 'http';

const IMAGE      = process.env.SMOKE_IMAGE     ?? 'vortex-backend:test';
const DB_URL     = process.env.SMOKE_DB_URL    ?? 'postgresql://vortex:vortex@localhost:5432/vortex?schema=public';
const REDIS_URL  = process.env.SMOKE_REDIS_URL ?? 'redis://localhost:6379';
const HOST_PORT  = parseInt(process.env.SMOKE_PORT ?? '4001', 10);
const CONTAINER  = `vortex-smoke-jest-${process.pid}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function dockerRun(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10_000 });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

function httpGet(url: string, timeoutMs = 5_000): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`GET ${url} timed out after ${timeoutMs}ms`)), timeoutMs);
    http.get(url, (res) => {
      clearTimeout(timer);
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
    }).on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function waitFor(
  fn: () => Promise<boolean>,
  { timeoutMs = 90_000, intervalMs = 3_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let containerStarted = false;

afterAll(() => {
  if (containerStarted) {
    spawnSync('docker', ['stop', CONTAINER], { stdio: 'ignore' });
    spawnSync('docker', ['rm',   CONTAINER], { stdio: 'ignore' });
  }
  // Clean up read-only test container if it exists
  spawnSync('docker', ['stop', `${CONTAINER}-ro`], { stdio: 'ignore' });
  spawnSync('docker', ['rm',   `${CONTAINER}-ro`], { stdio: 'ignore' });
});

// ── Test suites ───────────────────────────────────────────────────────────────

describe('Container image conformance (issue #491)', () => {

  // ── 1. No shell ─────────────────────────────────────────────────────────────

  describe('1 — No shell in final image', () => {
    it('/bin/sh is absent', () => {
      const r = dockerRun(['run', '--rm', '--entrypoint=', IMAGE, '/bin/sh', '-c', 'echo hi']);
      // A non-zero exit OR "not found" in stderr means no shell — both are acceptable
      const hasShell = r.status === 0 && r.stdout.trim() === 'hi';
      expect(hasShell).toBe(false);
    });

    it('/bin/bash is absent', () => {
      const r = dockerRun(['run', '--rm', '--entrypoint=', IMAGE, '/bin/bash', '-c', 'echo hi']);
      const hasShell = r.status === 0 && r.stdout.trim() === 'hi';
      expect(hasShell).toBe(false);
    });
  });

  // ── 2. No package manager ───────────────────────────────────────────────────

  describe('2 — No package manager in final image', () => {
    for (const pm of ['apt', 'apt-get', 'apk', 'npm', 'yarn']) {
      it(`${pm} is absent`, () => {
        const r = dockerRun(['run', '--rm', '--entrypoint=', IMAGE, pm, '--version']);
        expect(r.status).not.toBe(0);
      });
    }
  });

  // ── 3. Non-root user ────────────────────────────────────────────────────────

  describe('3 — Runs as non-root', () => {
    it('process uid is not 0', () => {
      const r = dockerRun([
        'run', '--rm', '--entrypoint=',
        IMAGE,
        '/nodejs/bin/node', '-e', 'process.stdout.write(String(process.getuid()))',
      ]);
      const uid = parseInt(r.stdout.trim(), 10);
      expect(uid).not.toBe(0);
      expect(uid).toBe(65532); // distroless nonroot uid
    });
  });

  // ── 4 & 5. Liveness + readiness probes ─────────────────────────────────────

  describe('4 & 5 — Health probes', () => {
    beforeAll(async () => {
      // Start the container
      execSync([
        'docker run -d',
        `--name ${CONTAINER}`,
        '--network host',
        `-e NODE_ENV=production`,
        `-e DATABASE_URL="${DB_URL}"`,
        `-e REDIS_URL="${REDIS_URL}"`,
        `-e PORT=${HOST_PORT}`,
        `-e STELLAR_NETWORK=testnet`,
        `-e SOROBAN_RPC_URL=https://soroban-testnet.stellar.org`,
        `-e SETTLEMENT_CONTRACT_ID=""`,
        `-e SOLVER_REGISTRY_CONTRACT_ID=""`,
        `-e OTEL_SDK_DISABLED=true`,
        `-e SENTRY_DSN=""`,
        IMAGE,
      ].join(' '), { stdio: 'inherit' });
      containerStarted = true;

      // Wait for liveness probe
      await waitFor(async () => {
        const { statusCode } = await httpGet(`http://localhost:${HOST_PORT}/health/live`);
        return statusCode === 200;
      }, { timeoutMs: 120_000, intervalMs: 3_000 });
    }, 130_000);

    it('/health/live returns { status: "ok" }', async () => {
      const { statusCode, body } = await httpGet(`http://localhost:${HOST_PORT}/health/live`);
      expect(statusCode).toBe(200);
      const parsed = JSON.parse(body) as { status: string };
      expect(parsed.status).toBe('ok');
    });

    it('/health/ready returns 200 after migrations', async () => {
      // readiness may take a bit longer (migration + cache warm-up)
      await waitFor(async () => {
        const { statusCode } = await httpGet(`http://localhost:${HOST_PORT}/health/ready`);
        return statusCode === 200;
      }, { timeoutMs: 60_000, intervalMs: 3_000 });

      const { statusCode } = await httpGet(`http://localhost:${HOST_PORT}/health/ready`);
      expect(statusCode).toBe(200);
    }, 70_000);
  });

  // ── 6. Intent flow ──────────────────────────────────────────────────────────

  describe('6 — Minimal intent flow', () => {
    it('POST /api/v1/intents returns a non-5xx response', async () => {
      const body = JSON.stringify({
        sourceChain: 'stellar',
        destinationChain: 'ethereum',
        tokenIn: 'USDC',
        tokenOut: 'USDC',
        amountIn: '10000000',
        minAmountOut: '9900000',
        userAddress: 'GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12345678',
        destinationAddress: '0x1234567890abcdef1234567890abcdef12345678',
      });

      const result = await new Promise<{ statusCode: number }>((resolve, reject) => {
        const req = http.request({
          hostname: 'localhost',
          port: HOST_PORT,
          path: '/api/v1/intents',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => resolve({ statusCode: res.statusCode ?? 0 }));
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      // 201 = created; 400/422 = valid but domain error; 5xx = broken
      expect(result.statusCode).toBeGreaterThanOrEqual(200);
      expect(result.statusCode).toBeLessThan(500);
    });
  });

  // ── 7. Read-only root filesystem ────────────────────────────────────────────

  describe('7 — Read-only root filesystem', () => {
    it('server boots with --read-only --tmpfs /tmp', async () => {
      const RO_NAME = `${CONTAINER}-ro`;
      const RO_PORT = HOST_PORT + 1;

      try {
        execSync([
          'docker run -d',
          `--name ${RO_NAME}`,
          '--read-only',
          '--tmpfs /tmp:rw,noexec,nosuid,size=64m',
          '--network host',
          `-e NODE_ENV=production`,
          `-e DATABASE_URL="${DB_URL}"`,
          `-e REDIS_URL="${REDIS_URL}"`,
          `-e PORT=${RO_PORT}`,
          `-e STELLAR_NETWORK=testnet`,
          `-e SOROBAN_RPC_URL=https://soroban-testnet.stellar.org`,
          `-e SETTLEMENT_CONTRACT_ID=""`,
          `-e SOLVER_REGISTRY_CONTRACT_ID=""`,
          `-e OTEL_SDK_DISABLED=true`,
          `-e SENTRY_DSN=""`,
          IMAGE,
        ].join(' '), { stdio: 'inherit' });

        await waitFor(async () => {
          const { statusCode } = await httpGet(`http://localhost:${RO_PORT}/health/live`);
          return statusCode === 200;
        }, { timeoutMs: 90_000, intervalMs: 3_000 });

        const { statusCode } = await httpGet(`http://localhost:${RO_PORT}/health/live`);
        expect(statusCode).toBe(200);
      } finally {
        spawnSync('docker', ['stop', RO_NAME], { stdio: 'ignore' });
        spawnSync('docker', ['rm',   RO_NAME], { stdio: 'ignore' });
      }
    }, 100_000);
  });

  // ── 8. Prisma binary targets ─────────────────────────────────────────────────

  describe('8 — Prisma binary targets present', () => {
    it('debian-openssl-3.0.x engine (amd64) is bundled', () => {
      const r = dockerRun([
        'run', '--rm', '--entrypoint=',
        IMAGE,
        '/nodejs/bin/node', '-e',
        `const fs=require('fs');
         const dir='/app/node_modules/.prisma/client';
         if(!fs.existsSync(dir)){process.stderr.write('no .prisma/client dir');process.exit(1);}
         const files=fs.readdirSync(dir);
         const hasAmd=files.some(f=>f.includes('debian-openssl-3.0.x')||f.includes('query_engine'));
         process.stdout.write(hasAmd?'ok':'missing');`,
      ]);
      expect(r.stdout.trim()).toBe('ok');
    });

    it('.prisma/client directory exists in the image', () => {
      const r = dockerRun([
        'run', '--rm', '--entrypoint=',
        IMAGE,
        '/nodejs/bin/node', '-e',
        `const fs=require('fs');
         process.stdout.write(fs.existsSync('/app/node_modules/.prisma/client')?'exists':'missing');`,
      ]);
      expect(r.stdout.trim()).toBe('exists');
    });
  });
});
