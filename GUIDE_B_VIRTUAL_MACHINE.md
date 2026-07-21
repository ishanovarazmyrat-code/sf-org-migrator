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
- **Disk:** free space ≥ 2× your file volume (attach a bigger disk for GBs)
- **Inbound ports:** allow **SSH (22)**

Create → **download the private key (.pem)** and keep it. Note the VM's
**Public IP**.

## Step 2 — Copy the tool to the VM

On your computer (send both the tool and the package):
```bash
zip -r ~/Downloads/bfm.zip bulk-file-migration sfdx-package \
  -x "*/node_modules/*" "*/.env" "*/work/*" "*/.mvn/*"
scp -i ~/Downloads/<your-key>.pem ~/Downloads/bfm.zip azureuser@<VM_PUBLIC_IP>:~
```

## Step 3 — Connect and run the setup script (one command)

```bash
ssh -i ~/Downloads/<your-key>.pem azureuser@<VM_PUBLIC_IP>
unzip bfm.zip
cd bulk-file-migration
bash vm-setup.sh
```
`vm-setup.sh` installs **Node 22, the Salesforce CLI, unzip, tmux**, and the
tool's dependencies — everything, in one step.

## Step 4 — Give the VM access to both orgs

> **Recommended:** use the tool's own OAuth login — on the VM run
> `node cli.js login`; it prints a URL + code you approve in the browser on
> your **own** computer (nothing needs a browser on the VM). See
> `docs/OAUTH_SETUP.md`. The auth-URL method below is the alternative.

A VM has no browser, so authorize it with an **auth URL** exported from a
machine where you're already logged in (e.g. your laptop).

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

> **Why not `sf org login`?** A headless VM can't open a browser, and recent
> CLI versions mask the token in `sf org display`, so exporting the auth URL
> from a machine that's already logged in is the reliable path. Keep these
> files private and delete them when done (they contain a refresh token).

## Step 5 — Check everything is ready

```bash
node cli.js doctor      # verify connections, fields, storage, disk
```

## Step 6 — Deploy the target-org package (once)

From the VM (the package is in the zip you copied):
```bash
sf project deploy start --source-dir ../sfdx-package/force-app --target-org targetOrg
sf org assign permset --name Migration_Access --target-org targetOrg
```
The permission set grants access to the new `Legacy_*_Id__c` fields (a freshly
deployed field is invisible without it). Skip both if you already did this
from your machine — it's once per target org.

## Step 7 — Migrate (inside tmux so it survives disconnects)

Start tmux from the shell where you set `SOURCE_AUTH_URL` / `TARGET_AUTH_URL`
(Step 4) — tmux inherits them. If you reconnect in a fresh shell later,
re-run the two `export` lines before `node cli.js migrate`.

```bash
tmux new -s mig
node cli.js migrate     # records + files, end to end
```
- Detach and leave it running: press **Ctrl-b**, then **d**. You can close
  your laptop.
- Reattach later: `tmux attach -t mig`.
- Resumable: if it stops, run `node cli.js migrate` again. Logs are in
  `work/logs/`.

## Step 8 — Cleanup / cost control

- When done and verified: **Stop (deallocate)** the VM to pause billing, or
  **Delete** it to remove everything.
- The VM holds live org sessions — keep it private and delete it when finished.

---

## Checklist before a real run
- **Target org File Storage ≥ your file volume** (Setup → Storage Usage).
- VM disk ≥ 2× the file volume.
- Files over 2 GB can't go through the API.
- Records are migrated before files (the tool's `migrate` does this for you).
