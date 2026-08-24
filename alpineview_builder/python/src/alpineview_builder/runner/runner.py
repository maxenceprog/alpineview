import logging
import os
import subprocess
import threading
import time
from multiprocessing.pool import ThreadPool

from ..core.laz_download import DEFAULT_CACHE_DIR, download_for_pm_tile
from ..core.tiles import CELL_LEVEL, LOD_LEVEL0, is_built

COARSE = "coarse"
FINE = "fine"

log = logging.getLogger("runner")

HERE = os.path.dirname(os.path.abspath(__file__))
_PKG = os.path.dirname(HERE)
_SRC = os.path.dirname(_PKG)
_PROJECT = os.path.dirname(_SRC)
ROOT = os.path.dirname(_PROJECT)
REPO = os.path.dirname(ROOT)
DEFAULT_BUILDER = "alpineview_builder"
DEFAULT_COARSE = "alpineview_coarse"
DEFAULT_OUT = os.path.join(REPO, "webapp", "public", "pm")
DEFAULT_LOG = os.path.join(HERE, "build.log")


def coarse_is_built(out_dir, cell_x, cell_y):
    """A coarse job is judged by its coarsest output level, one below the cell,
    whose north-west tile is the first thing it writes."""
    level = CELL_LEVEL + 1
    return is_built(out_dir, cell_x * 2, cell_y * 2, level)


def _tiles_to_build_iterator(phase, jobs):
    """Yield each job to build after downloading the LAZ it needs.

    Only fine (PM-tile) jobs need LiDAR HD LAZ; coarse jobs fetch their own
    elevation WMTS tiles inside alpineview_coarse itself.
    """
    for job in jobs:
        if phase == FINE:
            x, y = job
            download_for_pm_tile(x, y, DEFAULT_CACHE_DIR, download_from_ign=True)
            log.info(f"Tile {x},{y} laz files are downloaded !")
        yield job


def _command(paths, phase, x, y):
    if phase == COARSE:
        return [
            paths["coarse"],
            str(x),
            str(y),
            "--out-dir",
            paths["out_dir"],
        ] + paths["coarse_args"]
    return [
        paths["builder"],
        str(x),
        str(y),
        "--out-dir",
        paths["out_dir"],
    ] + paths["fine_args"]


def run_build(
    paths, nproc, coarse_jobs, fine_jobs, force, on_progress=None, on_message=None
):
    """Build coarse jobs then fine jobs (coarse first: it is what a viewer
    shows while the fine levels are still being built). Returns (done, ok, failed).
    """
    on_progress = on_progress or (lambda *a: None)
    on_message = on_message or (lambda *a: None)
    out = paths["out_dir"]
    if not force:
        coarse_jobs = [t for t in coarse_jobs if not coarse_is_built(out, t[0], t[1])]
        fine_jobs = [t for t in fine_jobs if not is_built(out, t[0], t[1], LOD_LEVEL0)]

    t0 = time.time()
    total = len(coarse_jobs) + len(fine_jobs)
    on_progress(0, total, "", 0.0)
    if not total:
        return 0, 0, 0

    log_handler = logging.FileHandler(paths["log"])
    log.addHandler(log_handler)
    lock = threading.Lock()
    state = {"done": 0, "ok": 0, "failed": 0}

    def build_one(phase, job):
        x, y = job
        level = CELL_LEVEL if phase == COARSE else LOD_LEVEL0
        cmd = _command(paths, phase, x, y)
        try:
            p = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                check=False,
            )
            out_text, code = p.stdout, p.returncode
        except OSError as e:
            out_text, code = str(e) + "\n", -1

        log.info(
            "=== %s %d/%d/%d : %s\n%s=== %s %d/%d/%d exit %d",
            phase,
            level,
            x,
            y,
            " ".join(cmd),
            out_text,
            phase,
            level,
            x,
            y,
            code,
        )
        with lock:
            state["done"] += 1
            state["ok" if code == 0 else "failed"] += 1
            done = state["done"]
        on_progress(done, total, phase, time.time() - t0)
        on_message(f"{phase} {level}/{x}/{y} exit {code}")

    for phase, jobs in ((COARSE, coarse_jobs), (FINE, fine_jobs)):
        if not jobs:
            continue
        nworkers = max(1, min(nproc, len(jobs)))
        with ThreadPool(nworkers) as pool:
            for _ in pool.imap_unordered(
                lambda job, phase=phase: build_one(phase, job),
                _tiles_to_build_iterator(phase, jobs),
            ):
                pass

    log.removeHandler(log_handler)
    log_handler.close()
    return state["done"], state["ok"], state["failed"]


