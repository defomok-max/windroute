#!/usr/bin/env bash
# windbu install script for macOS / Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/defomok-max/windroute/main/scripts/install.sh | bash
#
# What it does:
#   1. Checks Node.js >= 20
#   2. Clones the repo into ~/windbu (or $WINDBU_HOME)
#   3. Runs `node bin/windbu.mjs` which auto-configures + starts the gateway
#
# For Windows, use scripts/install.ps1 instead (full installer with shortcut + autostart).

set -euo pipefail

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
step()  { printf "%s› %s%s\n" "$CYAN"   "$1" "$RESET"; }
ok()    { printf "  %s✓%s %s\n"         "$GREEN" "$RESET" "$1"; }
warn()  { printf "  %s!%s %s\n"         "$YELLOW" "$RESET" "$1"; }
fail()  { printf "  %s✗%s %s\n"         "$RED" "$RESET" "$1"; exit 1; }

INSTALL_DIR="${WINDBU_HOME:-$HOME/windbu}"
REPO="${WINDBU_REPO:-https://github.com/defomok-max/windroute.git}"

printf "\n%s  windbu installer%s\n"  "$CYAN" "$RESET"
printf   "  local gateway for Windsurf AI\n\n"

# ── 1. Node.js check ─────────────────────────────────────
step "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js not in PATH. Install from https://nodejs.org/ (need ≥ 20)"
fi
NODE_MAJOR=$(node -e 'process.stdout.write(String(parseInt(process.versions.node.split(".")[0],10)))')
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js $(node -v) is too old. Need ≥ 20. Install from https://nodejs.org/"
fi
ok "node $(node -v)"

# ── 2. git check ─────────────────────────────────────────
step "Checking git"
if ! command -v git >/dev/null 2>&1; then
  fail "git not in PATH"
fi
ok "git $(git --version | awk '{print $3}')"

# ── 3. Clone or update ───────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  step "Updating existing install at $INSTALL_DIR"
  (cd "$INSTALL_DIR" && git pull --ff-only) || warn "git pull failed — continuing with existing copy"
else
  step "Cloning $REPO → $INSTALL_DIR"
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi
ok "Source ready at $INSTALL_DIR"

# ── 4. Launch ────────────────────────────────────────────
step "Starting windbu"
cd "$INSTALL_DIR"
exec node bin/windbu.mjs
