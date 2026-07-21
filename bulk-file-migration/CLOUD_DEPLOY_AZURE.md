# Running bulk-file-migration on an Azure VM

Runs the large-file migration unattended on an Azure Linux VM, so it doesn't
depend on your laptop. The tool itself is unchanged — this is just where it runs.

## 1. Create the VM (Azure Portal)

Portal → **Virtual machines** → **Create** → Azure virtual machine:
- **Image:** Ubuntu Server 22.04 LTS
- **Size:** `B2s` (2 vCPU, 4 GB) is plenty — bandwidth matters more than CPU
- **Authentication:** SSH public key (recommended)
- **Disk:** free space must be **≥ 2× your file volume** (files are downloaded
  to disk before upload). For 10 GB of files, attach a 64 GB disk or resize
  the OS disk. For a small test the default is fine.
- **Networking:** defaults are fine — you only need inbound **SSH (22)**;
  outbound HTTPS (to Salesforce) is open by default.

Create, and note the VM's **public IP**.

## 2. SSH in

```bash
ssh azureuser@<VM_PUBLIC_IP>
```

## 3. Install Node 18+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs unzip
node -v
```

## 4. Copy the tool to the VM

On your Mac — make a clean zip (no secrets, no node_modules, no work data):

```bash
cd /Users/macbookair/Desktop/Bold/Bold_28_Task_ConnectOrgToORG/fileMigratonOrgToOrg/withApexMigrationOrgToOrg
zip -r ~/Downloads/bfm.zip bulk-file-migration \
  -x "*/node_modules/*" "*/.env" "*/work/*"
scp ~/Downloads/bfm.zip azureuser@<VM_PUBLIC_IP>:~
```

On the VM:

```bash
unzip bfm.zip
cd bulk-file-migration
npm install
```

## 5. Create the .env on the VM

```bash
nano .env
```

Paste both orgs' credentials (`SOURCE_LOGIN_URL/USERNAME/PASSWORD/TOKEN` and
`TARGET_*`), save (Ctrl-O, Enter, Ctrl-X), then lock it down:

```bash
chmod 600 .env
```

## 6. Run it — inside tmux so it survives your SSH disconnect

```bash
tmux new -s mig
node cli.js stats
node cli.js manifest
node cli.js run
```

Detach (leave it running): **Ctrl-b** then **d**. You can close your laptop.
Reattach later: `tmux attach -t mig`.

## 7. Resume / monitor

Every phase is resumable — if anything interrupts, just re-run `node cli.js run`
and it continues from the manifest. `node cli.js verify` prints current state.

## 8. Cleanup

When `verify` shows everything uploaded/linked and you've confirmed in the
target org: **delete the VM** (stops billing and removes `.env` + `work/`
with it). Or manually: `rm -rf work && rm .env` first.

**Security:** the `.env` on the VM holds live credentials. Keep the VM
private (SSH only, your IP), and delete it when the migration is done.
