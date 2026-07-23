# Deploying the migration UI at a URL

The web UI runs in **hosted mode** whenever you set `UI_ACCESS_KEY`. That works
on **any host that runs Node** — Render, a cloud VM, or your own server. Render
is just the easy button; **it is not required.** Pick **one** of the three
setups below. They all give you the same result: a URL + an access key. Then
everyone follows the same **Use it** steps at the bottom.

**You need, either way:**
- The repo: <https://github.com/ishanovarazmyrat-code/sf-org-migrator>
- One External Client App (Consumer Key) per org — see [`docs/OAUTH_SETUP.md`](docs/OAUTH_SETUP.md)
- Enough File Storage in the target org for your files

---

## Option A — Render (easiest, no server to manage)

1. Go to <https://render.com> and sign in.
2. **New → Blueprint**.
3. Under **Public Git Repository**, paste:
   `https://github.com/ishanovarazmyrat-code/sf-org-migrator`
4. **Continue → Apply**. Render reads `render.yaml` and deploys.
5. Open the service → **Environment** tab → copy the auto-generated `UI_ACCESS_KEY`.
6. Your URL is at the top of the service page (`https://….onrender.com`).

> `render.yaml` keeps a 10 GB persistent disk, which requires a **paid** instance
> — the right choice for real GB-scale migrations. Remove the `disk:` block for a
> free, ephemeral deploy (migrations still work; a restart loses in-progress state).

---

## Option B — Your own VM / server, with Docker

Works on any provider (Azure, AWS, GCP, Hetzner, …). This is the direct
replacement for the old "run it on a VM" approach — same result as Render, you
just manage the box.

```bash
# On the VM (Ubuntu example) — install Docker if needed:
sudo apt-get update && sudo apt-get install -y docker.io git
sudo systemctl enable --now docker

# Get the code and build the image:
git clone https://github.com/ishanovarazmyrat-code/sf-org-migrator.git
cd sf-org-migrator/bulk-file-migration
sudo docker build -t org-migrator .

# Run it (choose a strong key; the volume keeps resumable state):
sudo docker run -d --restart unless-stopped \
  -p 80:4599 \
  -e UI_ACCESS_KEY="pick-a-long-random-key" \
  -v /opt/migrator-work:/app/work \
  --name org-migrator \
  org-migrator
```

Open `http://<your-VM-public-IP>` and sign in with the key.
For HTTPS, put it behind a reverse proxy (Caddy/Nginx) or a load balancer.

---

## Option C — Your own VM / server, without Docker (plain Node)

```bash
# Needs Node.js 22+ on the VM.
git clone https://github.com/ishanovarazmyrat-code/sf-org-migrator.git
cd sf-org-migrator/bulk-file-migration
npm ci --omit=dev

# Start hosted mode (binds all interfaces because UI_ACCESS_KEY is set):
UI_ACCESS_KEY="pick-a-long-random-key" UI_PORT=4599 node cli.js ui
```

Open `http://<your-VM-public-IP>:4599`. Keep it running after logout with
`tmux`/`screen` or a systemd service.

---

## Use it (same for every option, works from anywhere)

1. Open the URL, sign in with the access key.
2. **Setup → Connect an org → Connect SOURCE:** paste the source org's Consumer
   Key → **Connect** → approve the shown code at the Salesforce URL, in a browser
   logged into the **source** org.
3. **Connect TARGET** the same way — this can be done by a **different person,
   anywhere**, in a browser logged into the **target** org.
   *(Nobody ever shares a password — each side approves its own org.)*
4. **Objects & Fields → Load objects** → pick what to migrate → **Save**.
5. **Run → "Run full migration"** (Records → Files → Verify). The work runs
   **on the host, not on anyone's laptop** — you can close the tab and it keeps going.
6. When done, **delete the instance/VM** to wipe tokens and downloaded files.

---

## Render vs. VM — which to pick

| | Render | Your own VM |
|---|---|---|
| Setup speed | Fastest (blueprint) | You provision the box |
| HTTPS | Free, automatic | You set it up (proxy/LB) |
| Persistent disk | Paid instance | Any size you attach |
| Control / provider choice | Limited | Full (any cloud) |

Both are **optional**. Hosted mode is just **"Node + `UI_ACCESS_KEY`"** running
anywhere you like. See [`HOSTING.md`](HOSTING.md) for the security notes.
