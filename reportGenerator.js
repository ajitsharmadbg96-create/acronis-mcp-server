// reportGenerator.js
//
// Builds a device report from Acronis Cyber Protect Cloud data, matching
// the columns shown in the Acronis console's "Machines with agents" view:
// Name, Last backup, Last antivirus scan, Plan — plus Static Group info.
//
// ── Endpoint paths (verified against developer.acronis.com) ──
//   Protection status (name/type/plan/backup+AV timestamps):
//     <datacenter>/api/resource_management/v4/resource_statuses
//   This one endpoint returns everything needed for the main table. Real
//   confirmed example response shape:
//   {
//     "items": [{
//       "aggregate": { "names": "Plan A;Plan B", "status": "idle" },
//       "context": { "id", "name", "type": "resource.machine", ... },
//       "policies": [
//         { "type": "policy.backup.machine", "last_run", "last_success_run" },
//         { "type": "policy.antimalware...", "last_run", "last_success_run" }
//       ]
//     }],
//     "paging": { "cursors": { "total": N } }
//   }
//
// STATIC GROUPS is still the one part without a confirmed dedicated public
// endpoint — implemented as a best-effort filtered resources call. If this
// panel stays empty while everything else works, that's the part to dig
// into further (e.g. by inspecting the Acronis console's own network
// requests when you click a static group folder).
//
// ── EDR Incidents (confirmed real API) ──
// Base URL: <datacenter>/api/mdr/v1, endpoint GET /incidents.
// Confirmed real response shape (from developer.acronis.com):
//   { cursor, items: [{
//       incident_id, incident_short_id, customer_id, host_name, host_domain,
//       incident_categories: ["MALWARE_DETECTED"], incident_time, created_at,
//       updated_at, mitigation_state: "NOT_MITIGATED" | "MITIGATED",
//       severity, positivity, state, verdict, incident_link, agent_version
//   }]}
// Tenant scoping uses the confirmed `customer_id` filter, which supports:
//   - a single tenant ID (single-tenant view)
//   - or(<id1>,<id2>) for multiple specific tenants
//   - direct_children(<partner_id>) / descendants(<partner_id>) for all
//     customers under a partner (this is the "all tenants" aggregate view)
// One part NOT confirmed in public docs: the exact fields for a specific
// file name / process name / historical "action taken" on a mitigated
// incident. The incident detail endpoint (GET /incidents/{id}) confirmed
// returns `response_actions` (actions you COULD take, e.g. isolate/restart/
// shutdown a workload) — not necessarily a log of what was already done.
// This is implemented as a best-effort detail lookup; if it doesn't
// surface a real file/process name for your incidents, share one raw
// detail response and the mapping can be tightened.
import ExcelJS from "exceljs";
import { acronisRequest, resolvePartnerTenantId, fetchChildTenants, getOwnTenantId } from "./acronisClient.js";
import { getGroupMapping } from "./groupMappingStore.js";

const ENDPOINTS = {
  resourceStatuses: "/resource_management/v4/resource_statuses",
  staticGroups: "/resource_management/v4/resources", // best-effort — see note above
  incidents: "/incidents", // under apiBase "/api/mdr/v1" — see fetchIncidentData
};

function findPolicyTimestamp(policies, typeMatch) {
  const match = (policies || []).find((p) => (p.type || "").toLowerCase().includes(typeMatch));
  return match?.last_success_run || match?.last_run || null;
}

/**
 * Builds the customer_id filter value for the EDR incidents API.
 *   - No tenantId given -> all customers under your own partner tenant
 *     (matches the "All customers" view in the Acronis console).
 *   - A specific tenantId given -> just that one tenant (single-tenant view).
 */
async function resolveCustomerIdFilter(tenantId) {
  if (tenantId) return tenantId;
  const partnerTenantId = await resolvePartnerTenantId();
  return `direct_children(${partnerTenantId})`;
}

/**
 * Fetches EDR incidents (first page only, per the API's cursor pagination)
 * for either a single tenant or all customer tenants, and attempts a
 * best-effort detail lookup for a capped number of them to surface
 * file/process/action info beyond what the list endpoint returns.
 */
