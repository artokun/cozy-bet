#!/usr/bin/env bash
# run-local.sh — one-shot local-validator validation.
#
# Boots a solana-test-validator, airdrops the bot/treasury wallets, deploys
# the program (if needed), initializes the config, and runs all e2e tests.
# Leaves the validator running in the background so you can poke at it.
#
# Usage: ./scripts/run-local.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load localnet env
set -a
source .env.localnet
set +a

BOT_RESOLVER=$(solana-keygen pubkey keys/bot-resolver.json)
TREASURY=$(solana-keygen pubkey keys/treasury.json)

# 1. Validator — skip if already running on 8899
if ! nc -z 127.0.0.1 8899 2>/dev/null; then
  echo "==> starting solana-test-validator"
  solana-test-validator --reset --quiet --ledger /tmp/cozy-bet-ledger > /tmp/cozy-bet-validator.log 2>&1 &
  until solana cluster-version --url http://127.0.0.1:8899 > /dev/null 2>&1; do sleep 1; done
  echo "    validator up"
else
  echo "==> validator already running on 8899"
fi

# 2. Airdrop
echo "==> airdropping 100 SOL to bot + treasury"
solana airdrop 100 "$BOT_RESOLVER" --url http://127.0.0.1:8899 > /dev/null
solana airdrop 100 "$TREASURY" --url http://127.0.0.1:8899 > /dev/null

# 3. Deploy (only if program doesn't already exist at that program id)
if ! solana program show "$PROGRAM_ID" --url http://127.0.0.1:8899 > /dev/null 2>&1; then
  echo "==> deploying program"
  (cd apps/program && anchor deploy --provider.cluster localnet) >/dev/null
else
  echo "==> program already deployed at $PROGRAM_ID"
fi

# 4. Init or update config
echo "==> init-config"
pnpm tsx scripts/init-config.ts | sed 's/^/    /'

# 5. Run e2e suites
echo "==> e2e-smoke.ts"
pnpm tsx scripts/e2e-smoke.ts | tail -20 | sed 's/^/    /'

echo "==> e2e-bot-flows.ts"
pnpm tsx scripts/e2e-bot-flows.ts | tail -15 | sed 's/^/    /'

echo "==> e2e-dispute.ts"
pnpm tsx scripts/e2e-dispute.ts | tail -15 | sed 's/^/    /'

echo
echo "✅ all local checks passed. validator still running on :8899 — kill with 'pkill solana-test-validator'."
