#!/bin/bash

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

print_step() { echo -e "\n${CYAN}${BOLD}==> $1${NC}"; }
print_ok()   { echo -e "${GREEN}✔ $1${NC}"; }
print_warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
print_err()  { echo -e "${RED}✘ $1${NC}"; }

echo -e "\n${BOLD}YTDL Setup Script${NC}"
echo "────────────────────────────────────"

# ── apt packages ──────────────────────────────────────────────────────────────
print_step "Updating apt and installing dependencies"
sudo apt update -qq
sudo apt install -y python3-pip pipx ffmpeg
print_ok "apt packages installed"

# ── yt-dlp via pipx ───────────────────────────────────────────────────────────
print_step "Installing yt-dlp via pipx"
pipx ensurepath

if pipx list | grep -q yt-dlp; then
  print_warn "yt-dlp already installed, upgrading..."
  pipx upgrade yt-dlp
else
  pipx install yt-dlp
fi

# Make yt-dlp available in the current shell session for the rest of this script
export PATH="$PATH:$HOME/.local/bin"
print_ok "yt-dlp $(yt-dlp --version) installed"

# ── npm install ───────────────────────────────────────────────────────────────
print_step "Installing Node dependencies"

if ! command -v node &>/dev/null; then
  print_err "Node.js not found. Please install Node.js v18+ and re-run this script."
  exit 1
fi

npm install
print_ok "npm packages installed"

# ── systemd service ───────────────────────────────────────────────────────────
echo ""
read -p "$(echo -e ${BOLD}"Would you like to create a systemd service for YTDL? [y/N]: "${NC})" CREATE_SERVICE
CREATE_SERVICE=${CREATE_SERVICE:-n}

if [[ "$CREATE_SERVICE" =~ ^[Yy]$ ]]; then
  SERVICE_USER=$(whoami)
  WORKING_DIR=$(pwd)
  NODE_BIN=$(which node)
  YTDLP_PATH="$HOME/.local/bin"

  SERVICE_FILE="/etc/systemd/system/ytdl.service"

  print_step "Creating systemd service at $SERVICE_FILE"

  sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=YTDL YouTube Downloader
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$WORKING_DIR
ExecStart=$NODE_BIN $WORKING_DIR/server.js
Restart=on-failure
RestartSec=5
Environment=PATH=$YTDLP_PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable ytdl.service

  echo ""
  read -p "$(echo -e ${BOLD}"Start the service now? [y/N]: "${NC})" START_NOW
  START_NOW=${START_NOW:-n}

  if [[ "$START_NOW" =~ ^[Yy]$ ]]; then
    sudo systemctl start ytdl.service
    sleep 1
    if systemctl is-active --quiet ytdl.service; then
      print_ok "ytdl.service is running"
    else
      print_err "Service failed to start. Check: sudo journalctl -u ytdl.service -n 20"
    fi
  else
    print_ok "Service created and enabled. Start it with: sudo systemctl start ytdl"
  fi

else
  echo ""
  print_ok "Skipped systemd setup. Start manually with: npm start"
fi

# ── done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}────────────────────────────────────${NC}"
echo -e "${GREEN}${BOLD}Setup complete!${NC}"
echo -e "Open ${CYAN}http://localhost${NC} in your browser."
echo -e "${YELLOW}Note: You may need to restart your shell for yt-dlp to be on PATH.${NC}\n"
