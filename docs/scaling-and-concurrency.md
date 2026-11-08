# Scaling & Concurrency

How MeterPal behaves under high concurrency — the per-customer correctness
model, the horizontal-scaling story, the failure postures, and how to
reproduce the evidence.

## The one-paragraph version

MeterPal is **Redis-primary, Postgres-authoritative**. Every balance mutation
for a customer runs as a single atomic Redis Lua script keyed on a
`{customerId}` hash tag, so concurrent requests for the *same* customer
serialize while *different* customers proceed in parallel across cluster
slots. Postgres remains the source of truth via a coalesced, lock-protected
sync, and provides a `FOR UPDATE`-guarded deduction fallback when Redis is
down. The API tier is stateless (N forks per task behind an external load
balancer), and slow work moves off the request path onto SQS workers.

## Per-customer correctness under concurrency

- **Atomic core** — `billing/server/src/_luaScriptsV2/fullSubjectDeduction/deductFromSubjectBalances.lua`
  validates, deducts, writes receipts and idempotency markers in one script
  execution. There is no check-then-deduct race window: when the balance
  cannot cover the hold, the reject gate returns `INSUFFICIENT_BALANCE` with
  **zero writes**.
- **Reservations** — `POST /v1/check` with a lock performs a *real deduction
  of a priced hold*, so the sum of outstanding holds can never exceed the
  balance. Settlement unwinds the hold then charges real usage; a
  first-writer claim marker (`SET NX`) means only one finalizer wins. The
  LiteLLM bridge requests reservations by default (`REQUIRE_LOCK`) and
  refuses to serve any admit that comes back without a reservation id —
  including fail-open responses, which it converts to a 402.
- **Plain (no-lock) checks are advisory** — they are read-only evaluations of
  cached balances; two concurrent plain checks can both pass. That is by
  design (documented at `runCheckV2.ts`): admission exclusivity comes from
  reservations, and enforcement ultimately lands at the settle's reject/cap
  gate against live Redis state.
- **Triple idempotency** — (1) a DynamoDB conditional-write claim on
  `Idempotency-Key` headers across `/v1`, (2) a Redis dedupe key *inside* the
  Lua script (covers at-least-once queue redeliveries), (3) reservation ids
  derived from idempotency keys so retries re-resolve to the same hold.
- **Postgres fallback** — when Redis is unavailable, deductions fall through
  to a PL/pgSQL path that locks entitlement rows with ordered
  `FOR UPDATE` (`performDeduction.sql`); the Redis→Postgres sync flush
  re-checks its locks and detects `cache_version` conflicts.
- **Stale-cache safety** — every cache invalidation bumps a subject view
  epoch; a deduction carrying a stale epoch writes nothing and retries once
  on a fresh view.

### Verifying it live

```bash
cd billing/server
bun run check:concurrency
```

`scripts/concurrencyReservationCheck.ts` drives a live server over HTTP and
asserts the properties above: 5 concurrent checks each get their own
reservation; holds sum to N × hold; a replayed idempotency key takes no
second hold; charge-then-release nets to the usage; an unaffordable request
is refused. It exits non-zero on any failure.

## Horizontal scaling

- **Stateless API tier** — `billing/server/src/init.ts` forks
  `SERVER_FORK_COUNT` workers (default 4, cap 6) per task via
  `node:cluster`, with RSS-based fork recycling. Any instance can serve any
  request; there is no session affinity.
- **Load balancing** — external (AWS ALB in front of ECS). The app is
  LB-ready: `GET /` 503s until caches are latched, `GET /ready/:token` runs a
  1s-timeout `SELECT 1` on the critical pool, and an `x-region` header
  supports LB verification. Blue-green deploys gate workers/crons on an S3
  slot record with readiness heartbeats.
- **Fleet sizing** — the primary pins its resolved fork count into every
  child's env (`SERVER_FLEET_SIZE`), and per-process admission gates divide
  cluster-wide caps by that number
  (`getFleetProcessCount` in `recyclePolicy.ts`). An explicit
  `fleet_process_count` in the gate's edge config overrides the derivation.
