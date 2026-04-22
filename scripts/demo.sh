#!/usr/bin/env bash
#
# scripts/demo.sh — one-shot runner that brings up the Studio kitchen-sink demo
# against your local dev DB and prints the dev-login URL.
#
# What it does:
#   1. Pushes the Prisma schema (no-op if already applied).
#   2. Seeds the "Studio Kitchen Sink Demo" tenant + conversation.
#   3. Starts the backend with DEV_AUTH_BYPASS=1 in the background.
#   4. Starts the frontend in the background.
#   5. Prints the dev-login URL (copy/paste into your browser).
#
# Requires backend/.env with DATABASE_URL + JWT_SECRET + OPENAI_API_KEY +
# ANTHROPIC_API_KEY. The runner will surface the missing-env-var error
# from the backend if any are absent — we do not re-validate here.
#
# Ctrl-C stops both dev servers cleanly.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKEND_DIR="$REPO_ROOT/backend"
FRONTEND_DIR="$REPO_ROOT/frontend"
LOG_DIR="$REPO_ROOT/.demo-logs"
mkdir -p "$LOG_DIR"

BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"
SEED_LOG="$LOG_DIR/seed.log"

BACKEND_PORT="${PORT:-3001}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

# --- colors for log lines ----------------------------------------------------
c_reset='\033[0m'
c_blue='\033[0;34m'
c_green='\033[0;32m'
c_yellow='\033[0;33m'
c_red='\033[0;31m'

step() { printf "\n${c_blue}▸ %s${c_reset}\n" "$*"; }
ok()   { printf "${c_green}✓ %s${c_reset}\n" "$*"; }
warn() { printf "${c_yellow}! %s${c_reset}\n" "$*"; }
err()  { printf "${c_red}✗ %s${c_reset}\n" "$*"; }

# --- cleanup -----------------------------------------------------------------
BACKEND_PID=""
FRONTEND_PID=""
cleanup() {
  step "Shutting down…"
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
    ok "Backend stopped"
  fi
  if [[ -n "$FRONTEND_PID" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
    wait "$FRONTEND_PID" 2>/dev/null || true
    ok "Frontend stopped"
  fi
}
trap cleanup EXIT INT TERM

# --- 1. schema push ----------------------------------------------------------
step "Applying Prisma schema (db push)…"
(cd "$BACKEND_DIR" && npx prisma db push --skip-generate) >"$LOG_DIR/db-push.log" 2>&1 \
  || { err "prisma db push failed — see $LOG_DIR/db-push.log"; exit 1; }
ok "Schema up to date"

# --- 2. seed -----------------------------------------------------------------
step "Seeding Studio Kitchen Sink Demo…"
(cd "$BACKEND_DIR" && FRONTEND_PORT="$FRONTEND_PORT" npm run --silent seed:studio-demo) \
  | tee "$SEED_LOG"
DEV_URL="$(grep -Eo 'http://localhost:[0-9]+/dev-login[^ ]*' "$SEED_LOG" | tail -n 1 || true)"
if [[ -z "$DEV_URL" ]]; then
  err "Seed did not print a dev-login URL — see $SEED_LOG"
  exit 1
fi
ok "Seed complete"

# --- 3. backend --------------------------------------------------------------
step "Starting backend on :$BACKEND_PORT (DEV_AUTH_BYPASS=1)…"
(
  cd "$BACKEND_DIR"
  DEV_AUTH_BYPASS=1 NODE_ENV=development PORT="$BACKEND_PORT" npm run --silent dev
) >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

# Wait for backend to respond on /auth/dev-login (returns 400 "tenantId or email is required"
# when bypass is on and the request lacks params — a fine readiness check).
step "Waiting for backend health…"
for i in {1..60}; do
  if curl -sS -o /dev/null -X POST \
      -H 'Content-Type: application/json' \
      -d '{}' \
      "http://127.0.0.1:$BACKEND_PORT/auth/dev-login"; then
    ok "Backend is up"
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    err "Backend exited — tail of $BACKEND_LOG:"
    tail -n 40 "$BACKEND_LOG" || true
    exit 1
  fi
  sleep 1
  if [[ $i -eq 60 ]]; then
    err "Backend never came up — tail of $BACKEND_LOG:"
    tail -n 40 "$BACKEND_LOG" || true
    exit 1
  fi
done

# --- 4. frontend -------------------------------------------------------------
step "Starting frontend on :$FRONTEND_PORT…"
(
  cd "$FRONTEND_DIR"
  PORT="$FRONTEND_PORT" npm run --silent dev
) >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

# Wait for Next.js to report "Ready in"
step "Waiting for frontend to compile…"
for i in {1..90}; do
  if grep -q "Ready in\|ready started server on\|compiled client and server" "$FRONTEND_LOG" 2>/dev/null; then
    ok "Frontend is up"
    break
  fi
  if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    err "Frontend exited — tail of $FRONTEND_LOG:"
    tail -n 40 "$FRONTEND_LOG" || true
    exit 1
  fi
  sleep 1
  if [[ $i -eq 90 ]]; then
    warn "Frontend took >90s to compile — check $FRONTEND_LOG"
    break
  fi
done

# --- 5. print URL + follow logs ---------------------------------------------
cat <<BANNER

══════════════════════════════════════════════════════════════════
  Studio Kitchen Sink Demo ready.

  Paste this URL into your browser:

    $DEV_URL

  Backend log:  $BACKEND_LOG
  Frontend log: $FRONTEND_LOG

  Ctrl-C stops both dev servers.
══════════════════════════════════════════════════════════════════

BANNER

# Keep the script in the foreground tailing the frontend log so Ctrl-C is responsive.
tail -F "$FRONTEND_LOG" "$BACKEND_LOG"
