# billing/archive

Completed planning and handoff documents. Every file here describes work that
has landed in the code — they are kept as a record of decisions, not as living
documentation. Do not edit them; write new plans under `plans/` (still-open
work) instead.

- `plans/` — the former `billing/.plans/` agent-planning handoffs, plus
  `plans/create-invoice-ui/PLAN.md` and `handoff-change-builders.md`.
  Notable: the cache-v2 family was implemented and then superseded by the
  FullSubject cache; the redis-cloud-migration family landed in
  `server/src/external/redis/`.
- `scripts/tw-PROFILE.md` — a point-in-time measurement of `bun tw` (2026-07-08).

Still-open material lives in `billing/plans/` (`balance-sync-correctness.md` —
a deferred correctness gap — and `migration-recovery.md`, parked).
