# Hosting on Windows 11 Pro

Quick path to get this running and reachable from Windows 11 Pro.

## 1. Install Node.js

Download the LTS installer from https://nodejs.org and install it (this
also installs `npm`). Verify in PowerShell:

```powershell
node -v
npm -v
```

## 2. Unzip and install dependencies

```powershell
cd C:\path\to\acronis-mcp-server
npm install
```

## 3. Configure credentials

```powershell
copy .env.example .env
notepad .env
```

Fill in `ACRONIS_DATACENTER_URL`, `ACRONIS_CLIENT_ID`, `ACRONIS_CLIENT_SECRET`
(see the main README for where to get these).

## 4. Run it

```powershell
npm start
```

This starts the MCP server on `http://localhost:3000/mcp`. Confirm it's up:

```powershell
curl http://localhost:3000/health
```

To generate the Excel report locally without going through Claude:

```powershell
npm run report
```

## 5. Keep it running (so it survives closing the terminal / reboots)

The simplest option is **PM2** (a process manager) or **NSSM** (runs it as a
proper Windows Service). PM2 is quicker to set up:

```powershell
npm install -g pm2
pm2 start server.js --name acronis-mcp
pm2 save
pm2 startup
```

`pm2 startup` prints a command — run that once to make PM2 (and this
server) start automatically on boot.

If you'd rather run it as a true Windows Service (survives even without a
logged-in user), use **NSSM** (https://nssm.cc) instead:

```powershell
nssm install AcronisMCP "C:\Program Files\nodejs\node.exe" "C:\path\to\acronis-mcp-server\server.js"
nssm start AcronisMCP
```

## 6. Make it reachable from claude.ai (outside your network)

claude.ai's custom connectors need an **HTTPS** URL reachable from the
internet — `localhost` or a bare LAN IP won't work. On Windows 11 Pro, the
two common ways to get there:

**Option A — Reverse tunnel (fastest to test with, no router changes)**
Use Cloudflare Tunnel or ngrok to expose your local port 3000 over HTTPS
without touching your router/firewall:

```powershell
# Cloudflare Tunnel (free, no account required for a quick tunnel)
winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:3000
```

This prints a public `https://<random>.trycloudflare.com` URL — use
`https://<that-url>/mcp` as your connector URL in Claude. Good for testing;
for something permanent, set up a named Cloudflare Tunnel with your own
domain instead (also free), or use ngrok's paid reserved-domain tier.

**Option B — Port-forward + your own domain/TLS**
1. Windows Firewall: allow inbound TCP on port 3000 (or whatever port you
   put behind a reverse proxy) —
   `New-NetFirewallRule -DisplayName "Acronis MCP" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow`
2. Forward that port to this machine's local IP on your router.
3. Put a reverse proxy in front for TLS — Caddy is the easiest on Windows
   (auto-obtains a Let's Encrypt cert for a domain you point at your public IP):
   ```powershell
   winget install CaddyServer.Caddy
   ```
   Caddyfile:
   ```
   your-domain.com {
       reverse_proxy localhost:3000
   }
   ```
   `caddy run` and Caddy handles HTTPS for you.

Either way, add the shared-secret check mentioned in the main README's
**Security notes** before exposing this to the internet — right now anyone
with the URL can call your Acronis account through it.

## 7. Add the connector in Claude

Settings → Connectors → Add custom connector → paste your `https://.../mcp`
URL from step 6.

## 8. Running the web dashboard too

The dashboard is a second, separate small server (port 4000 by default) —
you can run it alongside the MCP server on the same machine.

```powershell
node scripts\create-dashboard-user.js "your-chosen-password"
```

Copy the three printed values (`DASHBOARD_USERNAME`,
`DASHBOARD_PASSWORD_HASH`, `DASHBOARD_SESSION_SECRET`) into `.env`, then:

```powershell
npm run dashboard
```

Open `http://localhost:4000/login` in a browser on the same machine to
confirm it works. To keep it running long-term, add it as a second PM2
process (or second NSSM service) alongside the MCP server:

```powershell
pm2 start dashboard/server.js --name acronis-dashboard
pm2 save
```

To reach the dashboard from other machines on your network or the
internet, use the same tunnel/reverse-proxy approach from step 6, just
pointed at port 4000 instead of 3000. Once you're serving it over HTTPS,
open `dashboard/server.js` and uncomment `cookie.secure: true` so login
sessions are only ever sent over an encrypted connection.
