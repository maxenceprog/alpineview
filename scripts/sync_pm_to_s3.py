"""Syncs webapp/public/pm's coarse levels (0/1/2/3) to S3."""

from pathlib import Path
import subprocess

REPO = Path(__file__).resolve().parents[1]
LOCAL_ROOT = REPO / "webapp" / "public" / "pm"
BUCKET = "s3://lidalps3d/pm"
ENDPOINT_URL = "https://s3.sbg.io.cloud.ovh.net"
LEVELS = ("0", "1", "2", "3")

for cell_dir in sorted(LOCAL_ROOT.glob("*")):
    if not cell_dir.is_dir():
        continue
    for level in LEVELS:
        level_dir = cell_dir / level
        if not level_dir.is_dir():
            continue
        subprocess.run(
            [
                "aws", "s3", "sync", str(level_dir),
                f"{BUCKET}/{cell_dir.name}/{level}",
                "--acl", "public-read",
                "--endpoint-url", ENDPOINT_URL,
            ],
            check=True,
        )
