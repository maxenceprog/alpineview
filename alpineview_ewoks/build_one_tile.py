"""Build a single (x, y) cell:

python -m alpineview_ewoks.build_one_tile 969 6432
"""

from __future__ import annotations

import argparse
import logging

from . import build_tiles_utils, client
from .core.tiles import delete_cell_outputs


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("x", type=int, help="Cell X in km (Lambert 93)")
    parser.add_argument("y", type=int, help="Cell Y in km (north edge)")
    parser.add_argument(
        "--no-servers",
        action="store_true",
        help="Assume redis + ewoksjob are already running",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO)

    if not args.no_servers:
        build_tiles_utils.run_servers()
    delete_cell_outputs(args.x, args.y)
    result = client.submit_build_tile(args.x, args.y, True, True)
    print(result)


if __name__ == "__main__":
    main()