async function fetchIncidentData({ tenantId, detailLimit = 25 } = {}) {
  const customerIdFilter = await resolveCustomerIdFilter(tenantId);
  const params = new URLSearchParams({ customer_id: customerIdFilter });

  let incidentsRes;
  try {
    incidentsRes = await acronisRequest(`${ENDPOINTS.incidents}?${params.toString()}`, {
      apiBase: "/api/mdr/v1",
    });
  } catch (err) {
    // The "all customers" filter (direct_children(<partner_id>)) confirmed
    // requires a partner-kind tenant. If resolvePartnerTenantId had to fall
    // back to our own (non-partner) tenant ID, this call fails with a 400
    // "the specified tenant is not a partner" — a different failure mode
    // than the 403 handled in resolvePartnerTenantId. Retry scoped to just
    // our own tenant (no descendants) so incidents still show up instead of
    // the whole panel erroring out.
    if (!tenantId && /not a partner/i.test(err.message)) {
      console.error("customer_id=direct_children(...) rejected (tenant not a partner) — retrying scoped to own tenant only:", err.message);
      const ownTenantId = await getOwnTenantId();
      const retryParams = new URLSearchParams({ customer_id: ownTenantId });
      incidentsRes = await acronisRequest(`${ENDPOINTS.incidents}?${retryParams.toString()}`, {
        apiBase: "/api/mdr/v1",
      });
    } else {
      throw err;
    }
  }
  const incidents = incidentsRes?.items ?? [];

  // Best-effort detail fetch for file/process/action info, capped to keep
  // this fast — the rest still get full list-level info (severity,
  // positivity, verdict, category, mitigation state).
  const detailed = await Promise.all(
    incidents.slice(0, detailLimit).map(async (item) => {
      const customerParam = `?customer_id=${encodeURIComponent(item.customer_id)}`;
      let detail = {};
      let activities = [];
      try {
        detail = await acronisRequest(
          `${ENDPOINTS.incidents}/${encodeURIComponent(item.incident_id)}${customerParam}`,
          { apiBase: "/api/mdr/v1" }
        );
      } catch {
        // detail fetch failed — list-level info is still shown
      }
      try {
        // Best-effort: matches the "Incident Activities" tab seen in the
        // Acronis console. Not confirmed in public API docs — if this path
        // is wrong for your account it just fails silently and falls back
        // to the detail/list-level info above.
        const activitiesRes = await acronisRequest(
          `${ENDPOINTS.incidents}/${encodeURIComponent(item.incident_id)}/activities${customerParam}`,
          { apiBase: "/api/mdr/v1" }
        );
        activities = activitiesRes?.items ?? activitiesRes ?? [];
      } catch {
        // Activities endpoint path unconfirmed — silently skip.
      }
      return { ...item, _detail: detail, _activities: activities };
    })
  );

  return { incidents: [...detailed, ...incidents.slice(detailLimit)] };
}

function buildIncidentRows({ incidents }) {
  return incidents.map((item) => {
    const detail = item._detail || {};
    const activities = item._activities || [];

    // "incident_trigger" is confirmed real (seen directly in the Acronis
    // console's incident detail panel, e.g. "cmd.exe") — it's usually the
    // process/command that triggered the detection. file_name/process_name
    // are best-effort fallbacks from the detail endpoint if present.
    const trigger = detail.incident_trigger || item.incident_trigger || null;
    const fileName = detail.file_name || detail.object_name || detail.file?.name || null;
    const processName = detail.process_name || detail.process?.name || trigger || null;

    // Robust to whatever the exact enum value is (MITIGATED,
    // AUTO_MITIGATED, MANUALLY_MITIGATED, etc.) — anything other than
    // NOT_MITIGATED counts as mitigated. This matches the console's
    // summary breakdown of "Automatically mitigated" + "Manually
    // mitigated" as two different mitigated sub-states.
    const mitigated = (item.mitigation_state || "").toUpperCase() !== "NOT_MITIGATED";

    // Prefer a real activity log entry describing what was done, if the
    // (unconfirmed) activities lookup succeeded.
    const latestActivity = activities.length ? activities[activities.length - 1] : null;
    const activityDescription = latestActivity?.description || latestActivity?.action || latestActivity?.message;

    let action;
    if (mitigated) {
      const detailAction = activityDescription || detail.action_taken || detail.remediation_action;
      const howMitigated = (item.mitigation_state || "").toLowerCase().replace(/_/g, " ") || "mitigated";
      action = detailAction
        ? detailAction
        : `${howMitigated.charAt(0).toUpperCase() + howMitigated.slice(1)} — trigger: ${trigger || "not specified"} (see incident link for full remediation detail)`;
    } else {
      action = `Not mitigated — verdict: ${item.verdict || "unknown"}, category: ${(item.incident_categories || []).join(", ") || "unknown"}`;
    }

    return {
      customerId: item.customer_id,
      deviceName: item.host_name || item.host_domain || "Unknown host",
      incidentId: item.incident_short_id ?? item.incident_id,
      category: (item.incident_categories || []).join(", "),
      severity: item.severity,
      positivity: item.positivity,
      mitigated,
      mitigationState: item.mitigation_state,
      verdict: item.verdict,
      fileName: fileName || "—",
      processName: processName || "—",
      action,
      detectedAt: item.incident_time || item.created_at || null,
      incidentLink: item.incident_link || null,
    };
  });
}

