#!/usr/bin/env bash
# deploy.sh — Run this on the EC2 server to start maximall-web
# This script is executed remotely by Terraform after provisioning.
set -e

APP_DIR="/opt/maximall-web"
cd "$APP_DIR"

echo "=== [deploy.sh] Starting maximall-web via Docker Compose ==="

# Pull latest base images
docker compose pull nginx || true

# Build and start all services
docker compose up -d --build

echo "=== [deploy.sh] Waiting for health-check to pass... ==="
for i in {1..20}; do
  if curl -sf http://localhost/api/settings > /dev/null 2>&1; then
    echo "=== [deploy.sh] App is UP and healthy! ==="
    break
  fi
  echo "  ... attempt $i/20 — waiting 5s"
  sleep 5
done

echo "=== [deploy.sh] Done. ==="
