# `turkey deploy` — App Hosting Spec

## Overview

Deploy apps built with TurkeyCode to turkeycode.ai hosting. One command, live in 60 seconds.

```bash
turkey deploy
# → ✅ Live at https://my-app.turkeycode.ai
```

---

## CLI Commands

### `turkey deploy`
Package and deploy the current project.

```bash
turkey deploy                          # auto-detect everything
turkey deploy --name cool-app          # custom subdomain
turkey deploy --domain mycoolapp.com   # custom domain (Pro+)
turkey deploy --tier starter           # explicit tier
turkey deploy --env .env.production    # inject env vars
```

### `turkey login`
Authenticate with turkeycode.ai.

```bash
turkey login                           # browser-based OAuth
turkey login --token <api-key>         # headless / CI
```

Stores credentials at `~/.turkeycode/credentials.json`:
```json
{
  "token": "tc_usr_...",
  "email": "user@example.com",
  "tier": "starter"
}
```

### `turkey apps`
List deployed apps.

```bash
turkey apps                            # list all
turkey apps status                     # with health/uptime
turkey apps logs my-app                # tail logs
turkey apps delete my-app              # teardown
```

### `turkey upgrade`
Change hosting tier.

```bash
turkey upgrade my-app --tier pro       # opens Stripe checkout if needed
```

---

## Deploy Flow (Client Side)

```
turkey deploy
    │
    ├── 1. Check auth (~/.turkeycode/credentials.json)
    │      └── No auth? → Run `turkey login` interactively
    │
    ├── 2. Detect project
    │      ├── Read package.json → name, scripts, deps
    │      ├── Detect stack (Next.js, Express, etc.)
    │      ├── Detect DB needs (prisma? → needs postgres)
    │      ├── Detect features needed (stripe, auth, s3, email)
    │      └── Estimate tier requirement
    │
    ├── 3. Package
    │      ├── Run build if not already built (npm run build)
    │      ├── Create tarball of deploy-ready files:
    │      │     .next/, dist/, prisma/, package.json,
    │      │     package-lock.json, public/, Dockerfile (if exists)
    │      ├── Exclude: node_modules, .git, .env, .turkey/
    │      └── Compress: deploy-{name}-{timestamp}.tar.gz
    │
    ├── 4. Upload
    │      POST turkeycode.ai/api/v1/deploy
    │      Headers: Authorization: Bearer tc_usr_...
    │      Body: multipart/form-data
    │        - tarball: the package
    │        - manifest.json: {name, stack, tier, features, env}
    │
    ├── 5. Wait for provisioning
    │      Poll turkeycode.ai/api/v1/deploy/{id}/status
    │      Show progress spinner:
    │        ▸ Uploading...
    │        ▸ Provisioning container...
    │        ▸ Installing dependencies...
    │        ▸ Running migrations...
    │        ▸ Starting app...
    │        ▸ Configuring SSL...
    │
    └── 6. Done
           ✅ Live at https://my-app.turkeycode.ai
           
           App:    my-app
           Tier:   starter ($12/mo)
           Stack:  Next.js + Postgres
           URL:    https://my-app.turkeycode.ai
```

---

## Deploy Flow (Server Side)

### API Endpoints

#### `POST /api/v1/deploy`
Create a new deployment.

```
Authorization: Bearer tc_usr_...
Content-Type: multipart/form-data

Fields:
  tarball: <file>
  manifest: <json string>
```

Response:
```json
{
  "deployId": "dep_abc123",
  "appName": "my-app",
  "status": "provisioning",
  "url": "https://my-app.turkeycode.ai"
}
```

#### `GET /api/v1/deploy/:id/status`
Poll deployment progress.

```json
{
  "deployId": "dep_abc123",
  "status": "running",        // provisioning | installing | migrating | starting | running | failed
  "step": "Installing dependencies...",
  "url": "https://my-app.turkeycode.ai",
  "logs": ["...", "..."]
}
```

#### `GET /api/v1/apps`
List user's deployed apps.

```json
{
  "apps": [
    {
      "name": "my-app",
      "url": "https://my-app.turkeycode.ai",
      "tier": "starter",
      "stack": "nextjs",
      "status": "running",
      "createdAt": "2026-03-08T...",
      "lastDeployed": "2026-03-08T..."
    }
  ]
}
```

#### `DELETE /api/v1/apps/:name`
Tear down an app.

#### `POST /api/v1/apps/:name/logs`
Stream app logs.

---

## Server-Side Provisioning

### Container Architecture

Each app gets a Docker container from a base image:

```dockerfile
# Base image (pre-built, cached)
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
```

Per-app container:
```dockerfile
FROM turkeycode-base:latest

# Copy deployed app
COPY ./deploy/ /app/

# Install production deps
RUN npm ci --only=production

# Run migrations if prisma exists
RUN if [ -f prisma/schema.prisma ]; then npx prisma migrate deploy; fi

EXPOSE 3000
CMD ["npm", "start"]
```

### Environment Injection by Tier

**Free tier:**
```
PORT=3000
NODE_ENV=production
```

**Starter ($12/mo) — adds:**
```
DATABASE_URL=postgresql://app_myapp:generated@db:5432/myapp
REDIS_URL=redis://redis:6379/N
```

