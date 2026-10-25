#!/bin/bash
# Runs on the prod server, sent by .github/workflows/deploy-prod.yml through
# SSM Run Command. Usage: deploy.sh <image uri> <aws region>
#
# Order matters: settings first, then migrations (while the old api still
# serves — so every migration must work with the old code too), then the
# new api. If the new api isn't healthy within 60s, the previous image is
# started again and the deploy fails.
set -euo pipefail

IMAGE="$1"
REGION="$2"
cd /opt/triloplan

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${IMAGE%%/*}"

# App settings: every SSM parameter under /triloplan/prod/app/ becomes one
# KEY=value line. Multi-line values (PEM keys) must be stored with \n escapes.
aws ssm get-parameters-by-path --region "$REGION" --path /triloplan/prod/app/ --with-decryption \
  --query 'Parameters[*].[Name,Value]' --output text |
  while IFS=$'\t' read -r name value; do echo "${name##*/}=${value}"; done > app.env.new
if [ ! -s app.env.new ]; then
  echo "No parameters found under /triloplan/prod/app/ — refusing to deploy with empty settings" >&2
  exit 1
fi
chmod 600 app.env.new
mv app.env.new app.env

PREVIOUS_IMAGE=""
if [ -f .env ]; then PREVIOUS_IMAGE=$(grep '^API_IMAGE=' .env | cut -d= -f2- || true); fi

TUNNEL_TOKEN=$(aws ssm get-parameter --region "$REGION" --name /triloplan/prod/cloudflare-tunnel-token \
  --with-decryption --query Parameter.Value --output text)

write_compose_env() {
  printf 'API_IMAGE=%s\nCLOUDFLARE_TUNNEL_TOKEN=%s\n' "$1" "$TUNNEL_TOKEN" > .env
  chmod 600 .env
}

write_compose_env "$IMAGE"
docker compose pull api
docker compose up -d valkey cloudflared
docker compose run --rm --no-deps api node dist/db/migrate.js
docker compose up -d api

for _ in $(seq 1 30); do
  if docker compose exec -T api node -e "fetch('http://localhost:4000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    echo "Deployed $IMAGE"
    docker image prune -af --filter "until=168h" > /dev/null
    exit 0
  fi
  sleep 2
done

echo "New api not healthy after 60s. Last logs:" >&2
docker compose logs --tail 100 api >&2
if [ -n "$PREVIOUS_IMAGE" ]; then
  echo "Rolling back to $PREVIOUS_IMAGE" >&2
  write_compose_env "$PREVIOUS_IMAGE"
  docker compose up -d api
fi
exit 1
