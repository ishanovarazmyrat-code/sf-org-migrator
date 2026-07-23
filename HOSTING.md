# Hosting the web UI at a URL

> Looking for copy-paste, step-by-step deploy instructions (Render **or** a VM)?
> See [`DEPLOY.md`](DEPLOY.md). This page is the concept + security reference.


By default the UI is **local only** (`sf-org-migrator ui` → binds `127.0.0.1`,
no login) because it can trigger real migrations. To run it behind a URL so
others can use it in a browser, run it in **hosted mode**: this is a
**self-hosted, single-tenant** setup — you run your own instance, and your org
tokens and data stay in *your* instance. It never touches anyone else's server.

## What hosted mode changes

Set **`UI_ACCESS_KEY`** to turn it on. Then the server:

- binds to all interfaces (so a container/host can expose it), and
- requires that key on a login screen before any page or action works.

Without the key it stays the old localhost-only tool. Put the instance behind
your host's HTTPS (Render/Railway/etc. give you HTTPS automatically).

## Authorizing the two orgs

**Easiest — from the browser.** Open the deployed URL, sign in with your access
key, and use **Setup → Connect an org**: paste each org's Consumer Key (from its
one-time External Client App — see [`docs/OAUTH_SETUP.md`](docs/OAUTH_SETUP.md)),
click Connect, and approve the shown code at the Salesforce URL. No shell, no
auth URL. Approve the TARGET in a browser signed into the target org (an
incognito window is the easy way to keep the two orgs separate).

**Alternative — environment variables.** You can instead pass each org's **auth
URL** so the instance is authorized on boot:

```bash
# On a machine where you're logged in with the Salesforce CLI:
sf org display --target-org <alias> --verbose --json   # copy "sfdxAuthUrl"
```

Set the results as `SOURCE_AUTH_URL` and `TARGET_AUTH_URL` on the instance. The
tool refreshes real access tokens from them (no passwords stored). Alternative:
shell into the container and run `node cli.js login`.

## Run it with Docker

```bash
cd bulk-file-migration
docker build -t sf-org-migrator-ui .
docker run -p 4599:4599 \
  -e UI_ACCESS_KEY="choose-a-strong-key" \
  -e SOURCE_AUTH_URL="force://..." \
  -e TARGET_AUTH_URL="force://..." \
  -v "$(pwd)/work:/app/work" \
  sf-org-migrator-ui
```

Open `http://localhost:4599`, sign in with your key. The `-v …:/app/work` mount
keeps the resumable state and downloaded files across restarts.

## One-click deploy (Render)

The repo ships a [`render.yaml`](render.yaml). On [Render](https://render.com):
**New → Blueprint → pick this repo**. Render generates `UI_ACCESS_KEY` for you
(view it under the service's *Environment*); set `SOURCE_AUTH_URL` and
`TARGET_AUTH_URL` there too. You get an HTTPS URL.

## Security notes

- **Use a long, random `UI_ACCESS_KEY`.** It's the only thing between the
  internet and a migration trigger.
- Always serve over **HTTPS** (the login key is sent to the server).
- Data flows through the instance's disk while migrating — run it somewhere you
  trust, and delete the instance (and its disk) when the migration is done.
- One instance = one pair of orgs. For a true multi-tenant service where many
  customers connect their own orgs, see Phase 3 in [ROADMAP.md](ROADMAP.md).
