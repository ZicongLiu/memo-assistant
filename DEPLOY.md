# Deploying FlowDesk to Fly.io

## Prerequisites

```bash
# Install flyctl
brew install flyctl

# Log in (creates an account if you don't have one)
fly auth login
```

---

## First-time setup

### 1. Create the app

```bash
cd /Users/zicol/Softwares/memo-assistant
fly launch --no-deploy --name flowdesk-app --region sjc
```

- When asked "overwrite fly.toml?" → **No** (we already have one)
- When asked to set up a Postgres/Redis database → **No**

### 2. Create the persistent data volume

```bash
fly volumes create flowdesk_data --region sjc --size 1
```

This is where `hub.db` (your tasks, projects, boards) lives. It survives deploys and restarts.

### 3. Set environment secrets

```bash
# Required: passphrase to access the app from the internet
fly secrets set APP_PASSPHRASE="choose-a-strong-passphrase"

# Required: signing secret for session cookies (any random string)
fly secrets set APP_SECRET="$(openssl rand -hex 32)"

# Optional: SMTP for password-reset emails
fly secrets set SMTP_HOST="smtp.gmail.com"
fly secrets set SMTP_PORT="587"
fly secrets set SMTP_USER="you@gmail.com"
fly secrets set SMTP_PASS="your-app-password"
fly secrets set SMTP_FROM="FlowDesk <you@gmail.com>"

# Optional: keep your existing integrations
fly secrets set ANTHROPIC_API_KEY="sk-ant-..."
fly secrets set DISCORD_BOT_TOKEN="..."
```

> **Note:** Never commit `.env.local` to git — it contains your real keys.

### 4. Deploy

```bash
fly deploy
```

First deploy takes ~3–4 minutes (builds the Docker image). Subsequent deploys are faster.

### 5. Open the app

```bash
fly open
```

You'll see the login page. Enter the passphrase you set in step 3.

---

## Subsequent deploys

After making code changes:

```bash
fly deploy
```

That's it. Your data volume is untouched.

---

## Useful commands

| Action | Command |
|--------|---------|
| View logs | `fly logs` |
| SSH into machine | `fly ssh console` |
| Check status | `fly status` |
| Scale to always-on | `fly scale count 1` |
| View secrets | `fly secrets list` |
| Update a secret | `fly secrets set KEY=value` |
| Download DB backup | `fly ssh console -C "cat /app/data/backup.json"` |

---

## Custom domain (optional)

```bash
fly certs create yourdomain.com
```

Then add the DNS records it shows you (CNAME or A record) in your DNS provider.

---

## Notes

- **Storage:** SQLite on a 1 GB Fly volume. The app also writes a `backup.json` snapshot on every save — you can download it via `fly ssh console`.
- **Auto-sleep:** `auto_stop_machines = "stop"` means the machine sleeps when idle (free tier friendly). First request after sleep takes ~2s to wake. Set `min_machines_running = 1` in `fly.toml` to keep it always-on (uses more free allowance).
- **Access control:** The `APP_PASSPHRASE` gate protects the whole app. If not set, the app is open (fine for local dev, not for production).
- **OTP reset emails:** Requires SMTP secrets. Without them, the "forgot password" flow won't send emails (but everything else works).
