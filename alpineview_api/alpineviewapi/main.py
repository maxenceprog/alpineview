import os
from email.utils import parsedate
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from starlette.datastructures import Headers
from starlette.staticfiles import NotModifiedResponse

DATA_DIR = Path(os.environ.get("ALPINEVIEW_DATA_DIR", "/var/lib/alpineview"))
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "ALPINEVIEW_ALLOWED_ORIGINS", "http://localhost:5173"
    ).split(",")
    if o.strip()
]
LAYERS = frozenset({"tiles", "buildings", "vegetation", "dem"})

# Assets are content-addressed by tile coordinate, so they cache hard in prod. Dev sets
# this to "no-cache" (see ../run_api) so a rebuilt tile is picked up on the next request;
# revalidation stays cheap because we answer conditional requests with a 304.
CACHE_HEADERS = {
    "Cache-Control": os.environ.get("ALPINEVIEW_CACHE_CONTROL", "public, max-age=86400")
}

# A missing DEM tile is served flat rather than 404: iTowns' ElevationLayer retries a
# failed tile and leaves a hole meanwhile, so gaps outside our coverage must be data.
# 256x256 float32 metres, matching scripts/build_dem_tiles.py.
DEM_TILE_BYTES = bytes(256 * 256 * 4)
DEM_TILE_HEADERS = {**CACHE_HEADERS, "ETag": '"empty-dem-tile"'}

app = FastAPI(title="alpineview-api", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET"],
    allow_headers=["*"],
)


def is_not_modified(response_headers: Headers, request_headers: Headers) -> bool:
    if if_none_match := request_headers.get("if-none-match"):
        etag = response_headers.get("etag")
        return etag is not None and etag in [
            tag.strip().removeprefix("W/") for tag in if_none_match.split(",")
        ]
    if_modified_since = parsedate(request_headers.get("if-modified-since", ""))
    last_modified = parsedate(response_headers.get("last-modified", ""))
    return (
        if_modified_since is not None
        and last_modified is not None
        and if_modified_since >= last_modified
    )


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/{layer}/{path:path}")
def get_asset(layer: str, path: str, request: Request):
    if layer not in LAYERS:
        raise HTTPException(status_code=404)
    root = (DATA_DIR / layer).resolve()
    file = (root / path).resolve()
    if not file.is_relative_to(root):
        raise HTTPException(status_code=404)

    if not file.is_file():
        if layer == "dem" and file.suffix == ".bil":
            headers = Headers(DEM_TILE_HEADERS)
            if is_not_modified(headers, request.headers):
                return NotModifiedResponse(headers)
            return Response(
                DEM_TILE_BYTES,
                media_type="application/octet-stream",
                headers=DEM_TILE_HEADERS,
            )
        raise HTTPException(status_code=404)

    # stat_result up front so the validators are set before we compare them.
    response = FileResponse(file, headers=CACHE_HEADERS, stat_result=file.stat())
    if is_not_modified(response.headers, request.headers):
        return NotModifiedResponse(response.headers)
    return response
