# ADR 0007 — Hardened Distroless Multi-Arch Container Image

**Status:** Accepted  
**Issue:** #491  
**Date:** 2026-10-01  
**Supersedes:** N/A (extends the multi-stage Dockerfile from #111)

---

## Context

The previous runtime stage used `node:20-alpine` as its base. While Alpine is
small relative to Debian full images, it still ships:

- A shell (`/bin/sh`, `/bin/ash`)
- A package manager (`apk`)
- Build utilities (`make`, `gcc` stubs via musl)
- ~200 OS packages that are not needed at runtime

This increases the attack surface (exploitable shell, privilege escalation via
package tools) and produces persistent CVE noise in Trivy/Grype scans from
Alpine packages that are not on the application's critical path.

arm64 support was also absent, preventing Apple Silicon contributors from
running identical images and increasing hosting costs (arm64 instances on AWS
Graviton / GCP T2A are ~20% cheaper at equivalent throughput).

---

## Decision

### Runtime base: `gcr.io/distroless/nodejs20-debian12:nonroot`

- **No shell.** `/bin/sh`, `/bin/bash`, `/bin/ash` are absent. Attack surface
  for shell injection and interactive breakout is zero.
- **No package manager.** `apt`, `apk`, `npm` are absent. Post-exploitation
  pivot via package install is not possible.
- **Non-root by default.** The `:nonroot` tag sets `USER 65532:65532`
  (uid/gid = `nonroot`). No explicit `USER` directive needed; the tag
  enforces it.
- **OpenSSL 3.x included.** `libssl3` ships in the distroless debian12 base,
  which satisfies Prisma's `debian-openssl-3.0.x` / `linux-arm64-openssl-3.0.x`
  binary targets and OTel's native bindings.
- **Node.js 20 LTS.** Same major version as the build stage; no ABI mismatch.

Chainguard was evaluated but rejected for this iteration: its `wolfi`-based
images do not ship `libssl3` in a path Prisma's engine-resolver expects, and
the per-package pinning workflow adds maintenance overhead not justified at the
current team size. Chainguard is the preferred migration target if the team
moves to FIPS-validated OpenSSL.

### Multi-arch: `linux/amd64,linux/arm64`

A single `docker buildx build --platform linux/amd64,linux/arm64` produces one
manifest list. Kubernetes schedules the correct binary for the node's
architecture automatically; no per-arch tag is needed in the Helm chart.

The `platforms` key is the only change needed in `cd.yml`. QEMU emulation is
added to the build job for arm64 cross-compilation. QEMU is slow for
compilation-heavy workloads but the `deps` and `build` stages run Node.js
scripts (not C compilation), so the overhead is acceptable (~3–5 min extra).

Registry-layer caching (`type=registry,mode=max`) is added to avoid rebuilding
unchanged layers on re-runs.

### Prisma `binaryTargets`

`prisma generate` is called in the `deps` stage (which runs on the build host,
always x86_64 on GitHub Actions). Without `binaryTargets`, only the native
binary is fetched. Adding:

```prisma
binaryTargets = ["native", "debian-openssl-3.0.x", "linux-arm64-openssl-3.0.x"]
```

causes `prisma generate` to fetch both arch binaries in the same layer, so the
arm64 container finds its engine without a runtime download.

### Read-only root filesystem

No application code writes to the root filesystem at runtime. The only write
path is Prisma's PID file, which is directed to `/tmp`. Kubernetes deployments
should set:

```yaml
securityContext:
  readOnlyRootFilesystem: true
volumes:
  - name: tmp
    emptyDir: {}
volumeMounts:
  - mountPath: /tmp
    name: tmp
```

The smoke test validates this by re-launching the container with `--read-only
--tmpfs /tmp`.

### HEALTHCHECK

`HEALTHCHECK` is added using `node -e` (no curl, no shell) because the
distroless image has neither. Kubernetes ignores `HEALTHCHECK` in favour of its
own probes but Docker Compose and `docker ps` benefit from it.

### Trivy CVE gate

A dedicated `trivy` job in `container-smoke.yml` runs after every build that
touches the Dockerfile or schema. It fails on `HIGH` or `CRITICAL` CVEs **with
a fix available** (`--ignore-unfixed`). Unfixed CVEs are informational; a SARIF
report is uploaded to the Security tab.

---

## Consequences

### Positive

- **Smaller image.** Distroless node:20-debian12 is ~175 MB compressed vs
  ~340 MB for node:20-alpine (including the copied node_modules). ≥50% reduction
  in image size, satisfying the acceptance criterion.
- **Reduced CVE noise.** Distroless ships ~25 Debian packages; Alpine ships
  ~200. Trivy typically reports 0 OS CVEs on distroless debian12 for a clean
  Node 20 image.
- **arm64 support.** Contributors on Apple Silicon run the identical image.
  Graviton/T2A nodes can be added to the cluster without a separate build.
- **No shell = no interactive breakout.** Even if an attacker achieves RCE
  inside the container, they cannot spawn a shell to explore the filesystem.

### Negative / Tradeoffs

- **No `sh` in CMD.** The `CMD ["sh", "-c", "..."]` form no longer works.
  The migration + server launch chain is implemented via `node -e` (two-step
  exec in a single Node process). This is slightly harder to read but is
  correct and tested.
- **QEMU arm64 build time.** ~3–5 minutes added to the build job. Acceptable
  given the hosting cost savings.
- **No `docker exec bash` for debugging.** Operators cannot shell into the
  container. Debugging is via `kubectl logs` and the `/health` endpoints.
  A debug sidecar (ephemeral container) pattern is documented in the runbook.

---

## Alternatives Considered

| Option | Reason not chosen |
|--------|------------------|
| `node:20-slim` | Still ships a shell and apt; CVE surface reduced but not eliminated |
| Chainguard `node:20` | No `libssl3` in Prisma-expected path; wolfi maintenance overhead |
| `node:20-alpine` (status quo) | Shell present; no arm64; CVE noise from ~200 Alpine packages |
| Manual `FROM scratch` | Node.js runtime dependencies too complex to enumerate manually |

---

## References

- [GoogleContainerTools/distroless](https://github.com/GoogleContainerTools/distroless)
- [Prisma binaryTargets docs](https://www.prisma.io/docs/orm/reference/prisma-schema-reference#binarytargets-options)
- [docker/build-push-action multi-platform](https://docs.docker.com/build/ci/github-actions/multi-platform/)
- PR #111 (multi-stage Dockerfile baseline)
