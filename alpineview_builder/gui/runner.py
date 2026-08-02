import logging
import subprocess
import threading
import time
from multiprocessing.pool import ThreadPool

from laz_download import DEFAULT_CACHE_DIR, download_for_pm_tile
from qtpy.QtCore import QObject, Signal
from tiles import CELL_LEVEL, LOD_LEVEL0, is_built

COARSE = "coarse"
FINE = "fine"

log = logging.getLogger("runner")


def coarse_is_built(out_dir, cell_x, cell_y):
    """A coarse job is judged by its coarsest output level, one below the cell,
    whose north-west tile is the first thing it writes."""
    level = CELL_LEVEL + 1
    return is_built(out_dir, cell_x * 2, cell_y * 2, level)


class BuildRunner(QObject):
    progress = Signal(int, int, str, float)
    message = Signal(str)
    finished = Signal(int, int, int)

    def __init__(self, paths, nproc, parent=None):
        super().__init__(parent)
        self.paths = paths
        self.nproc = nproc

        self._alive = 0
        self._done = 0
        self._ok = 0
        self._failed = 0
        self._total = 0
        self._phase = ""
        self._log_handler = None
        self._driver = None
        self._lock = threading.Lock()

    def start(self, coarse_jobs, fine_jobs, force):
        out = self.paths["out_dir"]
        if not force:
            coarse_jobs = [
                t for t in coarse_jobs if not coarse_is_built(out, t[0], t[1])
            ]
            fine_jobs = [
                t for t in fine_jobs if not is_built(out, t[0], t[1], LOD_LEVEL0)
            ]
        self._t0 = time.time()
        self._done = self._ok = self._failed = 0
        self._total = len(coarse_jobs) + len(fine_jobs)
        self.progress.emit(0, self._total, "", time.time() - self._t0)
        if not self._total:
            self.finished.emit(0, 0, 0)
            return

        self._log_handler = logging.FileHandler(self.paths["log"])
        log.addHandler(self._log_handler)
        self._driver = threading.Thread(
            target=self._drive, args=(coarse_jobs, fine_jobs), daemon=True
        )
        self._driver.start()

    def running(self):
        return self._driver is not None and self._driver.is_alive()

    def _drive(self, coarse_jobs, fine_jobs):
        """Coarse first, then fine: the two are independent, but the coarse
        pyramid is what a viewer shows while the fine levels are still being
        built, so it is worth having first."""
        for phase, jobs in ((COARSE, coarse_jobs), (FINE, fine_jobs)):
            if not jobs:
                continue
            self._phase = phase
            self._run_phase(jobs)
        if self._log_handler:
            log.removeHandler(self._log_handler)
            self._log_handler.close()
            self._log_handler = None
        self.finished.emit(self._done, self._ok, self._failed)

    def _run_phase(self, jobs):
        nworkers = max(1, min(self.nproc, len(jobs)))
        with ThreadPool(nworkers) as pool:
            for _ in pool.imap_unordered(self._build, self._tiles_to_build_iterator(jobs)):
                pass

    def _tiles_to_build_iterator(self, jobs):
        """Yield each job to build after downloading the LAZ it needs.

        Only fine (PM-tile) jobs need LiDAR HD LAZ; coarse jobs read from
        the pre-fetched RGE ALTI data_dir instead.
        """
        for job in jobs:
            if self._phase == FINE:
                x, y = job
                download_for_pm_tile(
                    x,
                    y,
                    DEFAULT_CACHE_DIR,
                    download_from_ign=True,
                )
                log.info(f"Tile {x},{y} laz files are downloaded !")
            yield job

    def _command(self, x, y):
        if self._phase == COARSE:
            return [
                self.paths["coarse"],
                str(x),
                str(y),
                "--data-dir",
                self.paths["data_dir"],
                "--out-dir",
                self.paths["out_dir"],
            ] + self.paths["coarse_args"]
        return [
            self.paths["builder"],
            str(x),
            str(y),
            "--out-dir",
            self.paths["out_dir"],
        ] + self.paths["fine_args"]

    def _build(self, job):
        x, y = job
        phase = self._phase
        level = CELL_LEVEL if phase == COARSE else LOD_LEVEL0
        cmd = self._command(x, y)
        try:
            p = subprocess.run(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
            )
            out, code = p.stdout, p.returncode
        except OSError as e:
            out, code = str(e) + "\n", -1

        log.info(
            "=== %s %d/%d/%d : %s\n%s=== %s %d/%d/%d exit %d",
            phase,
            level,
            x,
            y,
            " ".join(cmd),
            out,
            phase,
            level,
            x,
            y,
            code,
        )
        with self._lock:
            self._done += 1
            if code == 0:
                self._ok += 1
            else:
                self._failed += 1
            done, total = self._done, self._total
        self.progress.emit(done, total, phase, time.time() - self._t0)
        self.message.emit("%s %d/%d/%d exit %d" % (phase, level, x, y, code))
