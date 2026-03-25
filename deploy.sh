#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Cinewav Web — Full Deployment Script
# Deploys: Worker (Cloudflare Workers) + Master + Audience (Cloudflare Pages)
# ─────────────────────────────────────────────────────────────────────────────
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🎬 Cinewav Web — Deployment"
echo "════════════════════════════════════════"

# ── Step 1: Deploy the Cloudflare Worker ─────────────────────────────────────
echo ""
echo "▶ Step 1: Deploying Sync Worker to Cloudflare Workers…"
cd "$SCRIPT_DIR/worker"
pnpm install --frozen-lockfile
wrangler deploy

# Capture the worker URL from wrangler output
WORKER_URL=$(wrangler deploy 2>&1 | grep -oP 'https://[a-z0-9-]+\.workers\.dev' | head -1)
if [ -z "$WORKER_URL" ]; then
  echo "⚠️  Could not auto-detect worker URL. Check your Cloudflare dashboard."
  echo "   Set WORKER_URL manually before continuing."
  WORKER_URL="https://cinewav-sync.YOUR_ACCOUNT.workers.dev"
fi
echo "✅ Worker deployed: $WORKER_URL"

# ── Step 2: Build and deploy Master app ──────────────────────────────────────
echo ""
echo "▶ Step 2: Building Master Player app…"
cd "$SCRIPT_DIR/master"
pnpm install --frozen-lockfile
pnpm build

echo "▶ Deploying Master app to Cloudflare Pages…"
wrangler pages deploy dist \
  --project-name cinewav-master \
  --commit-dirty=true
echo "✅ Master app deployed"

# ── Step 3: Build and deploy Audience app ────────────────────────────────────
echo ""
echo "▶ Step 3: Building Audience PWA…"
cd "$SCRIPT_DIR/audience"
pnpm install --frozen-lockfile
pnpm build

echo "▶ Deploying Audience app to Cloudflare Pages…"
wrangler pages deploy dist \
  --project-name cinewav-audience \
  --commit-dirty=true
echo "✅ Audience app deployed"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo "🎉 DEPLOYMENT COMPLETE"
echo ""
echo "  Sync Worker:   $WORKER_URL"
echo "  Master App:    https://cinewav-master.pages.dev"
echo "  Audience App:  https://cinewav-audience.pages.dev"
echo ""
echo "Next steps:"
echo "  1. Open the Master app and enter your Worker URL"
echo "  2. Load an audio file"
echo "  3. Share the Audience link with your audience"
echo "════════════════════════════════════════"
