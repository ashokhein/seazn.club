# Prompt 08: Deployment

**Context**: `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`,
section "Deployment" — `min_machines_running=1` (always warm), not
scale-to-zero: a cold start (~1-3s) would eat directly into the 8-10s
wall budget the whole investigation was built around. Different
traffic/latency shape than the web app's own `min_machines_running=2`
(deploy overlap + matchday headroom) — don't copy that value.

**Acceptance criteria**: the Docker image builds successfully. `fly.toml`
uses a TCP service block (gRPC over raw TCP), not `[http_service]` —
that block is HTTP/1.1-oriented and tuned for the web app.

**Do not touch**: the root `Dockerfile`/`fly.toml` (web app's own) —
this is a fully separate app/image per the design doc's repo-structure
section, additive only.

**Files:**
- Create: `services/cp-sat/Dockerfile`, `services/cp-sat/fly.toml`

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml .
COPY src/ src/
RUN pip install --no-cache-dir .
RUN useradd -m cpsat
USER cpsat
ENV CPSAT_PORT=50051
EXPOSE 50051
CMD ["python3", "-m", "cp_sat.main"]
```

- [ ] **Step 2: Write `fly.toml`**

```toml
app = "seazn-cpsat-prod"
primary_region = "lhr"

[build]

[[services]]
  internal_port = 50051
  protocol = "tcp"

  [[services.ports]]
    port = 50051

  [[services.tcp_checks]]
    interval = "15s"
    timeout = "5s"
    grace_period = "10s"

[[vm]]
  size = "shared-cpu-2x"
  memory = "1gb"

# min_machines_running intentionally omitted from [http_service] — this app
# has no [http_service] block (gRPC over raw TCP, not HTTP/1.1). Set via
# `fly scale count 1 --min-machines-running=1` post-deploy: always warm,
# a cold start would eat directly into the 8-10s wall budget.

# Secrets (fly secrets set):
#   CPSAT_SERVICE_SECRET — new, distinct from apps/web's CRON_SECRET
```

- [ ] **Step 3: Verify the Docker image builds**

Run: `cd services/cp-sat && docker build -t cpsat-service-test .`
Expected: build succeeds with exit code 0.

- [ ] **Step 4: Commit**

```bash
git add services/cp-sat/Dockerfile services/cp-sat/fly.toml
git commit -m "feat(cp-sat): Dockerfile and Fly app config"
```

**Verify**: `docker build` exits 0. Do not `fly deploy` as part of this prompt — deployment execution is a separate, explicit step outside this plan's scope (irreversible/shared-state action, needs its own confirmation).

**Output cap**: final message under 15 lines — build exit code, image size, confirm no `[http_service]` block present.
