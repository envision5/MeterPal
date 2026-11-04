# Load Testing

Artillery-based load tests for the Autumn server, with attach cycling.

## Quick Start

```bash
cd server

# 1. Run load test
bun loadtest:leak    # memory leak detection (11 min, ~30 req/s)
bun loadtest         # general load test (4 min, up to ~75 req/s)
```

## Prerequisites

1. Server running on `localhost:8080` (`bun d`)
2. `UNIT_TEST_AUTUMN_SECRET_KEY` and `TESTS_ORG` available via infisical (the npm scripts handle this)
3. `.customers.json` exists in this directory (see Setup below)

## Setup

The load test needs 500 seeded customers and the four `load-test` products:

| Product ID | Type | Price | Features |
|---|---|---|---|
| `load-free` | Default (free) | $0 | dashboard (boolean), messages (100/mo) |
| `load-pro` | Subscription | $20/mo | dashboard, messages (1000/mo) |
| `load-premium` | Subscription | $50/mo | dashboard, messages (unlimited) |
| `load-messages` | Add-on (one-off) | $10 | messages (+500, one-time) |

Seed them into the `TESTS_ORG` org and write the customer-id mapping to
`.customers.json` (gitignored) next to this README. The file maps each
customer id (`load-cus-001` .. `load-cus-500`) to its processor id.

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
│   ├── processor.mjs      # Artillery helper functions (picks random customers/products)
│   ├── artillery.yml      # General load test config
│   ├── memoryLeak.yml     # Memory leak detection config
│   ├── .customers.json    # Generated customer->processorId mapping (gitignored)
│   ├── .gitignore
│   └── README.md
└── snapshots/
    └── .gitignore         # Ignores *.heapsnapshot files
```
