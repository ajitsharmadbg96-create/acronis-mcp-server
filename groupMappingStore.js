// groupMappingStore.js
//
// A manually-maintained static-group -> device-name mapping, stored
// locally. This exists because Acronis's public Resource and Policy
// Management API does not expose group membership at all (confirmed
// against their official docs — the resource object schema has no
// parent/group field). Until we have a confirmed real endpoint for this
// (see the DevTools-capture instructions), this manual mapping is the
// reliable source of truth for "which devices are in which static group".
//
// Entered via the dashboard's Settings page in a simple format:
//   GroupName: device1, device2, device3
//   AnotherGroup: device4, device5
//
// Stored as JSON: { "GroupName": ["device1", "device2", ...], ... }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, "config");
const MAPPING_FILE = path.join(CONFIG_DIR, "group-mapping.json");

function getGroupMapping() {
  try {
    const raw = fs.readFileSync(MAPPING_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Parses the simple textarea format used on the Settings page:
 *   GroupName: device1, device2, device3
 * one group per line. Blank lines and lines without a colon are skipped.
 */
function parseGroupMappingText(text) {
  const mapping = {};
  const lines = (text || "").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes(":")) continue;
    const colonIndex = trimmed.indexOf(":");
    const groupName = trimmed.slice(0, colonIndex).trim();
    const devices = trimmed
      .slice(colonIndex + 1)
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    if (groupName) {
      mapping[groupName] = devices;
    }
  }
  return mapping;
}

/**
 * Converts the stored mapping back into the editable textarea format,
 * so the Settings page can show what's currently saved.
 */
function formatGroupMappingText(mapping) {
  return Object.entries(mapping)
    .map(([group, devices]) => `${group}: ${devices.join(", ")}`)
    .join("\n");
}

function saveGroupMapping(mapping) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2), { mode: 0o600 });
  return mapping;
}

function hasManualMapping() {
  const mapping = getGroupMapping();
  return Object.keys(mapping).length > 0;
}

export { getGroupMapping, saveGroupMapping, parseGroupMappingText, formatGroupMappingText, hasManualMapping };
