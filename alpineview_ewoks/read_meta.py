"""Read build metadata for one cell from a tiles dir's meta.jsonl:

python -m alpineview_ewoks.read_meta 969 6432
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from alpineview_ewoks.core.tiles import DEFAULT_TILES_OUT

DATE_FORMATS = ("%Y/%m/%d:%H:%M", "%Y/%m/%d")

_BOLD = "\033[1m"
_CYAN = "\033[36m"
_YELLOW = "\033[33m"
_RED = "\033[31m"
_GREEN = "\033[32m"
_RESET = "\033[0m"


def read_meta(x_km: int, y_km: int, tiles_dir: str = DEFAULT_TILES_OUT) -> list[dict]:
    """All meta.jsonl entries for cell (x_km, y_km), oldest first (one per rebuild)."""
    path = f"{tiles_dir}/meta.jsonl"
    entries = []
    with open(path) as f:
        for line in f:
            entry = json.loads(line)
            if entry["cell"] == {"x_km": x_km, "y_km": y_km}:
                entries.append(entry)
    return entries


def latest_entries(tiles_dir: str = DEFAULT_TILES_OUT) -> dict[tuple[int, int], dict]:
    """Last meta.jsonl entry per cell, keyed by (x_km, y_km)."""
    path = Path(tiles_dir) / "meta.jsonl"
    if not path.exists():
        return {}
    latest: dict[tuple[int, int], dict] = {}
    with path.open() as f:
        for line in f:
            entry = json.loads(line)
            cell = entry["cell"]
            latest[(cell["x_km"], cell["y_km"])] = entry
    return latest


def built_cells(tiles_dir: str = DEFAULT_TILES_OUT) -> set[tuple[int, int]]:
    """Cells whose latest build in meta.jsonl succeeded, as (x_km, y_km)."""
    return {
        xy
        for xy, entry in latest_entries(tiles_dir).items()
        if entry["build"]["returncode"] == 0
    }


def parse_date_filter(spec: str) -> tuple[str, datetime]:
    """Parse '>aaaa/mm/dd:hh:mm' or '<aaaa/mm/dd' into (op, UTC datetime)."""
    op, text = spec[:1], spec[1:]
    if op not in ("<", ">"):
        raise ValueError(f"Date filter must start with '<' or '>': {spec!r}")
    for fmt in DATE_FORMATS:
        try:
            when = datetime.strptime(text, fmt)
        except ValueError:
            continue
        return op, when.replace(tzinfo=timezone.utc)
    raise ValueError(f"Cannot parse date {text!r}, expected aaaa/mm/dd[:hh:mm]")


def cells_built_at(
    spec: str, tiles_dir: str = DEFAULT_TILES_OUT
) -> set[tuple[int, int]]:
    """Cells whose latest build date matches *spec*, e.g. '>2026/07/01:12:00'."""
    op, when = parse_date_filter(spec)
    matched = set()
    for xy, entry in latest_entries(tiles_dir).items():
        date = datetime.fromisoformat(entry["date"])
        if (date > when) if op == ">" else (date < when):
            matched.add(xy)
    return matched


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("x", type=int, help="Cell X in km (Lambert 93)")
    parser.add_argument("y", type=int, help="Cell Y in km (north edge)")
    parser.add_argument("--tiles-dir", default=DEFAULT_TILES_OUT)
    parser.add_argument(
        "--all",
        action="store_true",
        help="Print every rebuild, not just the latest",
    )
    args = parser.parse_args(argv)

    entries = read_meta(args.x, args.y, args.tiles_dir)
    if not entries:
        print(f"no meta.jsonl entries for cell ({args.x}, {args.y})")
        return
    for entry in entries if args.all else entries[-1:]:
        print_entry(entry)


def print_entry(entry: dict) -> None:
    cell = entry["cell"]
    build = entry["build"]
    ret = build["returncode"]
    ret_color = _GREEN if ret == 0 else _RED
    print(
        f"{_BOLD}{_CYAN}=== cell ({cell['x_km']}, {cell['y_km']}) "
        f"— {entry['date']} ==={_RESET}"
    )
    print(f"{_YELLOW}repo_commit:{_RESET} {entry['repo_commit']}")
    print(f"{_YELLOW}returncode:{_RESET} {ret_color}{ret}{_RESET}")
    print(f"{_YELLOW}command:{_RESET}")
    print("  " + " ".join(build["command"]))
    if build["stdout"]:
        print(f"{_YELLOW}stdout:{_RESET}")
        print(build["stdout"])
    if build["stderr"]:
        print(f"{_YELLOW}stderr:{_RESET}")
        print(f"{_RED}{build['stderr']}{_RESET}")


if __name__ == "__main__":
    main()
