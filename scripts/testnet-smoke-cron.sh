#!/usr/bin/env bash
# Local cron wrapper for scripts/testnet-smoke.ts.
#
# Usage:
#   ./scripts/testnet-smoke-cron.sh
#
# Crontab entry (every 6 hours, log to ~/.cache/cozy-bet/smoke.log):
#   23 */6 * * * /Users/art/code/cozy-bet/scripts/testnet-smoke-cron.sh
#
# On failure, exits non-zero so cron will email the user (if MAILTO is set).
# Output is appended to a per-day log; the most recent failure is kept in
# smoke-last-fail.log for quick diagnosis.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.cache/cozy-bet"
mkdir -p "$LOG_DIR"
TODAY="$(date +%Y-%m-%d)"
LOG="$LOG_DIR/smoke-$TODAY.log"

cd "$ROOT"

{
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
  if pnpm tsx scripts/testnet-smoke.ts 2>&1; then
    echo "[ok]"
    exit 0
  else
    rc=$?
    echo "[fail rc=$rc]"
    cp "$LOG" "$LOG_DIR/smoke-last-fail.log" 2>/dev/null || true
    exit $rc
  fi
} | tee -a "$LOG"
