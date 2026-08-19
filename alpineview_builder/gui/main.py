import logging
import os
import subprocess
import sys
import threading

from map_view import MapView
from qtpy.QtCore import QObject, Qt, Signal
from qtpy.QtWidgets import (
    QApplication,
    QCheckBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)
from runner import BuildRunner, coarse_is_built
from summary import format_summary, run_tiler, summarize
from tiles import (
    CELL_LEVEL,
    LOD_LEVEL0,
    built_tiles,
    is_built,
    tile_bounds,
    tiles_in_rect,
    tiles_in_rect_aligned,
)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.dirname(ROOT)
DEFAULT_BUILDER = os.path.join(ROOT, "build", "release", "src", "alpineview_builder")
DEFAULT_COARSE = os.path.join(ROOT, "build", "release", "src", "alpineview_coarse")
DEFAULT_DATA = os.path.join(REPO, "data")
DEFAULT_OUT = os.path.join(REPO, "webapp", "public", "pm")
DEFAULT_LOG = os.path.join(HERE, "build.log")
TILER_DIR = os.path.join(REPO, "ogc3d_tiler")
PACK_PATH = os.path.join(REPO, "webapp", "src", "terrainPack.json")
MAX_RECT_CELLS = 5000
S3_ENDPOINT = "https://s3.sbg.io.cloud.ovh.net"
S3_BUCKET = None  # "s3://lidalps3d/pm"
S3_SYNC_PERIOD_S = 60


class PostBuild(QObject):
    done = Signal(str)

    def start(self, out_dir, rect, log_path):
        threading.Thread(
            target=self._run, args=(out_dir, rect, log_path), daemon=True
        ).start()

    def _run(self, out_dir, rect, log_path):
        code, out = run_tiler(TILER_DIR, sys.executable)
        try:
            with open(log_path, "a") as f:
                f.write(f"=== build_tileset.py exit {code}\n{out}\n")
        except OSError:
            pass
        if code != 0:
            self.done.emit(f"build_tileset.py failed (exit {code}), see the log")
            return
        try:
            text = format_summary(summarize(out_dir, PACK_PATH, rect))
        except Exception as e:
            text = f"summary failed: {e}"
        self.done.emit(text)


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

        initial_built = [
            tile_bounds(x, y, LOD_LEVEL0)
            for x, y in built_tiles(DEFAULT_OUT, LOD_LEVEL0)
        ]
        self.map = MapView()
        self.map.rect_selected.connect(self.on_rect)
        self.map.draw_built(initial_built)

        self.builder_edit = QLineEdit(DEFAULT_BUILDER)
        self.coarse_edit = QLineEdit(DEFAULT_COARSE)
        self.data_edit = QLineEdit(DEFAULT_DATA)
        self.out_edit = QLineEdit(DEFAULT_OUT)
        self.log_edit = QLineEdit(DEFAULT_LOG)
        self.coarse_args_edit = QLineEdit("")
        self.fine_args_edit = QLineEdit("--max-depth 10 --verbose")
        self.nproc = QSpinBox()
        self.nproc.setRange(1, 64)
        self.nproc.setValue(max(1, (os.cpu_count() or 4)))
        self.force = QCheckBox("force rebuild")
        self.select_btn = QPushButton("Select rect")
        self.select_btn.setCheckable(True)
        self.select_btn.toggled.connect(self.map.set_select_mode)
        self.reset_btn = QPushButton("Reset")
        self.reset_btn.clicked.connect(self.on_reset)
        self.info = QLabel("drag a rectangle on the map")
        self.bar = QProgressBar()
        self.build_btn = QPushButton("Build")
        self.build_btn.setEnabled(False)
        self.build_btn.clicked.connect(self.on_build)
        self.summary = QPlainTextEdit()
        self.summary.setReadOnly(True)
        self.summary.setMaximumHeight(160)
        self.summary.setPlaceholderText("per-level summary, after build_tileset.py")
        self.post = PostBuild()
        self.s3sync = S3Sync()
        self.post.done.connect(self.on_summary, Qt.QueuedConnection)

        form = QVBoxLayout()
        form.addLayout(self._path_row("coarse", self.coarse_edit, False))
        form.addLayout(self._path_row("builder", self.builder_edit, False))
        form.addLayout(self._path_row("RGE ALTI", self.data_edit, True))
        form.addLayout(self._path_row("out dir", self.out_edit, True))
        form.addLayout(self._path_row("log file", self.log_edit, False))

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
        opts.addStretch(1)
        form.addLayout(opts)

        actions = QHBoxLayout()
        actions.addWidget(self.select_btn)
        actions.addWidget(self.reset_btn)
        actions.addWidget(self.info, 1)
        actions.addWidget(self.build_btn)

        layout = QVBoxLayout(self)
        layout.addWidget(self.map, 1)
        layout.addLayout(form)
        layout.addLayout(actions)
        layout.addWidget(self.bar)
        layout.addWidget(self.summary)

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
        self.build_btn.setEnabled(bool(self.cells) and not self.busy())

    def on_reset(self):
        self.rects = []
        self.cells = []
        self.fine = []
        self.map.draw_rects([])
        self.map.draw_tiles([])
        self.update_info()
        self.build_btn.setEnabled(False)

    def draw_built_tiles(self):
        boxes = [
            tile_bounds(x, y, LOD_LEVEL0)
            for x, y in built_tiles(self.out_edit.text(), LOD_LEVEL0)
        ]
        self.map.draw_built(boxes)

    def update_info(self):
        if not self.cells:
            self.info.setText("drag a rectangle on the map")
            return
        out = self.out_edit.text()
        xs = [c[0] for c in self.cells]
        ys = [c[1] for c in self.cells]
        built_coarse = sum(1 for c in self.cells if coarse_is_built(out, *c))
        built_fine = sum(1 for t in self.fine if is_built(out, *t, LOD_LEVEL0))
        self.info.setText(
            f"level {CELL_LEVEL}: {max(xs) - min(xs) + 1} x {max(ys) - min(ys) + 1} "
            f"= {len(self.cells)} cells (col {min(xs)}..{max(xs)}, "
            f"row {min(ys)}..{max(ys)}), {built_coarse} built"
            f"   |   level {LOD_LEVEL0}: {len(self.fine)} tiles, {built_fine} built"
        )

    def busy(self):
        return self.runner is not None and self.runner.running()

    def on_build(self):
        if self.busy() or not self.cells:
            return
        out = self.out_edit.text()
        os.makedirs(out, exist_ok=True)
        paths = {
            "coarse": self.coarse_edit.text(),
            "builder": self.builder_edit.text(),
            "data_dir": self.data_edit.text(),
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
        self.summary.setPlainText("")
        self.runner.start(self.cells, self.fine, self.force.isChecked())

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
        self.build_btn.setEnabled(bool(self.cells))
        self.update_info()
        self.draw_built_tiles()
        self.info.setText(
            self.info.text() + f"   |   ran {done}, ok {ok}, failed {failed}"
        )
        if self.rects:
            self.summary.setPlainText("running build_tileset.py ...")
            xs = [c for r in self.rects for c in (r[0], r[2])]
            ys = [c for r in self.rects for c in (r[1], r[3])]
            union_rect = (min(xs), min(ys), max(xs), max(ys))
            self.post.start(self.out_edit.text(), union_rect, self.log_edit.text())

    def on_summary(self, text):
        self.summary.setPlainText(text)


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    app = QApplication(sys.argv)
    w = Window()
    w.show()
    sys.exit(app.exec_() if hasattr(app, "exec_") else app.exec())


if __name__ == "__main__":
    main()
