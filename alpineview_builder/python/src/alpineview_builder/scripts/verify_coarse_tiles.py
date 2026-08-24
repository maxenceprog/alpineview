"""Checks that every cell already synced to the bucket has all 4 coarse
levels (0-3) built -- the assumption build_tileset_from_cloud.py's coarse
subtree bakes in (always solid tile+content across all 4 levels). Any cell
missing one writes a runner_parameters.json job list
(alpineview_builder.runner.runner's --params format) that rebuilds it.
"""

import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ..runner.runner import (
    DEFAULT_BUILDER,
    DEFAULT_COARSE,
    DEFAULT_LOG,
    DEFAULT_OUT,
)

S3_ENDPOINT = "https://s3.sbg.io.cloud.ovh.net"
S3_BUCKET = "lidalps3d"
S3_PREFIX = "pm/"

COARSE_LEVELS = (0, 1, 2, 3)
CHECK_WORKERS = 16

OUT_PARAMS_FILE = Path(__file__).resolve().parent / "verify_coarse_tiles_params.json"


def list_cell_prefixes():
    prefixes = []
    token = None
    while True:
        cmd = [
            "aws",
            "s3api",
            "list-objects-v2",
            "--bucket",
            S3_BUCKET,
            "--prefix",
            S3_PREFIX,
            "--delimiter",
            "/",
            "--endpoint-url",
            S3_ENDPOINT,
        ]
        if token:
            cmd += ["--starting-token", token]
        out = json.loads(
            subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
        )
        prefixes.extend(p["Prefix"] for p in out.get("CommonPrefixes", []))
        token = out.get("NextContinuationToken")
        if not token:
            break
    return prefixes


def level_dir_exists(cell_prefix, level):
    cmd = [
        "aws",
        "s3api",
        "list-objects-v2",
        "--bucket",
        S3_BUCKET,
        "--prefix",
        f"{cell_prefix}{level}/",
        "--max-items",
        "1",
        "--endpoint-url",
        S3_ENDPOINT,
    ]
    out = json.loads(
        subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    )
    return bool(out.get("Contents"))


def missing_levels(cell_prefix):
    with ThreadPoolExecutor(len(COARSE_LEVELS)) as pool:
        exists = list(
            pool.map(lambda lv: level_dir_exists(cell_prefix, lv), COARSE_LEVELS)
        )
    return [lv for lv, ok in zip(COARSE_LEVELS, exists) if not ok]


def main():
    prefixes = list_cell_prefixes()
    print(len(prefixes), "cells found in", f"s3://{S3_BUCKET}/{S3_PREFIX}")

    incomplete = []
    with ThreadPoolExecutor(CHECK_WORKERS) as pool:
        for prefix, missing in pool.map(lambda p: (p, missing_levels(p)), prefixes):
            if missing:
                cx, cy = (int(v) for v in Path(prefix).name.split("."))
                print(prefix, "missing level(s)", missing)
                incomplete.append((cx, cy))

    if not incomplete:
        print("all cells have coarse levels 0-3")
        return

    params = {
        "coarse_jobs": [[cx, cy] for cx, cy in sorted(incomplete)],
        "fine_jobs": [],
        "coarse": DEFAULT_COARSE,
        "builder": DEFAULT_BUILDER,
        "out_dir": DEFAULT_OUT,
        "log": DEFAULT_LOG,
        "coarse_args": [],
        "fine_args": ["--max-depth", "10", "--verbose"],
        "nproc": 4,
        "force": True,
    }
    OUT_PARAMS_FILE.write_text(json.dumps(params, indent=2))
    print(len(incomplete), "cell(s) incomplete ->", OUT_PARAMS_FILE)


if __name__ == "__main__":
    main()
