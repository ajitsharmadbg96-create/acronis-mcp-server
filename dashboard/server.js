// dashboard/server.js
//
// Login-gated web dashboard for the Acronis reporting tool.
// Separate small Express app from the MCP server (server.js at project
// root) — same Acronis client and report generator underneath, different
// front door: a human with a browser and a password, instead of Claude
// calling MCP tools.
//
// Run with: npm run dashboard   (see package.json)

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import { fetchChildTenants } from "../acronisClient.js";
import { generateDeviceReportWorkbook, fetchReportData, buildReportRows, buildGroupedViews, fetchIncidentData, buildIncidentRows, fetchAlerts, buildAlertRows, fetchGroupAuditLog, buildGroupAuditRows } from "../reportGenerator.js";
import { getAcronisCredentials, saveAcronisCredentials, hasCredentialsConfigured } from "../settingsStore.js";
import { getGroupMapping, saveGroupMapping, parseGroupMappingText, formatGroupMappingText, hasManualMapping } from "../groupMappingStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.DASHBOARD_PORT || 4000;

const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || "acronis";
const DASHBOARD_PASSWORD_HASH = process.env.DASHBOARD_PASSWORD_HASH;
// Simpler alternative to the bcrypt hash — set this instead in .env if the
// hash keeps failing to match (e.g. from a copy/paste issue). Defaults to
// "acronis" if neither this nor the hash is set, so login always works out
// of the box; change it once things are running.
const DASHBOARD_PASSWORD_PLAIN = process.env.DASHBOARD_PASSWORD;
const SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || "insecure-dev-secret-change-me";

if (!process.env.DASHBOARD_SESSION_SECRET) {
  console.warn(
    "DASHBOARD_SESSION_SECRET is not set in .env — using an insecure default. Fine for local testing, but set a real one before exposing this beyond your own machine."
  );
}
console.log(`Dashboard login username: "${DASHBOARD_USERNAME}"`);
if (!DASHBOARD_PASSWORD_HASH && !DASHBOARD_PASSWORD_PLAIN) {
  console.warn('No DASHBOARD_PASSWORD_HASH or DASHBOARD_PASSWORD set — defaulting password to "acronis". Set one of these in .env to change it.');
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
      // secure: true, // uncomment once served over HTTPS (recommended)
    },
  })
);

// Public static assets (css/js for the login + dashboard pages).
app.use("/assets", express.static(path.join(__dirname, "public", "assets")));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  return res.redirect("/login");
}

// ── Auth routes ──
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const validUsername = username === DASHBOARD_USERNAME;

  let validPassword = false;
  if (DASHBOARD_PASSWORD_HASH) {
    validPassword = await bcrypt.compare(password || "", DASHBOARD_PASSWORD_HASH);
  } else if (DASHBOARD_PASSWORD_PLAIN) {
    validPassword = password === DASHBOARD_PASSWORD_PLAIN;
  } else {
    // No password configured at all — fall back to the documented default.
    validPassword = password === "acronis";
  }

  if (!validUsername || !validPassword) {
    return res.redirect("/login?error=1");
  }

  req.session.authenticated = true;
  req.session.username = username;
  res.redirect("/dashboard");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ── Dashboard page ──
app.get("/dashboard", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/", (req, res) => res.redirect("/dashboard"));

// ── Settings page: enter/update Acronis API credentials from the browser ──
app.get("/settings", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "settings.html"));
});

app.get("/api/settings", requireAuth, (req, res) => {
  const creds = getAcronisCredentials();
  res.json({
    datacenterUrl: creds.datacenterUrl,
    clientId: creds.clientId,
    // Never send the secret back to the browser — just say whether one is set.
    clientSecretSet: Boolean(creds.clientSecret),
    configured: hasCredentialsConfigured(),
  });
});

app.post("/api/settings", requireAuth, (req, res) => {
  try {
    const { datacenterUrl, clientId, clientSecret } = req.body;
    saveAcronisCredentials({ datacenterUrl, clientId, clientSecret });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Manual static-group -> device mapping ──
// Acronis's public API doesn't expose group membership (confirmed against
// their docs), so this lets you enter it once as a reliable fallback that
// takes priority over the best-effort auto-detection everywhere else.
app.get("/api/group-mapping", requireAuth, (req, res) => {
  const mapping = getGroupMapping();
  res.json({
    text: formatGroupMappingText(mapping),
    groupCount: Object.keys(mapping).length,
    active: hasManualMapping(),
  });
});

app.post("/api/group-mapping", requireAuth, (req, res) => {
  try {
    const { text } = req.body;
    const mapping = parseGroupMappingText(text);
    saveGroupMapping(mapping);
    res.json({ ok: true, groupCount: Object.keys(mapping).length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: tenant/customer selector — lets you scope everything below to
// a single tenant instead of aggregating across all of them ──
app.get("/api/tenants", requireAuth, async (req, res) => {
  try {
    const { tenants } = await fetchChildTenants();
    res.json({ tenants: tenants.map((t) => ({ id: t.id, name: t.name, kind: t.kind })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: data for the dashboard panels ──
app.get("/api/summary", requireAuth, async (req, res) => {
  try {
    const tenantId = req.query.tenant_id || undefined;
    const { statuses, staticGroups } = await fetchReportData({ tenantId });
    const uniquePlans = new Set();
    for (const item of statuses) {
      const names = (item.aggregate?.names || "").split(";").map((n) => n.trim()).filter(Boolean);
      names.forEach((n) => uniquePlans.add(n));
    }
    res.json({
      deviceCount: statuses.length,
      staticGroupCount: staticGroups.length,
      planCount: uniquePlans.size,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/incidents", requireAuth, async (req, res) => {
  try {
    const tenantId = req.query.tenant_id || undefined;
    const data = await fetchIncidentData({ tenantId });
    const incidents = buildIncidentRows(data);
    res.json({ incidents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/plans", requireAuth, async (req, res) => {
  try {
    const tenantId = req.query.tenant_id || undefined;
    const data = await fetchReportData({ tenantId });
    const { rows } = buildReportRows(data);
    const { planSummary } = buildGroupedViews(rows);
    res.json({ plans: planSummary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/groups", requireAuth, async (req, res) => {
  try {
    const tenantId = req.query.tenant_id || undefined;
    const data = await fetchReportData({ tenantId });
    const { groupSummary, usingManualMapping } = buildReportRows(data);
    res.json({ groups: groupSummary, usingManualMapping });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/devices", requireAuth, async (req, res) => {
  try {
    const tenantId = req.query.tenant_id || undefined;
    const data = await fetchReportData({ tenantId });
    const { rows } = buildReportRows(data);
    res.json({ rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/alerts", requireAuth, async (req, res) => {
  try {
    const tenantId = req.query.tenant_id || undefined;
    const data = await fetchAlerts({ tenantId });
    const alerts = buildAlertRows(data);
    res.json({ alerts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/group-audit", requireAuth, async (req, res) => {
  try {
    const tenantId = req.query.tenant_id || undefined;
    const data = await fetchGroupAuditLog({ tenantId });
    const entries = buildGroupAuditRows(data);
    res.json({ entries, totalActivitiesScanned: data.totalActivitiesScanned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: download the same xlsx report the MCP tool generates ──
app.get("/api/report/download", requireAuth, async (req, res) => {
  try {
    const tenantId = req.query.tenant_id || undefined;
    const { workbook } = await generateDeviceReportWorkbook({ tenantId });
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `device-report-${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Acronis dashboard listening on http://localhost:${PORT}`);
});
