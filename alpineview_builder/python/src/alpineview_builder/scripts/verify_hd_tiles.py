"""Checks each cell's local_tileset.json against the .glb tiles actually
sitting in the cloud. A tile present under a cell's HD level dir (level 4,
= GEO.lod_level0) but missing from hdX/hdY is logged, its max zoom found by
walking the top-left descendant at local levels 5-8, and the entry added.
Updated local_tileset.json files are pushed back to S3.
"""

import json
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from tqdm import tqdm

from ..core.geo_constants import GEO
from ..tileset.build_local_tileset import (
    LOCAL_TILESET_NAME,
    LOD_LOCAL_LEVEL,
    S3_BUCKET,
    S3_ENDPOINT,
    S3_PREFIX,
    glb_bounds,
)

CHECK_LEVELS = (5, 6, 7, 8)
CHECK_WORKERS = 16


def list_cell_prefixes():
    prefixes = []
    token = None
    while True:
        cmd = [
            "aws", "s3api", "list-objects-v2",
            "--bucket", S3_BUCKET,
            "--prefix", S3_PREFIX,
            "--delimiter", "/",
            "--endpoint-url", S3_ENDPOINT,
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


def list_level_tiles(cell_prefix, level):
    """{(x, y): key} of the .glb tiles under cell_prefix{level}/."""
    tiles = {}
    token = None
    prefix = f"{cell_prefix}{level}/"
    while True:
        cmd = [
            "aws", "s3api", "list-objects-v2",
            "--bucket", S3_BUCKET,
            "--prefix", prefix,
            "--endpoint-url", S3_ENDPOINT,
        ]
        if token:
            cmd += ["--starting-token", token]
        out = json.loads(
            subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
        )
        for obj in out.get("Contents", []):
            name = Path(obj["Key"]).name
            if not name.endswith(".glb"):
                continue
            x, y = (int(v) for v in name.split(".")[:2])
            tiles[(x, y)] = obj["Key"]
        token = out.get("NextContinuationToken")
        if not token:
            break
    return tiles


def compute_missing(cloud_xy, existing_xy):
    return cloud_xy - existing_xy


def compute_max_level(x, y, level_sets):
    """Walk the top-left descendant through CHECK_LEVELS; stop at the first
    zoom whose top-left corner tile is absent."""
    level = LOD_LOCAL_LEVEL
    tlx, tly = x, y
    for lvl in CHECK_LEVELS:
        tlx, tly = tlx * 2, tly * 2
        if (tlx, tly) not in level_sets[lvl]:
            break
        level = lvl
    return level


def fetch_json(key, default):
    with tempfile.NamedTemporaryFile() as tmp:
        result = subprocess.run(
            ["aws", "s3", "cp", f"s3://{S3_BUCKET}/{key}", tmp.name,
             "--endpoint-url", S3_ENDPOINT],
            capture_output=True, check=False,
        )
        if result.returncode != 0:
            return default
        return json.loads(Path(tmp.name).read_text())


def upload_json(key, data):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as tmp:
        json.dump(data, tmp)
        tmp_path = tmp.name
    try:
        subprocess.run(
            ["aws", "s3", "cp", tmp_path, f"s3://{S3_BUCKET}/{key}",
             "--acl", "public-read", "--endpoint-url", S3_ENDPOINT],
            check=True,
        )
    finally:
        Path(tmp_path).unlink()


def download_glb(key):
    with tempfile.NamedTemporaryFile(suffix=".glb") as tmp:
        subprocess.run(
            ["aws", "s3", "cp", f"s3://{S3_BUCKET}/{key}", tmp.name,
             "--endpoint-url", S3_ENDPOINT],
            check=True, capture_output=True,
        )
        return glb_bounds(Path(tmp.name))


def check_cell(prefix):
    cx, cy = (int(v) for v in Path(prefix).name.split("."))
    n = 1 << LOD_LOCAL_LEVEL

    cloud_tiles = list_level_tiles(prefix, LOD_LOCAL_LEVEL)
    if not cloud_tiles:
        return None

    tileset_key = f"{prefix}{LOCAL_TILESET_NAME}"
    tileset = fetch_json(tileset_key, {"hdX": [], "hdY": [], "hdMaxLevel": [], "hdZHi": []})
    existing = {
        (x - cx * n, y - cy * n)
        for x, y in zip(tileset["hdX"], tileset["hdY"])
    }

    missing = compute_missing(set(cloud_tiles), existing)
    if not missing:
        return None

    print(prefix, "missing HD tile(s)", sorted(missing))
    level_sets = {lvl: set(list_level_tiles(prefix, lvl)) for lvl in CHECK_LEVELS}

    for x, y in sorted(missing):
        bounds = download_glb(cloud_tiles[(x, y)])
        if bounds is None:
            print(prefix, (x, y), "-- unreadable glb, skipping")
            continue
        local_level = compute_max_level(x, y, level_sets)
        max_level = GEO.lod_level0 + (local_level - LOD_LOCAL_LEVEL)

        tileset["hdX"].append(cx * n + x)
        tileset["hdY"].append(cy * n + y)
        tileset["hdMaxLevel"].append(max_level)
        tileset["hdZHi"].append(round(bounds[1][2]))

    upload_json(tileset_key, tileset)
    print(prefix, "-> updated", LOCAL_TILESET_NAME, "with", len(missing), "tile(s)")
    return prefix


def main():
    prefixes = list_cell_prefixes()
    print(len(prefixes), "cells found in", f"s3://{S3_BUCKET}/{S3_PREFIX}")

    with ThreadPoolExecutor(CHECK_WORKERS) as pool:
        results = tqdm(pool.map(check_cell, prefixes), total=len(prefixes), unit="cell")
        updated = [p for p in results if p is not None]

    print(len(updated), "cell(s) updated" if updated else "all cells in sync")


if __name__ == "__main__":
    main()