// ── Alerts (confirmed real API: /api/alert_manager/v1/alerts) ──
// Confirmed real response shape (from developer.acronis.com):
//   { items: [{
//       id, type, category,
//       details: { title, category, description, fields: { "Device ID": ..., "Malware type": ... } }
//   }]}
// Top-level `severity` is confirmed as a valid filter param; the field is
// assumed to also be present on each item (matching how the filter works),
// but wasn't shown in the fetched example — treated as best-effort here.
async function fetchAlerts({ tenantId } = {}) {
  const tenantParam = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : "";
  const data = await acronisRequest(`/alert_manager/v1/alerts${tenantParam}`);
  const alerts = data?.items ?? data?.data ?? data ?? [];
  return { alerts };
}

function buildAlertRows({ alerts }) {
  return alerts.map((item) => {
    const details = item.details || {};
    return {
      id: item.id,
      title: details.title || item.type || "Alert",
      description: details.description || "",
      category: details.category || item.category || "",
      severity: item.severity || details.severity || "information",
      fields: details.fields || {},
    };
  });
}

// ── Group Modification Audit Log ──
// Uses the confirmed Task Manager API (base <datacenter>/api/task_manager/v2,
// endpoint GET /activities) — this is a REAL, documented endpoint, but
// Acronis's public docs don't confirm exactly which activity `type` values
// correspond to "device moved from static group A to static group B" (the
// console's separate "Audit log" screen doesn't have its own published
// public API endpoint that I could find — this is the closest confirmed
// substitute). This filters activities client-side for anything that looks
// group-related by keyword; if your account logs group changes under a
// type/description this filter doesn't catch, share one raw activity item
// and the filter can be tightened.
const GROUP_ACTIVITY_KEYWORDS = ["group", "static_group", "resource_group", "move_resource"];

async function fetchGroupAuditLog({ tenantId } = {}) {
  // NOTE: the Task Manager Activities API confirmed rejects `tenant_id` as
  // a filter condition ("bad condition field 'tenant_id'") — it's simply
  // not a supported filter here, unlike resource_management/policy_management.
  // So we always fetch unfiltered, then apply any tenant scoping ourselves
  // client-side, best-effort, by checking whether the tenant ID appears
  // anywhere in the raw activity item.
  const data = await acronisRequest(`/activities`, { apiBase: "/api/task_manager/v2" });
  const allActivities = data?.items ?? data?.data ?? data ?? [];

  const tenantScoped = tenantId
    ? allActivities.filter((item) => JSON.stringify(item).includes(tenantId))
    : allActivities;

  const groupActivities = tenantScoped.filter((item) => {
    const haystack = JSON.stringify(item).toLowerCase();
    return GROUP_ACTIVITY_KEYWORDS.some((kw) => haystack.includes(kw));
  });

  return { activities: groupActivities, totalActivitiesScanned: tenantScoped.length };
}

function buildGroupAuditRows({ activities }) {
  return activities.map((item) => ({
    timestamp: item.created_at || item.started_at || item.timestamp || null,
    deviceName: item.resource_name || item.context?.name || item.target?.name || "Unknown device",
    description: item.description || item.title || item.type || "Group membership change",
    performedBy: item.initiator || item.user || item.performed_by || "Unknown",
    rawType: item.type || "",
  }));
}

