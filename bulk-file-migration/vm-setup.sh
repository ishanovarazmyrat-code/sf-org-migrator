#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu VM (Azure / any cloud).
# Installs Node 22, the Salesforce CLI, unzip, and the tool's dependencies.
#
#   Usage (on the VM, from the bulk-file-migration folder):
#     bash vm-setup.sh
#
# After it finishes:
#     sf org login web --alias sourceOrg
#     sf org login web --alias targetOrg
#     node cli.js init
#     node cli.js doctor
#     node cli.js migrate
set -e

echo "==> Installing Node.js 22..."
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "    Node $(node -v)"

echo "==> Installing unzip + tmux..."
sudo apt-get install -y unzip tmux >/dev/null

echo "==> Installing the Salesforce CLI..."
if ! command -v sf >/dev/null; then
  sudo npm install -g @salesforce/cli >/dev/null
fi
echo "    $(sf --version | head -1)"

echo "==> Installing tool dependencies (npm install)..."
npm install --no-fund --no-audit >/dev/null

echo ""
echo "Done. Next steps (device login — a VM has no browser):"
echo "  sf org login device --alias sourceOrg  # prints a URL + code to enter on your own browser"
echo "  sf org login device --alias targetOrg"
echo "  node cli.js init                       # pick the two orgs"
echo "  node cli.js doctor                     # verify everything is ready"
echo "  tmux new -s mig                        # so it survives disconnects"
echo "  node cli.js migrate                    # records + files"
