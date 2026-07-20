# Acronis MCP Server (starter)

A minimal remote MCP server that exposes Acronis Cyber Protect Cloud data as
tools Claude can call directly from chat.

## What it does

Four starter tools:
- `list_devices` — list registered devices/resources
- `get_backup_status` — latest backup results for a device
- `list_alerts` — active alerts, optionally filtered by severity
- `trigger_backup` — kick off an on-demand backup run (write action — review before enabling)

These map to Acronis's Resource & Policy Management, Alerts, and Task Manager
APIs. You'll likely want to add more tools (restore, list backup plans,
tenant management, etc.) — the pattern in `server.js` is copy/paste-able.

## 1. Get Acronis API credentials

1. Log in to the Acronis Management Portal.
2. Go to **Settings → API clients** and create a new API client. Save the
   `client_id` and `client_secret` — the secret is shown only once.
3. Note your datacenter URL from the portal's address bar (e.g.
   `https://eu2-cloud.acronis.com`, `https://us5-cloud.acronis.com`).

## 2. Configure

```bash
cp .env.example .env
# then fill in ACRONIS_DATACENTER_URL, ACRONIS_CLIENT_ID, ACRONIS_CLIENT_SECRET
```

## 3. Install and run locally

```bash
npm install
npm start
```

This starts the MCP server on `http://localhost:3000/mcp` using the
Streamable HTTP transport.

Test the token exchange works before wiring up Claude:
```bash
curl -s http://localhost:3000/health
```

## 4. Deploy it somewhere reachable over HTTPS

claude.ai's custom connectors need a **remote** server reachable over the
internet (not localhost). Any of these work fine for a server this size:
- Render, Railway, or Fly.io (simplest — push repo, set env vars, done)
- A small VPS with a reverse proxy (Caddy/Nginx) for TLS
- Cloudflare Workers (would need porting `fetch`-based logic — doable, but
  the Node version above is the fastest path to "it works")

Set the same three env vars (`ACRONIS_DATACENTER_URL`,
`ACRONIS_CLIENT_ID`, `ACRONIS_CLIENT_SECRET`) in whatever platform you deploy to.

## 5. Add it to Claude

1. In claude.ai, go to **Settings → Connectors**.
2. Choose to add a custom connector.
3. Enter your deployed URL's `/mcp` endpoint, e.g.
   `https://your-app.onrender.com/mcp`.
4. Save, then enable it in a conversation. Claude will now be able to call
   `list_devices`, `get_backup_status`, `list_alerts`, and `trigger_backup`
   when relevant.

(If instead you're using Claude Desktop or Claude Code, you can also run
this as a local process and point the MCP config at `node server.js` with
stdio — but the HTTP version above works for all surfaces.)

## Device / Plan / Static Group report

This adds a report joining three things per device: which **backup plan**
it's assigned, which **static group** it belongs to, and how many **devices
are in that static group**. Output is a formatted `.xlsx` with **seven**
sheets:
- **Device Report** — one row per device (Name, Type, Last Backup, Last AV Scan, Plan, Static Group, Devices in Group)
- **By Plan** — every plan, with the device names under it (a device on multiple plans appears once per plan)
- **By Static Group** — every static group, with the device names in it
- **Plan Summary** — plan name + device count
- **Group Summary** — static group name + device count
- **EDR Incidents** — Incident ID, Device, Detected time, Category, Severity, Positivity, Verdict, Mitigated (Yes/No), File Name, Process Name, Action Taken/Status, and a direct link to the incident in the Acronis console
- **Group Modification Audit Log** — device, when it moved between static groups, who did it, and the raw activity type (see caveat below)

### EDR Incidents — built on Acronis's real, documented EDR API

This uses the confirmed **Endpoint Detection and Response API**
(`<datacenter>/api/mdr/v1/incidents`, documented at
developer.acronis.com) — the same data source behind the Acronis
console's "Incidents" page. Confirmed real fields used: `host_name`,
`incident_categories`, `severity`, `positivity`, `mitigation_state`,
`verdict`, `incident_link`, `incident_time`, and (from the incident
detail panel) `incident_trigger` (e.g. `cmd.exe`).

**Mitigation detection is now robust to the exact enum value.** Your
account's data showed the console splitting mitigation into
"Automatically mitigated" and "Manually mitigated" as separate counts —
so rather than checking for one literal string, anything other than
`NOT_MITIGATED` now counts as mitigated (covers `MITIGATED`,
`AUTO_MITIGATED`, `MANUALLY_MITIGATED`, or any similar variant your
account uses).

**Process name now maps from `incident_trigger`** (confirmed directly
from your screenshot — Incident 13 showed `Incident trigger: cmd.exe`),
so mitigated incidents should now show real trigger/process info instead
of "(not returned by API)".

Tenant scoping uses the API's own confirmed `customer_id` filter:
- **All customers** (default) → `direct_children(<your_partner_tenant_id>)`
- **A specific tenant** (via the dropdown in the top bar) → just that
  tenant's ID, giving you the single-tenant view instead of an
  all-tenants aggregate