/**
 * Fetches per-device protection status (name, type, plan, backup/AV
 * timestamps) and the static groups, resiliently.
 *
 * Static group discovery tries, in order, until one returns results:
 *   1. A filtered resources call (fast path, works if your account
 *      supports this exact search syntax)
 *   2. An unfiltered fetch of ALL resources, then client-side splitting
 *      into "groups" (type contains "group") vs everything else — this
 *      is slower but matches whatever your account actually returns,
 *      since Acronis's tree (Machines with agents > CWARE > Windows,
 *      etc.) is built from this same resources endpoint under the hood.
 * Group membership is then derived from whichever linking field is
 * actually present on the data (parent_id/group_id/folder_id on devices,
 * or member_ids/resource_ids/children on groups) — checked in order,
 * first match wins. If your account uses a linking field not in this
 * list, the group names will still show up, just with a "0" count until
 * we add the right field name together.
 */
async function fetchReportData({ tenantId } = {}) {
  const tenantParam = tenantId ? `&tenant_id=${encodeURIComponent(tenantId)}` : "";

  const [statusesRes, allResourcesRes] = await Promise.all([
    acronisRequest(`${ENDPOINTS.resourceStatuses}?limit=1000${tenantParam}`),
    acronisRequest(`${ENDPOINTS.staticGroups}?limit=1000${tenantParam}`).catch((err) => {
      console.error("Resources fetch failed:", err.message);
      return { items: [] };
    }),
  ]);

  const statuses = statusesRes?.items ?? statusesRes?.data ?? statusesRes ?? [];
  const allResources = allResourcesRes?.items ?? allResourcesRes?.data ?? allResourcesRes ?? [];

  // Try the filtered search first (fast path).
  let filteredGroupsRes = null;
  try {
    filteredGroupsRes = await acronisRequest(
      `${ENDPOINTS.staticGroups}?limit=1000&search=${encodeURIComponent("resourceType='resource.group.static'")}${tenantParam}`
    );
  } catch (err) {
    console.error("Filtered static-group search failed, falling back to client-side split:", err.message);
  }
  const filteredGroups = filteredGroupsRes?.items ?? filteredGroupsRes?.data ?? [];

  let staticGroups;
  if (filteredGroups.length > 0) {
    staticGroups = filteredGroups;
  } else {
    // Fallback: split the full resources list ourselves. Anything whose
    // type mentions "group" is treated as a group; this matches folder
    // names like CWARE / Windows shown in the Acronis console tree.
    staticGroups = allResources.filter((r) => (r.type || "").toLowerCase().includes("group"));
    if (staticGroups.length > 0) {
      console.log(`Found ${staticGroups.length} group(s) via client-side split of the full resources list:`, staticGroups.map((g) => g.name).join(", "));
    } else {
      console.error("No groups found via filtered search OR client-side split — check a raw /resource_management/v4/resources response for this account's actual group representation.");
    }
  }

  return { statuses, staticGroups, allResources };
}

/**
 * Builds one row per device, matching the Acronis console's device table
 * columns, plus static group membership and per-group device counts.
 *
 * Group membership priority:
 *   1. Manual mapping (config/group-mapping.json, entered via Settings) —
 *      used whenever it has at least one entry, since Acronis's public API
 *      doesn't expose group membership at all (confirmed against their
 *      official docs) and this is the reliable source of truth instead.
 *   2. Auto-detection heuristics (Strategy A/B below) as a fallback for
 *      accounts where the manual mapping hasn't been filled in yet.
 */
