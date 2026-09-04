#!/usr/bin/env bash
# 로컬 개발 서버 재시작 (postgres 5436 + tsx watch)
set -euo pipefail
cd "$(dirname "$0")/.."
pkill -f "tsx.*server/src/index.ts" 2>/dev/null || true
sleep 1
set -a; . ./.env.dev; set +a
nohup npx tsx watch server/src/index.ts > /tmp/mailroom-dev.log 2>&1 &
for i in $(seq 1 40); do
  if curl -sf "localhost:${PORT:-9200}/api/health" >/dev/null 2>&1; then echo "ready"; exit 0; fi
  sleep 0.5
done
echo "timed out"; tail -20 /tmp/mailroom-dev.log; exit 1
