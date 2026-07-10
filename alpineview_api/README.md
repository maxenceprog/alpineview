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

Requirements: a domain pointing to the VPS, ports 80/443 open, ansible on your machine.

```bash
cd deploy
cp inventory.ini.example inventory.ini   # set your VPS host
# edit vars.yml: api_domain, repo_url, allowed_origins
ansible-playbook -i inventory.ini playbook.yml
```

The playbook is idempotent, re-run it to update the API (it reinstalls from git):

- installs nginx, certbot, python venv
- installs the package from the git repo into `/opt/alpineview-api/venv`
- systemd service `alpineview-api` (uvicorn on 127.0.0.1:8000)
- nginx reverse proxy with per-IP rate limiting
- Let's Encrypt certificate + auto-renewal (nginx reload hook)

Then upload data to `/var/lib/alpineview_ewoks/{tiles,buildings,vegetation}` (rsync).
