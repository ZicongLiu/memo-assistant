# Running FlowDesk with PM2

PM2 keeps FlowDesk running as a background process and automatically restarts it if it crashes. This is the recommended way to run the app on your local machine or a Linux/macOS server.

---

## Prerequisites

- **Node.js** managed via [nvm](https://github.com/nvm-sh/nvm)
- **PM2** installed globally under your default Node version

```bash
# Set nvm default to your desired Node version
nvm alias default 24

# Install PM2 globally
npm install -g pm2
```

---

## First-time setup

### 1. Start the app

```bash
cd /path/to/memo-assistant
pm2 start ecosystem.config.js
```

PM2 automatically uses whichever Node version is set as your `nvm default`.

### 2. Save the process list

```bash
pm2 save
```

This writes `~/.pm2/dump.pm2` so PM2 knows which apps to restore after a reboot.

### 3. Register as a startup service (run once)

```bash
pm2 startup
```

Copy and run the `sudo env PATH=...` command it prints. This installs a macOS LaunchDaemon (or systemd unit on Linux) that starts PM2 on every boot.

**Example output:**
```
[PM2] To setup the Startup Script, copy/paste the following command:
sudo env PATH=/Users/<you>/.nvm/versions/node/v24.14.1/bin:$PATH \
  /Users/<you>/.nvm/versions/node/v24.14.1/lib/node_modules/pm2/bin/pm2 \
  startup launchd -u <you> --hp /Users/<you>
```

After running that command, FlowDesk will survive reboots automatically.

---

## Daily commands

| Action | Command |
|--------|---------|
| Start app | `pm2 start ecosystem.config.js` |
| Stop app | `pm2 stop memo-assistant` |
| Restart app | `pm2 restart memo-assistant` |
| Reload (zero-downtime) | `pm2 reload memo-assistant` |
| Check status | `pm2 status` |
| Tail live logs | `pm2 logs memo-assistant` |
| Last 100 log lines | `pm2 logs memo-assistant --lines 100 --nostream` |
| Remove from PM2 | `pm2 delete memo-assistant` |

npm scripts are also available as shortcuts:

| Action | npm script |
|--------|-----------|
| Start | `npm run pm2:start` |
| Stop | `npm run pm2:stop` |
| Restart | `npm run pm2:restart` |
| Status | `npm run pm2:status` |
| Logs | `npm run pm2:logs` |

---

## Updating the app

After pulling new code or changing dependencies:

```bash
cd /path/to/memo-assistant
git pull
npm install
pm2 restart memo-assistant
```

---

## Upgrading Node.js

After switching nvm default to a new Node version:

```bash
# 1. Install PM2 under the new version
npm install -g pm2

# 2. Rebuild/update native modules
npm install better-sqlite3@latest   # gets prebuilt binary for new Node

# 3. Restart the app
pm2 restart memo-assistant

# 4. Re-register the startup hook
pm2 unstartup
pm2 startup       # copy and run the new sudo command it prints
pm2 save
```

> The `ecosystem.config.js` uses `nvm which default` to resolve the node path dynamically, so no manual edits are needed after a version change.

---

## Logs

Logs are written to `./logs/` inside the project directory:

| File | Contents |
|------|----------|
| `logs/memo-assistant-out.log` | stdout (HTTP requests, startup messages) |
| `logs/memo-assistant-error.log` | stderr (warnings, errors) |
| `logs/memo-assistant.log` | combined |

To prevent logs from growing indefinitely, install the log-rotate plugin:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

---

## ecosystem.config.js reference

```js
module.exports = {
  apps: [{
    name: "memo-assistant",           // PM2 process name
    script: "node_modules/.bin/next",
    args: "dev --port 51373",         // change port here if needed
    cwd: __dirname,
    interpreter: nodePath,            // auto-resolved from `nvm which default`
    env: {
      NODE_ENV: "development",
      PORT: 51373,                    // must match args port
    },
    autorestart: true,                // restart on crash
    max_restarts: 10,                 // give up after 10 rapid crashes
    restart_delay: 3000,              // wait 3 s before each restart
    watch: false,                     // Next.js handles its own HMR
  }],
};
```

To change the port, update both `args` and `env.PORT`, then restart.

---

## Troubleshooting

### `pm2: command not found`

PM2 is installed under nvm, which isn't always on PATH. Options:

```bash
# Reload your shell profile
source ~/.zshrc && pm2 status

# Or use the full path
/Users/<you>/.nvm/versions/node/v24.14.1/bin/pm2 status
```

### `/api/storage` returns 500 after a Node upgrade

The `better-sqlite3` native binary needs to match the running Node version:

```bash
npm install better-sqlite3@latest
pm2 restart memo-assistant
```

### App keeps restarting

Check the error log for the root cause:

```bash
pm2 logs memo-assistant --lines 50 --nostream
```

### Port already in use

```bash
lsof -i :51373        # find what's holding the port
pm2 delete memo-assistant && pm2 start ecosystem.config.js
```
