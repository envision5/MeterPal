# Local patches to the vendored LiteLLM checkout

`gateway/` is a vendored LiteLLM fork that MeterPal runs as its metered
inference gateway.  The patches below are local changes on top of upstream
LiteLLM.  Re-apply them after any re-sync of the checkout, and remove them
once upstream carries the same fix.

## 1. Windows: the query-engine liveness probe killed the engine

`litellm/proxy/utils.py` polled the Prisma query engine for liveness with
`os.kill(pid, 0)`.  That is a POSIX probe: it checks that the process exists
and signals nothing.  On Windows CPython maps `os.kill(pid, 0)` to
`TerminateProcess`, so the probe **killed the engine it was inspecting** -
once a second in the polling watcher, and again in the DB watchdog.

The engine therefore died seconds after startup, every Prisma call failed
with `httpx.ConnectError: All connection attempts failed`, and the proxy
gave up and shut down.  The symptom looked like a crash in Prisma's Windows
support ("Assertion failed: process_title"), but the engine was fine.

Fix: one shared, platform-safe probe.

- **New** `litellm/proxy/process_probe.py` - `process_is_alive(pid)` uses
  `psutil.pid_exists` on Windows and keeps `os.kill(pid, 0)` semantics (same
  exceptions) everywhere else.
- `litellm/proxy/utils.py` - `_is_engine_alive()` and `_poll_engine_proc()`
  use `process_is_alive()`.
- `litellm/proxy/prometheus_cleanup.py` - `_is_running()` uses
  `process_is_alive()` (same landmine, reached by the multi-worker gauge
  cleanup).

`litellm/proxy/db/query_engine_reaper.py` needed no change: it is Linux-only
by construction and a no-op elsewhere.

## 2. prisma-client-py >= 0.13 stores the engine differently

`litellm/proxy/db/prisma_client.py` wrote the wrapped engine to
`prisma_client._Prisma__engine` - the name-mangled attribute of
prisma-client-py 0.11.x.  From 0.13 the engine lives in the `__slots__`
managed `_internal_engine` and is exposed through a read-only `_engine`
property, so the write raised
`AttributeError: 'Prisma' object has no attribute '_Prisma__engine'`.
That escaped `PrismaClient.connect()` and left the proxy without a database:

    LiteLLM Prisma Client Exception connect(): 'Prisma' object has no attribute '_Prisma__engine'

Fix: `_write_engine()` writes to whichever attribute the installed client
actually has (`_internal_engine` first, `_Prisma__engine` as the fallback).

## Reproducing

    python -m py_compile gateway/litellm/proxy/utils.py \
        gateway/litellm/proxy/db/prisma_client.py \
        gateway/litellm/proxy/process_probe.py \
        gateway/litellm/proxy/prometheus_cleanup.py

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart.ps1 gateway

A healthy gateway keeps `query-engine-windows.exe` alive, answers
`GET /health/liveliness` with `200 "I'm alive!"`, and stays up.
