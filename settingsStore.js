// settingsStore.js
//
// Lets Acronis API credentials be entered through the dashboard's Settings
// page instead of hand-editing .env. Credentials entered via the UI are
// saved to config/acronis-credentials.json (gitignored) and take priority;
// if that file doesn't exist yet, we fall back to the ACRONIS_* values from
// .env so existing setups keep working unchanged.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, "config");
const CREDENTIALS_FILE = path.join(CONFIG_DIR, "acronis-credentials.json");

function readCredentialsFile() {
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Returns the active Acronis credentials: UI-saved file first, then .env
 * as a fallback for any field not set in the file.
 */
function getAcronisCredentials() {
  const fromFile = readCredentialsFile() || {};
  return {
    datacenterUrl: fromFile.datacenterUrl || process.env.ACRONIS_DATACENTER_URL || "",
    clientId: fromFile.clientId || process.env.ACRONIS_CLIENT_ID || "",
    clientSecret: fromFile.clientSecret || process.env.ACRONIS_CLIENT_SECRET || "",
  };
}

/**
 * Saves credentials entered via the Settings page. Only overwrites fields
 * that were actually provided (so, e.g., leaving the secret blank on an
 * edit keeps the previously saved secret rather than wiping it).
 */
function saveAcronisCredentials({ datacenterUrl, clientId, clientSecret }) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const existing = readCredentialsFile() || {};
  const updated = {
    datacenterUrl: datacenterUrl !== undefined && datacenterUrl !== "" ? datacenterUrl : existing.datacenterUrl || "",
    clientId: clientId !== undefined && clientId !== "" ? clientId : existing.clientId || "",
    clientSecret: clientSecret !== undefined && clientSecret !== "" ? clientSecret : existing.clientSecret || "",
  };
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(updated, null, 2), {
    mode: 0o600, // owner read/write only
  });
  return updated;
}

function hasCredentialsConfigured() {
  const creds = getAcronisCredentials();
  return Boolean(creds.datacenterUrl && creds.clientId && creds.clientSecret);
}

export { getAcronisCredentials, saveAcronisCredentials, hasCredentialsConfigured };
