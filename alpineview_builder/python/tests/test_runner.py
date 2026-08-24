"""integration test: run runner.run_build() with a fixed job and check the .glb it must produce."""

import os
import shutil
import tempfile

from alpineview_builder.runner.runner import run_build

FINE_JOBS = [(16948, 11778)]
GLB_RELATIVE_PATH = os.path.join("1059.736", "4", "4.2.glb")


def demo():
    out_dir = tempfile.mkdtemp(prefix="test_runner_")
    try:
        params = {
            "coarse_jobs": [],
            "fine_jobs": FINE_JOBS,
            "coarse": "alpineview_coarse",
            "builder": "alpineview_builder",
            "out_dir": out_dir,
            "log": os.path.join(out_dir, "build.log"),
            "coarse_args": [],
            "fine_args": ["--max-depth", "7"],
            "nproc": 1,
            "force": True,
        }
        done, ok, failed = run_build(
            params, params["nproc"], params["coarse_jobs"], params["fine_jobs"], params["force"]
        )
        assert failed == 0, f"run_build reported {failed} failed job(s)"
        expected_glb = os.path.join(out_dir, GLB_RELATIVE_PATH)
        assert os.path.isfile(expected_glb), f"missing {expected_glb}"
        print(f"OK: {expected_glb} built ({done} jobs, {ok} ok)")
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


if __name__ == "__main__":
    demo()