class BuildRunner:
    """Qt wrapper: runs run_build() on a background thread and reports back
    through signals, for the GUI. Lazily imports qtpy so this module stays
    importable (and its CLI usable) without Qt installed."""

    def __init__(self, paths, nproc):
        from qtpy.QtCore import QObject, Signal

        class _Signals(QObject):
            progress = Signal(int, int, str, float)
            message = Signal(str)
            finished = Signal(int, int, int)

        self._signals = _Signals()
        self.progress = self._signals.progress
        self.message = self._signals.message
        self.finished = self._signals.finished
        self.paths = paths
        self.nproc = nproc
        self._driver = None

    def start(self, coarse_jobs, fine_jobs, force):
        self._driver = threading.Thread(
            target=self._run, args=(coarse_jobs, fine_jobs, force), daemon=True
        )
        self._driver.start()

    def running(self):
        return self._driver is not None and self._driver.is_alive()

    def _run(self, coarse_jobs, fine_jobs, force):
        done, ok, failed = run_build(
            self.paths,
            self.nproc,
            coarse_jobs,
            fine_jobs,
            force,
            on_progress=self.progress.emit,
            on_message=self.message.emit,
        )
        self.finished.emit(done, ok, failed)


def _cli(argv=None):
    """Standalone entry point: build every tile in a job list, from a
    parameters JSON file written by the GUI's "create build list" button (or
    by hand), with no GUI involved.

        python -m alpineview_builder.runner.runner --params runner_parameters.json

    The JSON holds: coarse_jobs, fine_jobs (lists of [x, y] pairs), builder,
    coarse, out_dir, log, coarse_args (list), fine_args (list), nproc, force.
    Every key but coarse_jobs/fine_jobs is optional and falls back to the
    GUI's own default.
    """
    import argparse
    import json
    import sys

    p = argparse.ArgumentParser(description=_cli.__doc__)
    p.add_argument(
        "--params", required=True, help="path to a runner parameters JSON file"
    )
    args = p.parse_args(sys.argv[1:] if argv is None else argv)

    with open(args.params) as f:
        params = json.load(f)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    paths = {
        "coarse": params.get("coarse", DEFAULT_COARSE),
        "builder": params.get("builder", DEFAULT_BUILDER),
        "out_dir": params.get("out_dir", DEFAULT_OUT),
        "log": params.get("log", DEFAULT_LOG),
        "coarse_args": params.get("coarse_args", []),
        "fine_args": params.get("fine_args", ["--max-depth", "10", "--verbose"]),
    }
    nproc = params.get("nproc", max(1, os.cpu_count() or 4))
    force = params.get("force", False)

    os.makedirs(paths["out_dir"], exist_ok=True)
    coarse_jobs = [tuple(t) for t in params["coarse_jobs"]]
    fine_jobs = [tuple(t) for t in params["fine_jobs"]]
    done, ok, failed = run_build(
        paths,
        nproc,
        coarse_jobs,
        fine_jobs,
        force,
        on_progress=lambda done, total, phase, dtime: print(
            f"{done}/{total} {phase}", flush=True
        ),
        on_message=lambda text: print(text, flush=True),
    )
    print(f"ran {done}, ok {ok}, failed {failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    import sys

    sys.exit(_cli())
