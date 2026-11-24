# `turkeycode deploy`

Deploys the current project to a droplet in the caller's own DigitalOcean account.

turkeycode has no hosting service. Earlier versions uploaded to turkeycode.ai; that
path, its tiers and its checkout are gone. The only outside service `deploy` talks to
is `api.digitalocean.com`, with the caller's token.

## Credentials

A DigitalOcean API token with read and write access, looked up in this order:

1. `DIGITALOCEAN_ACCESS_TOKEN` (the name `doctl` uses)
2. `DIGITALOCEAN_TOKEN`
3. `~/.turkeycode/credentials.json`, written by `turkeycode login --token <token>` (mode 600)

`login` checks the token against `GET /v2/account` before saving it.

SSH uses a dedicated keypair, `~/.turkeycode/deploy_key`, generated on first use and
registered in the account as `turkeycode-deploy`. Host keys go in
`~/.turkeycode/deploy_known_hosts`.

## Commands

```bash
turkeycode login --token <token>
turkeycode deploy [--name <name>] [--domain <domain>[,<domain>...]] [--region <slug>] [--size <slug>] [--env <file>] [--yes]
turkeycode apps [list]
turkeycode apps status [name]
turkeycode apps logs <name> [-n <lines>]
turkeycode apps delete <name> --force
```

## Model

- One droplet per app. The droplet is named after the app and tagged `turkeycode`
  and `tc-stack:<stack>`. An app is found again by that tag and name, so there is no
  local state file and nothing to keep in sync.
- Image `ubuntu-24-04-x64`. First boot (cloud-init) installs Docker with the Compose
  plugin and adds 2 GB of swap.
- One cloud firewall, `turkeycode-apps`, applies to the `turkeycode` tag and so to
  every app droplet. It lets in SSH (22), HTTP (80), HTTPS (443, TCP and UDP) and
  ping. Every deploy creates it if it is missing; a firewall that already has that
  name keeps its rules. It is a cloud firewall because Docker publishes ports past
  a host firewall such as `ufw`.
- Default size `s-1vcpu-1gb`, or `s-1vcpu-2gb` when the app needs a database server (Postgres, MySQL, MongoDB) or Redis. SQLite does not count.
  Default region `nyc3`. Both only apply when the droplet is created.
- Creating a droplet costs the account owner money, so the first deploy prints the
  size and monthly price and asks. `--yes` skips the question; without a TTY and
  without `--yes` it refuses.

## Flow

1. Resolve the token and call `GET /v2/account`.
2. Detect the project (`src/deploy/detect.ts`).
3. Find the app's droplet, or create one and wait for it to be active.
4. Wait for SSH.
5. Build the Compose file: the `run-local` services, changed for production
   (`productionCompose` in `src/deploy/droplet.ts`):
   - no service publishes a port except Caddy (80 and 443)
   - development database passwords become `${DB_PASSWORD}`
   - the app gets `env_file: ../app.env`, and keys set there win over generated ones
   - Caddy reverse-proxies to the app. Its `Caddyfile` is generated (`caddyfile`): the
     first `--domain` serves the app over HTTPS, further ones redirect to it, and with
     no domain the app is plain HTTP on port 80
6. Tar the project (`src/deploy/package.ts`; `.env*`, `node_modules`, `.git` excluded).
   There is no local build. The image is built on the droplet.
7. Copy `release.tar.gz`, `compose.yml`, `Caddyfile` and `app.env` to `/opt/turkeycode/<app>/`.
8. Run the remote script (`remoteScript`): wait for cloud-init, create `secrets.env`
   with a random `DB_PASSWORD` if it is not there yet, swap in the new source, build,
   start databases and wait for them, run the migration, start everything.
9. Poll `http://<ip>/` and report.

On the droplet:

```
/opt/turkeycode/<app>/
  secrets.env   DB_PASSWORD, generated once, kept across redeploys
  app.env       from --env, replaced on every deploy
  Caddyfile     from --domain, replaced on every deploy
  src/          the project, docker-compose.turkeycode.yml, Dockerfile
```

Database data lives in named Docker volumes, so a redeploy keeps it.
`apps delete` destroys the droplet and the data with it.

## Not handled

- Backups. Turn on droplet backups in DigitalOcean, or dump the database yourself.
- More than one app per droplet, or more than one droplet per app.
- Resizing or moving a droplet. Do that in DigitalOcean.
- DNS. `--domain` configures Caddy; the A records are the owner's to create.
- Zero-downtime deploys. The app container restarts when the new image is up.
