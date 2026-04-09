# PM2 — Process Manager

The dev server runs under PM2 so it survives terminal closes and auto-restarts on crashes.

## Quick reference

| Action | Command |
|--------|---------|
| Start | `npm run pm2:start` |
| Stop | `npm run pm2:stop` |
| Restart | `npm run pm2:restart` |
| Status | `npm run pm2:status` |
| Tail logs | `npm run pm2:logs` |

Or use pm2 directly (requires nvm env active, or use the full path):

```bash
# If nvm is loaded in your shell:
pm2 status
pm2 stop memo-assistant
pm2 delete memo-assistant   # remove from pm2 list entirely

# Full path (works without nvm loaded):
/Users/zicol/.nvm/versions/node/v20.19.0/bin/pm2 status
```

## Config

Defined in `ecosystem.config.js`. Key settings:
- **Port:** 51373 (IANA dynamic/private range — unassigned by design)
- **Logs:** `./logs/` (timestamped, split out/error)
- **Auto-restart:** yes, up to 10 times, with 3 s delay
- **Watch:** disabled (Next.js HMR handles file changes)

## Auto-start on login (optional)

```bash
pm2 startup   # prints a command to run — copy/paste and run it
pm2 save      # saves current process list so it restores on boot
```
