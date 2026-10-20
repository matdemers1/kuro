#!/bin/sh
# Onboard Kurō on the Zima — a deliberate, one-time host act. Run as root on the host. It writes
# /DATA/kuro with generated secrets and never prints them; every deploy after this goes through
# Shipyard. Usage:
#
#   sh zima-onboard.sh <tunnel.env> <40-char sha>
#
# ZimaOS has no openssl: secrets come from /dev/urandom.
set -eu
TUNNEL_ENV=$(cd "$(dirname "${1:?usage: zima-onboard.sh <tunnel.env> <sha>}")" && pwd)/$(basename "$1")
[ -f "$TUNNEL_ENV" ] || { echo "No tunnel.env at $TUNNEL_ENV." >&2; exit 2; }
SHA=${2:?usage: zima-onboard.sh <tunnel.env> <sha>}
DIR=/DATA/kuro
HERE=$(cd "$(dirname "$0")" && pwd)

rand() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

mkdir -p "$DIR" && chmod 700 "$DIR"
cd "$DIR"
[ -e server.env ] && { echo "server.env exists in $DIR; refusing to overwrite secrets." >&2; exit 1; }

umask 077
PG=$(hex 24)
printf 'POSTGRES_USER=kuro\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=kuro\n' "$PG" > postgres.env
cat > server.env <<ENV
BASE_URL=https://kuro.dormice.ai
DATABASE_URL=postgresql://kuro:$PG@postgres:5432/kuro
KURO_SECRET_KEY=$(rand 32)
AUTH_PEPPER=$(rand 32)
SETUP_TOKEN=$(hex 16)
KURO_CR_URL=http://kuro-cr:8080
BACKUP_DIR=/data/backups
ENV
cp "$TUNNEL_ENV" tunnel.env
chmod 600 postgres.env server.env tunnel.env

cp "$HERE/zima/compose.yml" compose.yml
cp "$HERE/zima/compose.tunnel.yml" compose.tunnel.yml
sed -i "s#\(ghcr.io/matdemers1/kuro-[a-z]*\):sha-0\{40\}#\1:sha-$SHA#" compose.yml
cp compose.yml compose.yml.pre-shipyard
cp "$HERE/shipyard.kuro.yml" /DATA/shipyard/apps/kuro.yml

# The first boot by hand: Shipyard's backup step runs inside a live server container.
DOCKER_CONFIG=/DATA/.docker docker compose -p kuro -f compose.yml -f compose.tunnel.yml up -d --wait
echo "Started $SHA. Setup token: grep SETUP_TOKEN $DIR/server.env"
echo "Next: mount $DIR and the kuro_backups volume into the Shipyard agent, then dry-run."
