# Running sf-org-migrator on an Azure VM

Runs the migration unattended on an Azure Linux VM instead of your laptop.
The tool is the same — this is only about *where* it runs.

## Why bother

Every byte travels **source org → the machine running the tool → target org**.
Run it at home and your own connection carries the whole volume, twice. On a
laptop in Istanbul migrating between orgs hosted in the UK, a 10 GB run means
20 GB crossing Europe on a domestic line — and the measured throughput was
5–6 MB/s, about an hour.

Put the tool on a VM in the same region as the orgs and that traffic stays
inside the cloud backbone. This is the main reason to use a VM; the "survives
your laptop closing" part is a bonus.

**So pick the region deliberately.** Find your orgs' instance in each org under
Setup → Company Information → *Instance* (e.g. `GBR140` = UK, `USA1044` = US,
`EU50` = Europe), and create the VM in the matching Azure region — UK South for
GBR, West Europe for EU, East US for US. A VM on the wrong continent can be
slower than your laptop.

## 1. Create the VM (Azure Portal)

Portal → **Virtual machines** → **Create** → Azure virtual machine:

- **Region:** match your orgs (see above) — this is the decision that matters
- **Image:** Ubuntu Server 22.04 LTS
- **Size:** `B2s` (2 vCPU, 4 GB) is plenty — bandwidth matters more than CPU
- **Authentication:** SSH public key
- **Disk:** the default 30 GB is enough **if you use `--stream`** (below), which
  never writes the files to disk. Without it, files are downloaded before being
  uploaded, so you need free space ≥ your total file volume.
- **Networking:** defaults are fine — you need inbound **SSH (22)** only.
  Outbound HTTPS to Salesforce is open by default.

Note the VM's **public IP**.

## 2. SSH in

```bash
ssh azureuser@<VM_PUBLIC_IP>
```

## 3. Install Node 22 and the tool

The tool requires **Node 22+** (older versions crash on a jsforce dependency).

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs tmux
node -v            # must print v22 or higher
sudo npm install -g sf-org-migrator
```

There is nothing to copy from your laptop — the tool is on npm.

## 4. Pick a working directory

State (`work/`, `.auth/`, `migration.config.json`) lives in the directory you
run from, like git. Make one and stay in it:

```bash
mkdir ~/migration && cd ~/migration
```

## 5. Connect both orgs — no passwords

The OAuth device flow was built for exactly this: the VM has no browser, so it
prints a URL and a code that you approve in the browser **on your own machine**.

```bash
sf-org-migrator login source
sf-org-migrator login target
```

Each asks for that org's Consumer Key (see `docs/OAUTH_SETUP.md` for creating
the External Client App once per org), then prints something like:

```
[SOURCE] Open this URL and enter the code:
  https://login.salesforce.com/setup/connect
  code: ABCD-EFGH
```

Open it in a browser logged into that org — use an incognito window for the
second org so you are not still signed in as the first. Refresh tokens land in
`.auth/` (mode 600, no passwords stored).

Then confirm everything is ready:

```bash
sf-org-migrator doctor
```

## 6. Run it inside tmux, so it survives your SSH dropping

```bash
tmux new -s mig
sf-org-migrator stats            # read-only: how many files, how big
sf-org-migrator migrate --stream # records + files, no disk round trip
```

Detach and leave it running: **Ctrl-b** then **d**. Close your laptop. Come
back with `tmux attach -t mig`.

Drop `--stream` if you would rather keep per-file resumability: with the disk
path an interrupted transfer resumes mid-run, while streaming restarts the file
it was on. Streaming's win is needing no disk and one network hop instead of
two — on a well-placed VM that is usually the better trade for a large run.

## 7. Monitor and resume

Every phase is resumable. If anything interrupts, re-run the same command and
it continues from the manifest.

```bash
sf-org-migrator verify     # counts, bytes, current state
sf-org-migrator failures   # what failed, grouped by cause, and what to re-run
```

## 8. Cleanup

When `verify` shows everything uploaded and linked, and you have confirmed the
records in the target org: **delete the VM.** That removes `.auth/` and `work/`
with it and stops the billing.

Deleting the VM alone does not revoke access. The refresh tokens in `.auth/`
stay valid until you revoke them — do that in each org under Setup → Connected
Apps OAuth Usage, or delete the External Client App you created for the
migration.
