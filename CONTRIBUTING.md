# Contributing to Cinewav Web

## Branch Strategy

```
main          ← Production (auto-deploys to Cloudflare on every push)
  └── develop ← Staging (integration branch)
        └── feature/your-feature-name  ← Your work
        └── fix/bug-description
```

## Workflow

### 1. Start a new feature or fix

```bash
git checkout develop
git pull origin develop
git checkout -b feature/your-feature-name
```

### 2. Make your changes and commit

```bash
git add .
git commit -m "feat: describe what you changed"
```

Commit message prefixes:
- `feat:` — new feature
- `fix:` — bug fix
- `sync:` — changes to sync algorithm
- `ui:` — UI/UX changes
- `infra:` — infrastructure or deployment changes
- `docs:` — documentation only

### 3. Push and open a Pull Request

```bash
git push origin feature/your-feature-name
```

Open a PR on GitHub targeting `develop`. A **preview deployment** will be automatically created — you will get a comment on the PR with a live URL to test your changes on a real device before merging.

### 4. Merge to develop → test on staging

Once the PR is approved and merged to `develop`, test on staging.

### 5. Merge develop → main → auto-deploys to production

When ready for production, open a PR from `develop` to `main`. Merging triggers the full production deploy workflow.

## Secrets Required

The following secrets must be set in GitHub → Settings → Secrets and variables → Actions:

| Secret | Where to find it |
|:---|:---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare Dashboard → My Profile → API Tokens → Create Token (use "Edit Cloudflare Workers" template) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard → right sidebar on any Workers/Pages page |

## Local Development

```bash
# Terminal 1 — Sync Worker
cd worker && wrangler dev --port 8787

# Terminal 2 — Master app
cd master && pnpm dev   # http://localhost:5173

# Terminal 3 — Audience PWA
cd audience && pnpm dev  # http://localhost:5174
```
