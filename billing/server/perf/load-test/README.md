# Load Testing

Artillery-based load tests for the Autumn server, with attach cycling.

## Quick Start

```bash
cd server

# 1. Seed the load-test catalog + customers (idempotent)
bun loadtest:setup

# 2. Run a load test (writes results JSON, prints the live summary)
bun loadtest          # general load test (4 min, up to ~75 req/s)
bun loadtest:stress   # stress evidence run (~10 min, up to ~300-600 req/s)

# 3. Turn the results JSON into a committed markdown summary
bun loadtest:report   # results/results.json -> results/results.md
```

## Prerequisites

1. Server running on `localhost:8080` (`bun d`) against the dev compose (Postgres 5433 + Redis 6380)
2. `UNIT_TEST_AUTUMN_SECRET_KEY` and `TESTS_ORG` available via infisical (the npm scripts handle this)
3. `.customers.json` exists in this directory (see Setup below)

## Setup

`bun loadtest:setup` (`perf/load-test/setup.ts`) creates everything the
scenarios need via the `/v1` API:

- features `messages` (metered, consumable) and `dashboard` (continuous_use)
- the four `load-test` plans:

| Product ID | Type | Price | Features |
|---|---|---|---|
| `load-free` | Default (free) | $0 | dashboard (boolean), messages (100/mo) |
| `load-pro` | Subscription | $20/mo | dashboard, messages (1000/mo) |
| `load-premium` | Subscription | $50/mo | dashboard, messages (unlimited) |
| `load-messages` | Add-on (one-off) | $10 | messages (+500, one-time) |

- customers `load-cus-001` .. `load-cus-500`

and writes the customer-id mapping to `.customers.json` (gitignored) next to
this README. The file maps each customer id to its (synthetic, stable)
processor id, which `processor.mjs` loads. Existing features/plans are
detected and skipped, so re-running is safe.

Paid attaches need a payment method on the customer, which the processor
supplies through its own hosted approval flow — a load test cannot complete
that, so paid-product attaches are expected to come back with a payment URL
rather than succeeding.

## Scenarios

Both configs run two weighted scenarios:

### Core API loop (90% of virtual users)

Each VU makes 3 requests:
1. `POST /v1/check` — check feature access
2. `POST /v1/track` — track usage
3. `GET /v1/customers/:id` — fetch customer

### Attach flow (10% of virtual users)

Each VU makes 2 requests:
1. `POST /v1/billing.attach` — upgrade/downgrade to a random product
2. `POST /v1/check` — check feature access after attach

Since all subscription products share the `load-test` group, attaching a different product triggers an upgrade or downgrade. Attaching the same product the customer already has is handled gracefully (no-op or returns existing).

## Load Profiles

### `memoryLeak.yml` — Memory leak detection

| Phase | Duration | VU/sec | ~Req/sec | Purpose |
|---|---|---|---|---|
| Warm-up | 30s | 1 -> 3 | 3-9 | Gentle start |
| Ramp | 60s | 3 -> 10 | 9-30 | Gradual increase |
| Sustained | 600s | 10 | ~30 | Leak detection window |

At sustained 10 VU/sec: ~9 core loop VUs (~27 req/s) + ~1 attach VU (~2 req/s).

### `artillery.yml` — General load test

| Phase | Duration | VU/sec | ~Req/sec | Purpose |
|---|---|---|---|---|
| Warm-up | 30s | 1 -> 5 | 3-15 | Warm caches, JIT |
| Ramp to peak | 60s | 5 -> 25 | 15-75 | Find breaking point |
| Sustained | 120s | 25 | ~75 | Sustained peak |
| Spike | 30s | 25 -> 50 | 75-150 | Brief spike |

### `artillery.stress.yml` — Stress evidence run

| Phase | Duration | VU/sec | ~Req/sec | Purpose |
|---|---|---|---|---|
| Warm-up | 30s | 5 -> 25 | 15-75 | Warm caches, JIT |
| Ramp to default peak | 60s | 25 -> 50 | 75-150 | Reach the smoke peak |
| Sustained default peak | 180s | 50 | ~150 | Sustained peak |
| Spike | 60s | 50 -> 100 | 150-300 | Burst headroom |
| Beyond default peak | 90s | 100 | ~300 | Sustained overshoot |
| Stress climb | 60s | 100 -> 200 | 300-600 | Find the ceiling |
| Stress plateau | 45s | 200 | ~600 | Ceiling hold |

> **Windows / Node ≥ 24 note:** on Windows with Node v24 + artillery 2.0.34,
> long high-arrival runs die ~60–90s in with a native fail-fast
> (`exit -1073740791` / `0xC0000409`), reproducibly once arrival crosses
> ~25–50 VU/s. The default `artillery.yml` profile (peak ~150 req/s) runs
> clean end to end and is the committed-evidence run on Windows hosts;
> reserve `artillery.stress.yml` for Linux/CI hosts until that Node/artillery
> combination is updated.

## Evidence Workflow

The commit-friendly benchmark artifact is the markdown summary:

1. `bun loadtest:setup`
2. `bun loadtest` (or `bun loadtest:stress`) — both scripts pass `--output`
   to Artillery, writing `results/results.json` / `results/results-stress.json`
3. `bun loadtest:report` — converts the results JSON into `results/*.md`
   (per-phase rate + latency percentiles + status codes). Commit the `.md`;
   the raw `.json` files are gitignored.

When citing numbers anywhere (Devpost, README, pitch), cite from a committed
`results/*.md` — never from memory.

## Memory Leak Debugging Workflow

1. Start server: `bun d`
2. Take baseline heap snapshot: `curl localhost:8080/debug/heap-snapshot`
3. Run: `bun loadtest:leak`
4. At ~5 min, take mid-test snapshot: `curl localhost:8080/debug/heap-snapshot`
5. When test ends, take final snapshot: `curl localhost:8080/debug/heap-snapshot`
6. Open Chrome DevTools > Memory tab > Load all 3 `.heapsnapshot` files
7. Select the latest snapshot > Summary > switch to Comparison
8. Look at the "Delta" column for objects accumulating between snapshots

Heap snapshots are saved to `server/perf/snapshots/` (gitignored).

## File Structure

```
server/perf/
├── load-test/
│   ├── processor.mjs         # Artillery helper functions (picks random customers/products)
│   ├── setup.ts              # Seeds features/plans/customers, writes .customers.json
│   ├── artillery.yml         # General load test config
│   ├── artillery.stress.yml  # Stress evidence run config
│   ├── summarizeLoadTest.ts  # results JSON -> committed markdown summary
│   ├── memoryLeak.yml        # Memory leak detection config
│   ├── .customers.json       # Generated customer->processorId mapping (gitignored)
│   ├── results/              # Artillery --output JSON (gitignored) + committed .md summaries
│   ├── .gitignore
│   └── README.md
└── snapshots/
    └── .gitignore            # Ignores *.heapsnapshot files
```