function buildReportRows({ statuses, staticGroups, allResources = [] }) {
  const manualMapping = getGroupMapping();
  const hasManual = Object.keys(manualMapping).length > 0;

  // deviceName -> [group names it belongs to] (manual mapping matches by
  // the device NAME visible in the console, since that's what you can
  // actually copy/paste — not an internal resource ID).
  const groupsByDeviceName = new Map();
  const groupDeviceCounts = new Map();
  // Fallback-mode only: deviceId -> [group names], since auto-detection
  // links by internal resource ID rather than by name.
  let groupsByDeviceId = new Map();

  if (hasManual) {
    for (const [groupName, deviceNames] of Object.entries(manualMapping)) {
      groupDeviceCounts.set(groupName, deviceNames.length);
      for (const deviceName of deviceNames) {
        const list = groupsByDeviceName.get(deviceName) ?? [];
        list.push(groupName);
        groupsByDeviceName.set(deviceName, list);
      }
    }
  } else {
    // ── Fallback: auto-detection heuristics (best-effort) ──
    const groupMembers = new Map();

    for (const group of staticGroups) {
      groupMembers.set(group.name ?? group.id, new Set());
    }

    // Strategy A: the group object itself lists its members directly.
    for (const group of staticGroups) {
      const groupName = group.name ?? group.id;
      const memberIds = group.member_ids ?? group.resource_ids ?? group.children_ids ?? group.children ?? [];
      for (const memberId of memberIds) {
        groupMembers.get(groupName)?.add(memberId);
      }
    }

    // Strategy B: each resource points at its parent group via a linking
    // field. Check every resource we fetched, not just devices.
    const groupIdToName = new Map(staticGroups.map((g) => [g.id, g.name ?? g.id]));
    for (const resource of allResources) {
      const parentRef = resource.parent_id ?? resource.group_id ?? resource.folder_id ?? resource.container_id;
      if (parentRef && groupIdToName.has(parentRef)) {
        const groupName = groupIdToName.get(parentRef);
        groupMembers.get(groupName)?.add(resource.id);
      }
    }

    for (const [groupName, memberSet] of groupMembers.entries()) {
      groupDeviceCounts.set(groupName, memberSet.size);
      for (const memberId of memberSet) {
        const list = groupsByDeviceId.get(memberId) ?? [];
        list.push(groupName);
        groupsByDeviceId.set(memberId, list);
      }
    }
  }

  const rows = statuses.map((item) => {
    const ctx = item.context || {};
    const deviceId = ctx.id;
    const deviceName = ctx.name || ctx.user_defined_name || deviceId;
    const type = (ctx.type || "").replace(/^resource\./, "");
    const planName = item.aggregate?.names || "(no plan assigned)";
    const lastBackup = findPolicyTimestamp(item.policies, "backup");
    const lastAntivirusScan = findPolicyTimestamp(item.policies, "antimalware") || findPolicyTimestamp(item.policies, "antivirus");

    const groupNames = hasManual
      ? groupsByDeviceName.get(deviceName) ?? ["(no static group)"]
      : groupsByDeviceId.get(deviceId) ?? ["(no static group)"];

    return groupNames.map((groupName) => ({
      deviceName,
      type,
      lastBackup,
      lastAntivirusScan,
      planName,
      groupName,
      groupDeviceCount: groupDeviceCounts.get(groupName) ?? 0,
    }));
  }).flat();

  const groupSummary = Array.from(groupDeviceCounts.entries()).map(([name, count]) => ({
    name,
    count,
  }));

  return { rows, groupSummary, usingManualMapping: hasManual };
}

/**
 * From the flat device rows, builds:
 *   - byPlan: one row per (plan, device) — a device with multiple plans
 *     (Acronis shows these as a semicolon-separated combined string, e.g.
 *     "PlanA;PlanB") appears once under each individual plan.
 *   - byGroup: one row per (static group, device), deduplicated.
 *   - planSummary: each plan name + how many devices are on it.
 * This mirrors groupSummary/rows but organized for "list devices under
 * each plan" / "list devices under each static group" style exports.
 */
