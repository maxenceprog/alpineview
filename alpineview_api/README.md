# alpineview-api

Tiny FastAPI server for alpineview assets: `/tiles/...`, `/buildings/...`, `/vegetation/...`.
Files are served from `ALPINEVIEW_DATA_DIR` (default `/var/lib/alpineview`), CORS restricted
to `ALPINEVIEW_ALLOWED_ORIGINS`.

## Local run

```bash
pip install -e .
ALPINEVIEW_DATA_DIR=./data uvicorn alpineviewapi.main:app --reload
```

## Deploy (VPS)

Requirements: a domain pointing to the VPS, ports 80/443 open, ansible on your machine,
and a local checkout of this repo (the playbook copies alpineview_api from it).

```bash
cd alpineview_api/deploy
cp inventory.ini.example inventory.ini   # set your VPS host
# edit the "Customize for your deployment" block at the top of vars.yml
ansible-playbook -i inventory.ini playbook.yml
```

The playbook is idempotent, re-run it after pulling updates to redeploy:

- installs nginx, certbot, python venv
- copies alpineview_api from your local checkout to `/opt/alpineview-api/src` and installs it into `/opt/alpineview-api/venv`
- systemd service `alpineview-api` (uvicorn on 127.0.0.1:8000)
- nginx reverse proxy with per-IP rate limiting
- Let's Encrypt certificate + auto-renewal (nginx reload hook)

Then upload data to `/var/lib/alpineview/{tiles,buildings,vegetation}` (rsync).