**Pro ($29/mo) — adds:**
```
# Stripe (user provides their own keys via turkey deploy --env)
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Auth
NEXTAUTH_URL=https://my-app.turkeycode.ai
NEXTAUTH_SECRET=generated
GOOGLE_CLIENT_ID=turkeycode-shared-oauth-id
GOOGLE_CLIENT_SECRET=turkeycode-shared-oauth-secret

# S3
S3_BUCKET=turkeycode-apps
S3_PREFIX=my-app/
S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
S3_ACCESS_KEY=...
S3_SECRET_KEY=...

# Email
SENDGRID_API_KEY=...
SENDGRID_FROM=noreply@my-app.turkeycode.ai
```

**Business ($49/mo) — adds:**
```
# Same as Pro, plus:
BACKUP_ENABLED=true
BACKUP_SCHEDULE=0 3 * * *
```

### Caddy Configuration

Wildcard subdomain routing via Caddy:

```caddyfile
*.turkeycode.ai {
    tls {
        dns digitalocean {env.DO_API_TOKEN}
    }

    @app {
        header_regexp Host ^(?P<app>[a-z0-9-]+)\.turkeycode\.ai$
    }

    handle @app {
        reverse_proxy {re.app.app}:3000
    }
}
```

Each app container gets a hostname matching its subdomain. Caddy routes `my-app.turkeycode.ai` → container `my-app:3000`.

Custom domains (Pro+):
```caddyfile
mycoolapp.com {
    reverse_proxy my-app:3000
}
```

### Database Provisioning

Per-app database (Starter+):
```sql
CREATE USER app_myapp WITH PASSWORD 'generated';
CREATE DATABASE myapp OWNER app_myapp;
```

All on the shared Postgres instance. Each app is isolated by user/database.

### Free Tier: Sleep/Wake

Apps on free tier sleep after 30 minutes of inactivity:

1. **Caddy middleware** tracks last request timestamp per app
2. **Cron job** (every 5 min) checks for idle free-tier apps → `docker stop`
3. **Wake-on-request:** Caddy detects stopped container → `docker start` → wait for health → proxy
4. Cold start adds ~3-5s on first request

```
Request → Caddy → Container running? 
                    ├── Yes → proxy immediately
                    └── No → docker start → poll health → proxy (3-5s)
```

### Docker Compose (per server)

```yaml
services:
  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data

  db:
    image: postgres:16-alpine
    volumes: [pgdata:/var/lib/postgresql/data]

  redis:
    image: redis:7-alpine

  # App containers are managed dynamically via docker CLI
  # Not in compose — created/destroyed by the deploy API
```

---

## Manifest Format

Generated by CLI, sent with tarball:

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "stack": "nextjs",
  "node": "20",
  "features": {
    "database": true,
    "redis": false,
    "stripe": false,
    "auth": false,
    "s3": false,
    "email": false,
    "backgroundJobs": false
  },
  "scripts": {
    "build": "next build",
    "start": "next start",
    "migrate": "prisma migrate deploy"
  },
  "env": {
    "CUSTOM_VAR": "value"
  },
  "tier": "starter"
}
```

---

## Database Schema (additions to existing)

```prisma
model DeployedApp {
  id            String   @id @default(cuid())
  name          String   @unique  // subdomain
  userId        String
  user          User     @relation(fields: [userId], references: [id])
  tier          String   @default("free")  // free | starter | pro | business
  stack         String   // nextjs | express | etc
  status        String   @default("provisioning")  // provisioning | running | sleeping | stopped | failed
  containerName String?
  customDomain  String?
  features      Json     @default("{}")
  lastActivity  DateTime @default(now())
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  deployments   Deployment[]
}

model Deployment {
  id        String   @id @default(cuid())
  appId     String
  app       DeployedApp @relation(fields: [appId], references: [id])
  status    String   @default("pending")  // pending | building | running | failed
  version   String
  logs      String   @default("")
  createdAt DateTime @default(now())
}
```

---

## Security

- **Isolation:** Each app runs in its own Docker container with limited resources
- **Network:** Apps can only reach their own database and redis (Docker network isolation)
- **Secrets:** User env vars stored encrypted in DB, injected at container start
- **Rate limiting:** Deploy endpoint: 5 deploys per hour per user
- **Size limits:** Tarball max 500MB, container max 1GB disk
- **Resource limits per tier:**
  | Tier | RAM | CPU | Disk | Bandwidth |
  |------|-----|-----|------|-----------|
  | Free | 256MB | 0.25 | 512MB | 1GB/mo |
  | Starter | 512MB | 0.5 | 2GB | 10GB/mo |
  | Pro | 1GB | 1 | 5GB | 50GB/mo |
  | Business | 2GB | 2 | 10GB | 100GB/mo |

---

## Implementation Order

1. **CLI: `turkey login` + `turkey deploy`** — package, upload, poll status
2. **API: `/api/v1/deploy`** — receive tarball, create container, provision DB
3. **Caddy: wildcard subdomain routing** — proxy to containers
4. **Free tier: sleep/wake** — cron + wake-on-request
5. **Stripe: tier checkout** — upgrade flow
6. **CLI: `turkey apps`** — list, logs, delete
7. **Custom domains** — Pro tier Caddy config
8. **Backups** — Business tier daily pg_dump
