#!/usr/bin/env bash
# One-time VPS setup. Run as root on a fresh Ubuntu 22.04 / 24.04 box:
#   TZ_NAME=America/New_York bash deploy/setup-ubuntu.sh
# Installs Node 22, REAL Google Chrome, Xvfb (a fake monitor so Chrome can run
# "headful" on a server with no screen), fonts, and creates the `scraper` user.
set -euo pipefail

APP_DIR=/opt/levels-scraper
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

install -m 644 "$HERE/xvfb@.service" /etc/systemd/system/xvfb@.service
install -m 644 "$HERE/levels-scraper.service" /etc/systemd/system/levels-scraper.service
systemctl daemon-reload
systemctl enable --now xvfb@:99.service

cat <<MSG

Done. Next steps:
  1. Copy the project to $APP_DIR (rsync -a --exclude node_modules --exclude data . root@vps:$APP_DIR/)
  2. cd $APP_DIR && npm ci && npm run build && chown -R scraper:scraper $APP_DIR
  3. Create $APP_DIR/.env from .env.example. On a VPS set CAPTCHA_MANUAL_SOLVE=0 and keep HOST=127.0.0.1
     (put Caddy/nginx/Cloudflare Tunnel in front if other machines need to reach it).
  4. systemctl enable --now levels-scraper && journalctl -fu levels-scraper
MSG
