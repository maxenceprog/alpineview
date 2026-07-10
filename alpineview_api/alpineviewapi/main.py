import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

DATA_DIR = Path(os.environ.get("ALPINEVIEW_DATA_DIR", "/var/lib/alpineview"))
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("ALPINEVIEW_ALLOWED_ORIGINS", "http://localhost:5173").split(",")
    if o.strip()
]
LAYERS = frozenset({"tiles", "buildings", "vegetation"})
CACHE_HEADERS = {"Cache-Control": "public, max-age=86400"}

app = FastAPI(title="alpineview-api", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/{layer}/{path:path}")
def get_asset(layer: str, path: str):
    if layer not in LAYERS:
        raise HTTPException(status_code=404)
    root = (DATA_DIR / layer).resolve()
    file = (root / path).resolve()
    if not file.is_relative_to(root) or not file.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(file, headers=CACHE_HEADERS)
