#!/bin/bash
# One-time setup for the prod EC2 server (Amazon Linux 2023, arm64). Paste it
# as the instance's user data at launch; it runs once as root on first boot.
# deploy.sh does everything after this, on every deploy.
set -euo pipefail

dnf install -y docker dnf-automatic
systemctl enable --now docker

mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Security updates install themselves daily; nothing else updates on its own.
sed -i 's/^upgrade_type = .*/upgrade_type = security/; s/^apply_updates = .*/apply_updates = yes/' /etc/dnf/automatic.conf
systemctl enable --now dnf-automatic.timer

# 1 GB of swap: a 2 GB server running Node, Valkey and cloudflared slows down
# under a memory spike instead of having the kernel kill the api.
dd if=/dev/zero of=/swapfile bs=1M count=1024
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

mkdir -p /opt/triloplan
chmod 700 /opt/triloplan