**One remaining honest gap:** a specific file name and a full historical
log of the exact remediation action taken aren't confirmed fields in
Acronis's public API docs. This tool attempts an additional best-effort
lookup of the incident's "activities" (matching the **Incident Activities**
tab you showed) for a richer action description, capped to the first 25
incidents by default for speed — but that endpoint path isn't confirmed
in public docs either, so it fails silently and falls back to the
detail/list-level info if it doesn't match your account. Where nothing
more specific is available, the Action column names the mitigation type
and trigger, with a link to the incident in the Acronis console for the
full picture. If your account's activities/detail response uses
different field names, share one raw response and the mapping in
`fetchIncidentData`/`buildIncidentRows` in `reportGenerator.js` can be
tightened further.

### Active Alerts — fixed to match the real confirmed response shape

The Alert Manager API (`/api/alert_manager/v1/alerts`) response is
confirmed to nest alert content under `details` (`details.title`,
`details.description`, `details.fields`) rather than flat top-level
fields — the mapping now reads from there, so alert titles and
descriptions should display correctly instead of showing blank/generic
text.

### Group Modification Audit Log — one honest gap

This is built on the confirmed **Task Manager Activities API**
(`<datacenter>/api/task_manager/v2/activities`), filtered client-side for
anything that looks group-related by keyword. Acronis's public API
library does not include a dedicated, documented endpoint for the
console's separate "Audit log" screen (Monitoring → Audit log) — this is
the closest confirmed substitute, and may not capture every group move if
your account logs them under an activity type/field this filter doesn't
recognize. If the panel/sheet comes back empty while you know group
changes have happened, share one raw activity item from
`/task_manager/v2/activities` (unfiltered) and the keyword filter in
`fetchGroupAuditLog` (in `reportGenerator.js`) can be adjusted.

**Fixed:** this endpoint's confirmed error response
(`"bad condition field 'tenant_id'"`) showed that `/activities` doesn't
accept `tenant_id` as a query filter at all — unlike resource/policy
endpoints. It now always fetches unfiltered and applies any tenant
scoping client-side instead, so selecting a specific tenant in the
dropdown no longer errors on this panel. Note this client-side tenant
match is itself a best-effort string check against the raw activity data,
since the exact tenant-identifying field on activity items isn't
confirmed either — if a tenant filter here returns fewer results than
expected, that's the next thing worth checking with one raw example.

### Tenant / customer selector

The dropdown in the dashboard's top bar lists your customer tenants (via
the confirmed Account Management API, `GET /api/2/tenants?parent_id=...`)
and scopes **every** panel and the exported report to just that tenant —
Devices, Plans, Static Groups, EDR Incidents, Group Audit Log, and Alerts
all respect the selection. Leave it on "All customers" for the aggregate
view across every tenant your API client can see.

**Fixed:** the EDR incidents API's confirmed error
(`"the specified tenant is not a partner"`) showed that the
`direct_children(<id>)` filter requires an actual partner-*kind* tenant —
but an API client can be created at any level (a customer account, a
folder, a sub-partner), not necessarily at the top partner level. This is
now resolved automatically: it walks up your tenant's parent hierarchy
(`GET /api/2/tenants/{id}`, following `parent_id`) until it finds one with
`"kind": "partner"`, and uses that for the "All customers" view. This
means **the same API client credentials now work correctly regardless of
which level in your tenant hierarchy they were created at** — you
shouldn't need to do anything differently when switching to a different
client ID/secret for a different account.

### Static Groups — the definitive finding, and how it's solved now

Confirmed directly against Acronis's official, complete API documentation:
the public **Resource and Policy Management API** does not expose static
group membership at all. The confirmed resource object schema is:
```
{ id, name, type, tenant_id, external_id, created_at, updated_at, user_defined_name }
```
No parent/group field exists on it, and the documented list of resource
operations (fetch all, fetch by type, fetch with plan, fetch detail, fetch
protection status) has no group-related entry. The "Machines with agents"
folder tree in the console is backed by an internal API not published for
third-party use — so the earlier auto-detection heuristics (checking
`parent_id`, `group_id`, `member_ids`, etc.) were reasonable attempts, but
were never going to reliably work, because the data genuinely isn't in
the public API.

**Two ways forward, both built in:**

1. **Manual group mapping (works today, no API needed).** On the
   Settings page, there's now a **Static Group → Device Mapping** box —
   enter each group and its devices once (copy/pasted from what you can
   see in the console), one group per line:
   ```
   CWAREAJIT
   ```
   Once saved, this is used everywhere — the dashboard's Static Groups
   panel, the device table, and every export sheet — instead of the
   best-effort auto-detection. This is now the default, reliable path.

