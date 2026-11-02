"""Process liveness probes that are safe on every platform.

``os.kill(pid, 0)`` is a POSIX liveness probe: it checks that the process
exists and signals nothing.  On Windows CPython maps it to
``TerminateProcess``, so the "probe" kills the very process it inspects.

Anything that polls a subprocess for liveness has to use this module instead.
"""

import os
import sys


def process_is_alive(pid: int) -> bool:
    """True when `pid` is still running.

    On POSIX this raises ProcessLookupError when the process is gone and
    PermissionError when it exists but cannot be signalled, exactly like
    ``os.kill(pid, 0)``, so existing except clauses keep working.  On Windows
    it never signals the process and simply answers the question.
    """
    if sys.platform == "win32":
        try:
            import psutil

            return psutil.pid_exists(pid)
        except Exception:
            return True
    os.kill(pid, 0)
    return True