function buildGroupedViews(rows) {
  const devicesByPlan = new Map(); // planName -> Set(deviceName)
  const devicesByGroup = new Map(); // groupName -> Set(deviceName)

  for (const row of rows) {
    const planNames = (row.planName || "")
      .split(";")
      .map((n) => n.trim())
      .filter(Boolean);
    const effectivePlanNames = planNames.length ? planNames : ["(no plan assigned)"];

    for (const planName of effectivePlanNames) {
      const set = devicesByPlan.get(planName) ?? new Set();
      set.add(row.deviceName);
      devicesByPlan.set(planName, set);
    }

    const set = devicesByGroup.get(row.groupName) ?? new Set();
    set.add(row.deviceName);
    devicesByGroup.set(row.groupName, set);
  }

  const byPlan = Array.from(devicesByPlan.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([planName, deviceSet]) =>
      Array.from(deviceSet)
        .sort()
        .map((deviceName) => ({ planName, deviceName }))
    );

  const byGroup = Array.from(devicesByGroup.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([groupName, deviceSet]) =>
      Array.from(deviceSet)
        .sort()
        .map((deviceName) => ({ groupName, deviceName }))
    );

  const planSummary = Array.from(devicesByPlan.entries())
    .map(([name, deviceSet]) => ({ name, count: deviceSet.size }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { byPlan, byGroup, planSummary };
}

/**
 * Builds the formatted xlsx workbook (two sheets: Device Report, Group Summary).
 * Returns an ExcelJS Workbook — call .xlsx.writeFile() or .xlsx.writeBuffer() on it.
 */
async function buildWorkbook({ rows, groupSummary, byPlan, byGroup, planSummary, incidents = [], groupAudit = [] }, { generatedAt = new Date() } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Acronis MCP Reporting Tool";
  workbook.created = generatedAt;

  const styleHeader = (row) => {
    row.font = { bold: true, name: "Arial" };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } };
  };
  const styleBody = (sheet) => {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.font = { ...(cell.font || {}), name: "Arial" };
      });
    });
  };

  // ── Sheet 1: Device Report ──
  const sheet = workbook.addWorksheet("Device Report");
  sheet.columns = [
    { header: "Device Name", key: "deviceName", width: 30 },
    { header: "Type", key: "type", width: 16 },
    { header: "Last Backup", key: "lastBackup", width: 20 },
    { header: "Last Antivirus Scan", key: "lastAntivirusScan", width: 20 },
    { header: "Plan", key: "planName", width: 30 },
    { header: "Static Group", key: "groupName", width: 25 },
    { header: "Devices in Group", key: "groupDeviceCount", width: 18 },
  ];
  styleHeader(sheet.getRow(1));
  for (const row of rows) {
    sheet.addRow({
      ...row,
      lastBackup: row.lastBackup ? new Date(row.lastBackup) : "Never",
      lastAntivirusScan: row.lastAntivirusScan ? new Date(row.lastAntivirusScan) : "Never",
    });
  }
  styleBody(sheet);
  sheet.autoFilter = { from: "A1", to: "G1" };

  // ── Sheet 2: By Plan — every plan, with the devices under it ──
  const byPlanSheet = workbook.addWorksheet("By Plan");
  byPlanSheet.columns = [
    { header: "Plan", key: "planName", width: 35 },
    { header: "Device Name", key: "deviceName", width: 30 },
  ];
  styleHeader(byPlanSheet.getRow(1));
  for (const row of byPlan) byPlanSheet.addRow(row);
  styleBody(byPlanSheet);
  byPlanSheet.autoFilter = { from: "A1", to: "B1" };

  // ── Sheet 3: By Static Group — every static group, with its devices ──
  const byGroupSheet = workbook.addWorksheet("By Static Group");
  byGroupSheet.columns = [
    { header: "Static Group", key: "groupName", width: 30 },
    { header: "Device Name", key: "deviceName", width: 30 },
  ];
  styleHeader(byGroupSheet.getRow(1));
  for (const row of byGroup) byGroupSheet.addRow(row);
  styleBody(byGroupSheet);
  byGroupSheet.autoFilter = { from: "A1", to: "B1" };

  // ── Sheet 4: Plan Summary ──
  const planSummarySheet = workbook.addWorksheet("Plan Summary");
  planSummarySheet.columns = [
    { header: "Plan", key: "name", width: 35 },
    { header: "Device Count", key: "count", width: 18 },
  ];
  styleHeader(planSummarySheet.getRow(1));
  for (const p of planSummary) planSummarySheet.addRow(p);
  styleBody(planSummarySheet);

  // ── Sheet 5: Group Summary ──
  const summarySheet = workbook.addWorksheet("Group Summary");
  summarySheet.columns = [
    { header: "Static Group", key: "name", width: 30 },
    { header: "Device Count", key: "count", width: 18 },
  ];
  styleHeader(summarySheet.getRow(1));
  for (const g of groupSummary) summarySheet.addRow(g);
  styleBody(summarySheet);

  // ── Sheet 6: EDR Incidents — mitigated action taken, or suspicious file detected ──
  const incidentsSheet = workbook.addWorksheet("EDR Incidents");
  incidentsSheet.columns = [
    { header: "Incident ID", key: "incidentId", width: 14 },
    { header: "Device", key: "deviceName", width: 26 },
    { header: "Detected At", key: "detectedAt", width: 20 },
    { header: "Category", key: "category", width: 22 },
    { header: "Severity", key: "severity", width: 12 },
    { header: "Positivity", key: "positivity", width: 10 },
    { header: "Verdict", key: "verdict", width: 12 },
    { header: "Mitigated", key: "mitigatedLabel", width: 12 },
    { header: "File Name", key: "fileName", width: 28 },
    { header: "Process Name", key: "processName", width: 22 },
    { header: "Action Taken / Status", key: "action", width: 55 },
    { header: "Incident Link", key: "incidentLink", width: 40 },
  ];
  styleHeader(incidentsSheet.getRow(1));
  for (const inc of incidents) {
    incidentsSheet.addRow({
      incidentId: inc.incidentId,
      deviceName: inc.deviceName,
      detectedAt: inc.detectedAt ? new Date(inc.detectedAt) : "Unknown",
      category: inc.category,
      severity: inc.severity,
      positivity: inc.positivity,
      verdict: inc.verdict,
      mitigatedLabel: inc.mitigated ? "Yes" : "No",
      fileName: inc.fileName,
      processName: inc.processName,
      action: inc.action,
      incidentLink: inc.incidentLink,
    });
  }
  styleBody(incidentsSheet);
  incidentsSheet.autoFilter = { from: "A1", to: "L1" };

  // ── Sheet 7: Group Modification Audit Log ──
  const auditSheet = workbook.addWorksheet("Group Modification Audit Log");
  auditSheet.columns = [
    { header: "Timestamp", key: "timestamp", width: 20 },
    { header: "Device", key: "deviceName", width: 26 },
    { header: "Change", key: "description", width: 45 },
    { header: "Performed By", key: "performedBy", width: 22 },
    { header: "Raw Activity Type", key: "rawType", width: 30 },
  ];
  styleHeader(auditSheet.getRow(1));
  for (const entry of groupAudit) {
    auditSheet.addRow({
      timestamp: entry.timestamp ? new Date(entry.timestamp) : "Unknown",
      deviceName: entry.deviceName,
      description: entry.description,
      performedBy: entry.performedBy,
      rawType: entry.rawType,
    });
  }
  styleBody(auditSheet);
  auditSheet.autoFilter = { from: "A1", to: "E1" };
  auditSheet.addRow([]);
  const auditNote = auditSheet.addRow([
    "Built from Acronis's Task Manager Activities API, filtered client-side for group-related keywords — Acronis's public API docs don't confirm a dedicated group-audit endpoint, so this may be incomplete for your account.",
  ]);
  auditNote.font = { italic: true, size: 9, name: "Arial", color: { argb: "FF808080" } };

  // Footer note documenting when/what this was generated from.
  sheet.addRow([]);
  const noteRow = sheet.addRow([`Generated ${generatedAt.toISOString()} from Acronis Cyber Protect Cloud API`]);
  noteRow.font = { italic: true, size: 9, name: "Arial", color: { argb: "FF808080" } };

  return workbook;
}

