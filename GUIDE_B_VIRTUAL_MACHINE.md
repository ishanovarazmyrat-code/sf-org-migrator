# Guide B — Migration Using a Virtual Machine (Azure)

Run the migration on a cloud VM instead of your laptop. Best for large volumes
or long runs — it keeps going unattended, and your computer can be off.

## What you'll do

Create a small Linux VM, run one setup script on it, log in to both orgs, and
migrate. No Connected App, no Named Credential, no passwords in files.

---

## Step 1 — Create the VM (Azure Portal)

Portal → **Virtual machines** → **Create** → Azure virtual machine:
- **Image:** Ubuntu Server 22.04 or 24.04 LTS
- **Size:** `B2s` (2 vCPU) is enough
- **Authentication:** SSH public key, **Username:** `azureuser`
- **Disk:** free space ≥ 2× your file volume (attach a bigger disk for GBs),
  or keep the default and run with `--stream`, which never writes files to disk
- **Region:** match your orgs' instance (Setup → Company Information →
  *Instance*: `GBR140` = UK, `EU50` = Europe, `USA1044` = US). Every byte goes
  source org → VM → target org, so a VM on the wrong continent can be slower
  than your laptop.
- **Inbound ports:** allow **SSH (22)**

Create → **download the private key (.pem)** and keep it. Note the VM's
**Public IP**.

## Step 2 — Connect and install

The tool is on npm, so there is nothing to copy from your computer:

```bash
ssh -i ~/Downloads/<your-key>.pem azureuser@<VM_PUBLIC_IP>
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs tmux
sudo npm install -g sf-org-migrator
```

State (`work/`, `.auth/`, config) lives in the directory you run from, so make
one and stay in it:

```bash
mkdir ~/migration && cd ~/migration
```

> **Working from a clone instead?** If you want the repo itself on the VM — to
> deploy `sfdx-package`, or to run an unreleased change — copy it over and use
> `vm-setup.sh`, which installs Node 22, the Salesforce CLI, unzip, tmux and
> the dependencies in one step:
> ```bash
> zip -r ~/Downloads/bfm.zip bulk-file-migration sfdx-package \
>   -x "*/node_modules/*" "*/.env" "*/work/*" "*/.mvn/*"
> scp -i ~/Downloads/<your-key>.pem ~/Downloads/bfm.zip azureuser@<VM_PUBLIC_IP>:~
> ```
> then on the VM: `unzip bfm.zip && cd bulk-file-migration && bash vm-setup.sh`

## Step 3 — Give the VM access to both orgs

Use the tool's own OAuth device flow — it was built for a headless machine:

```bash
sf-org-migrator login source
sf-org-migrator login target
```

Each prints a URL and a code that you approve in the browser on your **own**
computer; nothing needs a browser on the VM. Use an incognito window for the
second org so you are not still signed in as the first. Tokens land in
`.auth/` (mode 600, no passwords). One-time External Client App setup:
`docs/OAUTH_SETUP.md`.

### Alternative: an auth URL exported from your laptop

Only needed if you would rather reuse a Salesforce CLI login than create the
External Client App.

On your **laptop**, export each org's auth URL and copy them to the VM:
```bash
sf org display --target-org sourceOrg --verbose --json | \
  python3 -c "import sys,json;print(json.load(sys.stdin)['result']['sfdxAuthUrl'])" > ~/src-auth.txt
sf org display --target-org targetOrg --verbose --json | \
  python3 -c "import sys,json;print(json.load(sys.stdin)['result']['sfdxAuthUrl'])" > ~/tgt-auth.txt
scp -i ~/Downloads/<your-key>.pem ~/src-auth.txt ~/tgt-auth.txt azureuser@<VM_PUBLIC_IP>:~
```

On the **VM**, point the tool at them (the tool refreshes a fresh token from
these — no password stored):
```bash
export SOURCE_AUTH_URL=$(cat ~/src-auth.txt)
export TARGET_AUTH_URL=$(cat ~/tgt-auth.txt)
```

> Keep these files private and delete them when done — they contain a refresh
> token.

## Step 4 — Check everything is ready

```bash
sf-org-migrator doctor      # verify connections, fields, storage, disk
```

## Step 5 — Install the package in the target org (once)

The target org needs the `Legacy_*_Id__c` external Id fields the migration
upserts on. Install the package from any browser — no VM involved:

> https://login.salesforce.com/packaging/installPackage.apexp?p0=04tJ6000000pGxpIAE

(For a sandbox, swap `login` for `test`.) Then assign the permission set to
whoever runs the migration — a freshly installed field is invisible without it,
and the batches now stop with a clear message rather than migrating nothing:

```bash
sf org assign permset --name Migration_Access --target-org targetOrg
```

Once per target org. Skip if you already did it from your own machine.

## Step 6 — Migrate (inside tmux so it survives disconnects)

```bash
tmux new -s mig
sf-org-migrator migrate --stream    # records + files, no local disk
```

Drop `--stream` to keep per-file resumability at the cost of needing disk for
the whole volume. If you used the auth-URL alternative in Step 3, start tmux
from the shell where you set the two variables — tmux inherits them, and a
fresh shell later needs the `export` lines again. The OAuth login has no such
catch: `.auth/` is on disk.
- Detach and leave it running: press **Ctrl-b**, then **d**. You can close
  your laptop.
- Reattach later: `tmux attach -t mig`.
- Resumable: if it stops, run `sf-org-migrator migrate` again. Logs are in
  `work/logs/`.

## Step 7 — Cleanup / cost control

- When done and verified: **Stop (deallocate)** the VM to pause billing, or
  **Delete** it to remove everything.
- The VM holds live org sessions — keep it private and delete it when finished.

---

## Checklist before a real run
- **Target org File Storage ≥ your file volume** (Setup → Storage Usage).
- VM disk ≥ 2× the file volume — or use `--stream`, which needs none.
- VM region matches the orgs' instance.
- Files over 2 GB can't go through the API.
- Records are migrated before files (the tool's `migrate` does this for you).