- **Connection budgets** — four sized pg pools (critical 22 / general 14 /
  replica 9 / replica-slow 2 per fork) behind PgBouncer, with the documented
  fleet budget check at startup (`initDrizzle.ts`).
- **Read replicas** — lag-gated routing (replica reads eligible only while
  replication lag < 60s and the replica count matches), a primary-degradation
  failover monitor, and a per-customer LSN ledger that pins a recently
  written customer back to the primary so no one reads a stale balance.
- **Slow work off the hot path** — async tracking and batch resets move to
  SQS queues consumed by dedicated worker forks, whose concurrency is capped
  cluster-wide by Redis-permit leases.

## Rate limiting & load shedding

- Redis-backed limiters (per-customer check/track 10k/s; org aggregates like
  check 240k/min) — deliberately in Redis so limits don't multiply per
  instance.
- Admission gates shed with 429 when per-customer/per-org hydration queues
  back up (EWMA-predicted-wait), and `503 service_unavailable` on transient
  DB/cache saturation.
- `POST /v1/check` fails open to `202 allowed` after a 3s blanket timeout —
  **except** for lock requests, which never fail open (an abandoned run
  would leak a reservation).

## Failure postures: `DEP_FAILURE_POLICY`

Optional infrastructure (idempotency store, distributed rate limiting,
cache-backed reads) degrades gracefully. The posture is a single env knob
(default `fail_open`, i.e. availability over strictness):

| Surface | `fail_open` (default) | `fail_closed` |
|---|---|---|
| Dynamo idempotency claim unavailable | request proceeds un-deduped | 503 `idempotency_store_unavailable` |
| Redis rate limiter down | bypass limiting (in-memory limiter where configured) | 503 `rate_limiter_unavailable` / direct shed |
| Check dependencies (cache, DB transient) | `202 allowed` fallback | 503 `check_unavailable` |
| Queue concurrency permits (workers) | always fail open — throughput cap, not correctness | unchanged, always fail open |

Money movement is unaffected by the choice: deductions always run through
the atomic Lua script or the locked Postgres fallback.

## Cron jobs and multi-instance safety

Crons run on the active blue-green slot. Three layers keep duplicate tasks
from duplicating side effects:

1. **Process-local overlap guard** — `withSingleFlight` skips an overlapping
   fire of the same tick within one process (`cron/utils/singleFlight.ts`).
2. **Conditional row claims** — trial expiry, revert expiry, and one-off
   expiry transitions are status-guarded updates (`inStatuses: ACTIVE_STATUSES`);
   the loser of a race matches zero rows and skips its side effects
   (transitions, webhooks). The invoice cron claims the invoice row with
   `FOR UPDATE`, re-reading the committed status under the lock so a
   concurrent capture (Paid) wins over the void.
3. **Convergent jobs** — seat sync re-checks its mismatch predicate inside
   the UPDATE; grant cleanup deletes by primary key. Re-running them is a
   no-op.

Reset crons fan out through SQS with `FOR UPDATE ... SKIP LOCKED` batch
claiming.

## Load-test evidence

```bash
cd billing/server
bun run loadtest:setup   # seed features/plans/500 customers (idempotent)
bun run loadtest         # 4-min smoke: ramp to ~75 req/s, spike 150
bun run loadtest:stress  # ~10-min evidence run: up to ~300-600 req/s
bun run loadtest:report  # results/*.json -> committed results/*.md summary
```

Cite numbers from a committed `billing/server/perf/load-test/results/*.md`
only — never from memory. The rig also includes a memory-leak workflow
(`loadtest:leak`) with heap-snapshot diffing.

## Known trade-offs (documented, deliberate)

- Plain checks are advisory (see above); the gateway closes the gap by
  requiring reservations.
- `fleet_process_count` edge-config overrides win over the pinned fork
  count — keep the override in sync if you set one.
- A single Postgres primary behind PgBouncer is the write bottleneck;
  replicas are read-only and optional (`DATABASE_REPLICA_URL`).
