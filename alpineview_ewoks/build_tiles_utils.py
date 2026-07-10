"""Start the servers needed by the build scripts (redis + ewoksjob)."""

from __future__ import annotations

import atexit
import os
import signal
import socket
import subprocess
import sys
import time

_REDIS_PORT = 6379
_STOP_GRACE_S = 5.0


def _redis_running() -> bool:
    try:
        with socket.create_connection(("localhost", _REDIS_PORT), timeout=1):
            return True
    except OSError:
        return False


def _spawn(cmd: list[str]) -> subprocess.Popen:
    # Own session: the terminal's Ctrl+C never reaches the servers directly,
    # only _stop() does, so shutdown is deterministic (no double signals).
    return subprocess.Popen(cmd, start_new_session=True)


def _stop(procs: list[subprocess.Popen]) -> None:
    # Uninterruptible: a late SIGTERM/SIGINT (e.g. vite killing us while we
    # already clean up after Ctrl+C) must not abort the loop halfway.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    for proc in reversed(procs):
        if proc.poll() is None:
            proc.terminate()
    deadline = time.monotonic() + _STOP_GRACE_S
    for proc in procs:
        try:
            proc.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            # Whole group: a SIGKILLed celery worker would orphan its pool.
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()


def run_servers(reload_code: bool = False) -> list[subprocess.Popen]:
    """Start redis-server, the ewoksjob monitor and one ewoksjob worker.

    Processes are stopped at interpreter exit (terminate, then kill after a
    grace period). A redis already listening on the default port is reused.

    reload_code: fork a fresh pool process per job so alpineview code edits
    are picked up on the next build (dev server); pointless for batch runs.
    """
    procs: list[subprocess.Popen] = []
    if not _redis_running():
        procs.append(_spawn(["redis-server"]))
        for _ in range(50):
            if _redis_running():
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("redis-server did not start")
    procs.append(_spawn(["ewoksjob", "--config=alpineview_ewoks.config", "monitor"]))
    worker = ["ewoksjob", "--config=alpineview_ewoks.config", "worker"]
    if reload_code:
        worker.append("--max-tasks-per-child=1")
    procs.append(_spawn(worker))
    atexit.register(_stop, procs)
    return procs


def main() -> None:
    """Run the servers until SIGTERM/SIGINT (used by the webapp dev server)."""
    run_servers(reload_code=True)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.pause()


if __name__ == "__main__":
    main()