2. **The real (undocumented) endpoint, if you want it fully automatic.**
   The console itself clearly does this somehow. Open the console in
   Chrome DevTools (F12 → Network tab), click a group folder, and find
   the request that fires. Share that URL + response JSON and it can be
   wired in directly for a fully automatic version — no manual entry
   needed. Until then, the manual mapping above is the dependable option.

If no manual mapping is set, the old auto-detection heuristics still run
as a last-resort fallback (they occasionally do find something depending
on the account), but they're no longer the primary mechanism.

### Run it yourself (CLI)

```bash
npm install
npm run report
# or with options:
node scripts/generate-report.js --tenant-id=abc123 --out=./reports/q3-report.xlsx
```

Writes to `reports/device-report-<timestamp>.xlsx` by default.

### Ask Claude to generate it (MCP tool)

Once the server is deployed and connected (see setup above), just ask Claude
in chat, e.g. *"Generate the Acronis device report"*. It calls the
`generate_device_report` tool, which returns the spreadsheet as a
downloadable attachment right in the conversation — no need to run anything
locally.

### Endpoint paths — now using confirmed real Acronis API structure

These are confirmed against developer.acronis.com:
- Devices: `<datacenter>/api/resource_management/v4/resources`
- Backup plans: `<datacenter>/api/policy_management/v4/policies`
- Alerts: `<datacenter>/api/alert_manager/v1/alerts`

**Static Groups is the one exception** — I couldn't find a confirmed
dedicated endpoint for static device groups in the public docs. It's
currently implemented as a filtered call to the resources endpoint
(`search=resourceType='resource.group.static'`), which may need adjusting
for your account. If Devices/Plans/Alerts show real data but Static Groups
stays empty, that's the part to dig into — try calling
`.../resource_management/v4/resources` with no filter and inspect a
group-type item's fields directly to find the right filter value and the
field that links a device to its group.

## Web dashboard (login-gated GUI)

A separate small app (`dashboard/`) gives you a browser-based dashboard —
sign in, then see device/plan/group panels and download the same Excel
report, without going through Claude at all.

### 1. Create your login

```bash
npm install
node scripts/create-dashboard-user.js "your-chosen-password"
```

This prints a `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD_HASH`, and
`DASHBOARD_SESSION_SECRET` — copy all three into your `.env` (the password
itself is never stored, only its bcrypt hash).

### 2. Run it

```bash
npm run dashboard
```

Open `http://localhost:4000/login`, sign in, and you'll land on
`/dashboard` with:
- Summary cards (device count, static group count, backup plan count)
- **Two charts**: devices per static group (bar), and EDR incidents by severity (doughnut) — via Chart.js, loaded from a CDN so no extra install step
- A **paginated** device table (10 rows/page, sortable columns, search/filter) so it stays a manageable single-screen size instead of one giant scrolling list, however many devices you have
- A **Static Groups panel showing the total group count**, where **clicking a group expands an inline, scrollable list of just that group's device names** — right there, no separate page or huge table scroll needed
- A Plans panel (click a plan to filter the device table to it)
- EDR Incidents, Group Modification Audit Log, and Active Alerts panels
- A **Download .xlsx** button that generates the same report as the CLI/MCP tool, including the same charts' underlying data in sheet form

### Setting your Acronis API credentials from the browser (no .env editing needed)

Click **Settings** in the top bar (or go to `/settings`) to enter your
**Datacenter URL**, **Client ID**, and **Client Secret** directly through
the dashboard. These are saved to `config/acronis-credentials.json`
(created automatically, owner-read-only permissions, and already excluded
via `.gitignore`) and take effect immediately — no restart needed.

- If you leave the Client Secret field blank when re-saving, the
  previously saved secret is kept rather than wiped.
- The secret is never sent back to the browser after saving — the page
  only shows whether one is set.
- `.env` values still work as a fallback if you'd rather set
  `ACRONIS_DATACENTER_URL` / `ACRONIS_CLIENT_ID` / `ACRONIS_CLIENT_SECRET`
  there instead; the Settings page takes priority when both are present.
- If nothing is configured yet, the dashboard shows a banner pointing you
  to Settings instead of failing silently.

### 3. Deploying it

Same considerations as the MCP server (see Windows/Linux hosting notes
above) — it's just another Express app, on port 4000 by default
(`DASHBOARD_PORT` in `.env`). Put it behind HTTPS (Caddy/reverse proxy)
before exposing it beyond your local network — sessions currently ride on
a plain HTTP cookie, and the `cookie.secure` flag in `dashboard/server.js`
is commented out with a note to enable it once you're on HTTPS.

## Security notes

- This starter has **no authentication in front of the MCP endpoint itself**
  — anyone who has the URL can call it and act on your Acronis account
  through your API client's permissions. Add a shared-secret header check
  or OAuth in front of `/mcp` before deploying anywhere non-private.
- Scope your Acronis API client's permissions as narrowly as possible
  (read-only where you can) especially before enabling write tools like
  `trigger_backup`.
- Treat `ACRONIS_CLIENT_SECRET` like a password — use your deploy platform's
  secret manager, don't commit `.env`.
