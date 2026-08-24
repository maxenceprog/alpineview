import json
import logging
import os
import subprocess
import sys
import threading

from qtpy.QtCore import QObject, Qt
from qtpy.QtWidgets import (
    QApplication,
    QCheckBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QProgressBar,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from ..core.tiles import (
    CELL_LEVEL,
    LOD_LEVEL0,
    tile_bounds,
    tiles_in_rect,
    tiles_in_rect_aligned,
)
from ..runner.runner import BuildRunner
from ..scripts.summary import hd_tiles, pack_cells
from .map_view import MapView

HERE = os.path.dirname(os.path.abspath(__file__))
_PKG = os.path.dirname(HERE)
_SRC = os.path.dirname(_PKG)
_PROJECT = os.path.dirname(_SRC)
ROOT = os.path.dirname(_PROJECT)
REPO = os.path.dirname(ROOT)
DEFAULT_BUILDER = os.path.join(ROOT, "build", "release", "src", "alpineview_builder")
DEFAULT_COARSE = os.path.join(ROOT, "build", "release", "src", "alpineview_coarse")
DEFAULT_OUT = os.path.join(REPO, "webapp", "public", "pm")
DEFAULT_LOG = os.path.join(HERE, "build.log")
DEFAULT_PARAMS_FILE = os.path.join(HERE, "runner_parameters.json")
PACK_PATH = os.path.join(REPO, "webapp", "src", "terrainPack.json")
MAX_RECT_CELLS = 5000
S3_ENDPOINT = "https://s3.sbg.io.cloud.ovh.net"
S3_BUCKET = None  # "s3://lidalps3d/pm"
S3_SYNC_PERIOD_S = 60


class S3Sync(QObject):
    def start(self, out_dir, log_path):
        self.stop_event = threading.Event()
        self.thread = threading.Thread(
            target=self._run, args=(out_dir, log_path), daemon=True
        )
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.thread.join()

    def _run(self, out_dir, log_path):
        if S3_BUCKET is None:
            return
        while True:
            sync = subprocess.run(
                [
                    "aws",
                    "s3",
                    "sync",
                    out_dir,
                    S3_BUCKET,
                    "--acl",
                    "public-read",
                    "--endpoint-url",
                    S3_ENDPOINT,
                    "--exclude",
                    "*",
                    "--include",
                    "*.glb",
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            try:
                with open(log_path, "a") as f:
                    f.write(
                        f"=== s3 sync exit {sync.returncode}\n"
                        f"{sync.stdout}\n{sync.stderr}\n"
                    )
            except OSError:
                pass
            if self.stop_event.wait(S3_SYNC_PERIOD_S):
                return


class Window(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("alpineview builder")
        self.resize(1100, 900)
        self.rects = []
        self.cells = []
        self.fine = []
        self.runner = None

        self.map = MapView()
        self.map.rect_selected.connect(self.on_rect)
        self.draw_built_tiles()

        self.builder_edit = QLineEdit(DEFAULT_BUILDER)
        self.coarse_edit = QLineEdit(DEFAULT_COARSE)
        self.out_edit = QLineEdit(DEFAULT_OUT)
        self.log_edit = QLineEdit(DEFAULT_LOG)
        self.coarse_args_edit = QLineEdit("")
        self.fine_args_edit = QLineEdit("--max-depth 10 --verbose")
        self.nproc = QSpinBox()
        self.nproc.setRange(1, 64)
        self.nproc.setValue(max(1, (os.cpu_count() or 4)))
        self.force = QCheckBox("force rebuild")
        self.build_coarse = QCheckBox(f"build level {CELL_LEVEL}")
        self.build_coarse.setChecked(True)
        self.build_fine = QCheckBox(f"build level {LOD_LEVEL0}")
        self.build_fine.setChecked(True)
        self.select_btn = QPushButton("Select rect")
        self.select_btn.setCheckable(True)
        self.select_btn.toggled.connect(self.map.set_select_mode)
        self.reset_btn = QPushButton("Reset")
        self.reset_btn.clicked.connect(self.on_reset)
        self.info = QLabel("drag a rectangle on the map")
        self.bar = QProgressBar()
        self.params_file_edit = QLineEdit(DEFAULT_PARAMS_FILE)
        self.list_btn = QPushButton("Create build list")
        self.list_btn.setEnabled(False)
        self.list_btn.clicked.connect(self.on_create_list)
        self.build_btn = QPushButton("Build")
        self.build_btn.setEnabled(False)
        self.build_btn.clicked.connect(self.on_build)
        self.s3sync = S3Sync()

        form = QVBoxLayout()
        form.addLayout(self._path_row("coarse", self.coarse_edit, False))
        form.addLayout(self._path_row("builder", self.builder_edit, False))
        form.addLayout(self._path_row("out dir", self.out_edit, True))
        form.addLayout(self._path_row("log file", self.log_edit, False))
        form.addLayout(self._path_row("params file", self.params_file_edit, False))

        args = QHBoxLayout()
        args.addWidget(QLabel(f"level {CELL_LEVEL} args"))
        args.addWidget(self.coarse_args_edit, 1)
        args.addWidget(QLabel(f"level {LOD_LEVEL0} args"))
        args.addWidget(self.fine_args_edit, 1)
        form.addLayout(args)

        opts = QHBoxLayout()
        opts.addWidget(QLabel("processes"))
        opts.addWidget(self.nproc)
        opts.addWidget(self.force)
        opts.addWidget(self.build_coarse)
        opts.addWidget(self.build_fine)
        opts.addStretch(1)
        form.addLayout(opts)

        actions = QHBoxLayout()
        actions.addWidget(self.select_btn)
        actions.addWidget(self.reset_btn)
        actions.addWidget(self.info, 1)
        actions.addWidget(self.list_btn)
        actions.addWidget(self.build_btn)

        layout = QVBoxLayout(self)
        layout.addWidget(self.map, 1)
        layout.addLayout(form)
        layout.addLayout(actions)
        layout.addWidget(self.bar)

    def _path_row(self, label, edit, is_dir):
        row = QHBoxLayout()
        row.addWidget(QLabel(label))
        row.addWidget(edit, 1)
        btn = QPushButton("...")
        btn.setFixedWidth(30)
        btn.clicked.connect(lambda: self._browse(edit, is_dir))
        row.addWidget(btn)
        return row

    def _browse(self, edit, is_dir):
        if is_dir:
            p = QFileDialog.getExistingDirectory(self, "directory", edit.text())
        else:
            p = QFileDialog.getSaveFileName(self, "file", edit.text())[0]
        if p:
            edit.setText(p)

    def on_rect(self, lon0, lat0, lon1, lat1):
        self.select_btn.setChecked(False)
        west, east = min(lon0, lon1), max(lon0, lon1)
        south, north = min(lat0, lat1), max(lat0, lat1)
        new_cells = tiles_in_rect(west, south, east, north, CELL_LEVEL)
        if len(new_cells) > MAX_RECT_CELLS:
            self.info.setText(
                f"rect too big: {len(new_cells)} cells (max {MAX_RECT_CELLS}), not added"
            )
            return
        new_fine = tiles_in_rect_aligned(
            west, south, east, north, LOD_LEVEL0, LOD_LEVEL0 - 1
        )
        self.rects.append((west, south, east, north))
        self.cells = list(dict.fromkeys(self.cells + new_cells))
        self.fine = list(dict.fromkeys(self.fine + new_fine))
        self.map.draw_rects(self.rects)
        self.map.draw_tiles([tile_bounds(x, y, CELL_LEVEL) for x, y in self.cells])
        self.update_info()
        self.list_btn.setEnabled(bool(self.cells) and not self.busy())
        self.build_btn.setEnabled(bool(self.cells) and not self.busy())

    def on_reset(self):
        self.rects = []
        self.cells = []
        self.fine = []
        self.map.draw_rects([])
        self.map.draw_tiles([])
        self.update_info()
        self.list_btn.setEnabled(False)
        self.build_btn.setEnabled(False)

    def _pack_cells(self):
        try:
            return pack_cells(PACK_PATH)
        except (OSError, ValueError):
            return {}

    def _hd_tiles(self):
        try:
            level, tiles = hd_tiles(PACK_PATH)
            return level, set(tiles)
        except (OSError, ValueError, KeyError):
            return LOD_LEVEL0, set()

    def _built_cell_boxes(self):
        cells = self._pack_cells()
        level, tiles = self._hd_tiles()
        hd = [tile_bounds(x, y, level) for x, y in tiles]
        coarse = [tile_bounds(cx, cy, CELL_LEVEL) for cx, cy in cells]
        return hd, coarse

    def draw_built_tiles(self):
        hd, coarse = self._built_cell_boxes()
        self.map.draw_built(hd)
        self.map.draw_built_coarse(coarse)

    def update_info(self):
        if not self.cells:
            self.info.setText("drag a rectangle on the map")
            return
        cells = self._pack_cells()
        level, tiles = self._hd_tiles()
        xs = [c[0] for c in self.cells]
        ys = [c[1] for c in self.cells]
        built_coarse = sum(1 for c in self.cells if c in cells)
        built_fine = sum(1 for t in self.fine if t in tiles) if level == LOD_LEVEL0 else 0
        self.info.setText(
            f"level {CELL_LEVEL}: {max(xs) - min(xs) + 1} x {max(ys) - min(ys) + 1} "
            f"= {len(self.cells)} cells (col {min(xs)}..{max(xs)}, "
            f"row {min(ys)}..{max(ys)}), {built_coarse} built"
            f"   |   level {LOD_LEVEL0}: {len(self.fine)} tiles, {built_fine} built"
        )

    def busy(self):
        return self.runner is not None and self.runner.running()

    def _params(self):
        return {
            "coarse_jobs": self.cells if self.build_coarse.isChecked() else [],
            "fine_jobs": self.fine if self.build_fine.isChecked() else [],
            "coarse": self.coarse_edit.text(),
            "builder": self.builder_edit.text(),
            "out_dir": self.out_edit.text(),
            "log": self.log_edit.text(),
            "coarse_args": self.coarse_args_edit.text().split(),
            "fine_args": self.fine_args_edit.text().split(),
            "nproc": self.nproc.value(),
            "force": self.force.isChecked(),
        }

    def on_create_list(self):
        if not self.cells:
            return
        params_file = self.params_file_edit.text()
        with open(params_file, "w") as f:
            json.dump(self._params(), f, indent=2)
        self.info.setText(self.info.text() + f"   |   wrote {params_file}")

    def on_build(self):
        if self.busy() or not self.cells:
            return
        out = self.out_edit.text()
        os.makedirs(out, exist_ok=True)
        paths = {
            "coarse": self.coarse_edit.text(),
            "builder": self.builder_edit.text(),
            "out_dir": out,
            "log": self.log_edit.text(),
            "coarse_args": self.coarse_args_edit.text().split(),
            "fine_args": self.fine_args_edit.text().split(),
        }
        self.runner = BuildRunner(paths, self.nproc.value())
        self.runner.progress.connect(self.on_progress, Qt.QueuedConnection)
        self.runner.finished.connect(self.on_finished, Qt.QueuedConnection)
        self.s3sync.start(out, self.log_edit.text())
        self.build_btn.setEnabled(False)
        coarse_jobs = self.cells if self.build_coarse.isChecked() else []
        fine_jobs = self.fine if self.build_fine.isChecked() else []
        self.runner.start(coarse_jobs, fine_jobs, self.force.isChecked())

    def on_progress(self, done, total, phase, dtime):
        self.bar.setMaximum(max(1, total))
        self.bar.setValue(done)
        label = {"coarse": f"level {CELL_LEVEL}", "fine": f"level {LOD_LEVEL0}"}
        mean = dtime / (done + 0.000000001)
        self.bar.setFormat(
            f"{done} / {total} jobs  {label.get(phase, '')} "
            f"(total time {dtime:.2f} / mean per tile {mean:.2f})"
        )

    def on_finished(self, done, ok, failed):
        self.s3sync.stop()
        self.list_btn.setEnabled(bool(self.cells))
        self.build_btn.setEnabled(bool(self.cells))
        self.update_info()
        self.draw_built_tiles()
        self.info.setText(
            self.info.text() + f"   |   ran {done}, ok {ok}, failed {failed}"
        )


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    app = QApplication(sys.argv)
    w = Window()
    w.show()
    sys.exit(app.exec_() if hasattr(app, "exec_") else app.exec())


if __name__ == "__main__":
    main()
