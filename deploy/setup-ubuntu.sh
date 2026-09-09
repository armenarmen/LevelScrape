#!/usr/bin/env bash
# One-time VPS setup. Run as root on a fresh Ubuntu 22.04 / 24.04 box:
#   TZ_NAME=America/New_York bash deploy/setup-ubuntu.sh
# Installs Node 22, REAL Google Chrome, Xvfb (a fake monitor so Chrome can run
# "headful" on a server with no screen), fonts, and creates the `scraper` user.
set -euo pipefail

APP_DIR=/opt/levelscrape
TZ_NAME="${TZ_NAME:-America/New_York}"
HERE="$(cd "$(dirname "$0")" && pwd)"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates gnupg xvfb dbus-x11 \
  fonts-liberation fonts-noto-core fonts-noto-color-emoji fonts-dejavu

# Node 22 LTS
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Google Chrome (the real thing, not chromium). Installing the .deb via apt pulls its deps.
if ! command -v google-chrome-stable >/dev/null; then
  curl -fsSL -o /tmp/google-chrome-stable_current_amd64.deb \
    https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y /tmp/google-chrome-stable_current_amd64.deb
fi
# Don't let unattended-upgrades replace the Chrome binary while it's running.
# Update it on purpose: apt-mark unhold google-chrome-stable && apt upgrade && systemctl restart levels-scraper
apt-mark hold google-chrome-stable

# Make the OS itself look like the country you search from (no emulation needed).
timedatectl set-timezone "$TZ_NAME" || true
locale-gen en_US.UTF-8 >/dev/null 2>&1 || true
update-locale LANG=en_US.UTF-8 || true

# Never run Chrome as root.
id -u scraper >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin scraper
mkdir -p "$APP_DIR"
chown -R scraper:scraper "$APP_DIR"

install -m 644 "$HERE/levelscrape.service" /etc/systemd/system/levelscrape.service
systemctl daemon-reload

cat <<MSG

Done. Next steps:
  1. git clone https://github.com/armenarmen/LevelScrape.git $APP_DIR   (or rsync your copy)
  2. cd $APP_DIR && npm ci && npm run build && chown -R scraper:scraper $APP_DIR
  3. cp .env.example .env and set API_KEY (openssl rand -hex 32). Keep HOST=127.0.0.1 and put a
     Cloudflare Tunnel / Tailscale / Caddy in front if other machines need to reach it.
  4. sudo -u scraper npm run doctor      # shows what was detected; expect "xvfb-chrome"
  5. systemctl enable --now levelscrape && journalctl -fu levelscrape
MSG