/**
 * Convenience end-to-end helper: fetch + join + build workbook.
 */
async function generateDeviceReportWorkbook({ tenantId } = {}) {
  const data = await fetchReportData({ tenantId });
  const { rows, groupSummary } = buildReportRows(data);
  const { byPlan, byGroup, planSummary } = buildGroupedViews(rows);

  let incidents = [];
  try {
    const incidentData = await fetchIncidentData({ tenantId });
    incidents = buildIncidentRows(incidentData);
  } catch (err) {
    console.error("EDR incidents fetch failed (included in report as empty):", err.message);
  }

  let groupAudit = [];
  try {
    const auditData = await fetchGroupAuditLog({ tenantId });
    groupAudit = buildGroupAuditRows(auditData);
  } catch (err) {
    console.error("Group audit log fetch failed (included in report as empty):", err.message);
  }

  const workbook = await buildWorkbook({ rows, groupSummary, byPlan, byGroup, planSummary, incidents, groupAudit });
  return { workbook, rows, groupSummary, byPlan, byGroup, planSummary, incidents, groupAudit };
}

export {
  fetchReportData,
  buildReportRows,
  buildGroupedViews,
  fetchIncidentData,
  buildIncidentRows,
  fetchAlerts,
  buildAlertRows,
  fetchGroupAuditLog,
  buildGroupAuditRows,
  buildWorkbook,
  generateDeviceReportWorkbook,
};
