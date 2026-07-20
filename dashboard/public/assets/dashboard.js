// dashboard/public/assets/dashboard.js
// Vanilla JS — no build step needed, so this runs directly in the browser
// once the Express server serves this file.

let allDeviceRows = [];
let currentFilter = "";
let sortState = { key: null, direction: 1 };
let selectedTenantId = ""; // "" = All customers
let currentPage = 1;
const PAGE_SIZE = 10;

let groupChartInstance = null;
let severityChartInstance = null;

function tenantParam() {
  return selectedTenantId ? `?tenant_id=${encodeURIComponent(selectedTenantId)}` : "";
}

async function fetchJSON(url) {
  const res = await fetch(url);
  const contentType = res.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await res.json() : null;

  if (!res.ok) {
    const message = (body && body.error) || `${url} -> ${res.status}`;
    throw new Error(message);
  }
  return body;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTime(t) {
  return t ? new Date(t).toLocaleString() : "Never";
}

function updateTimestamp() {
  const el = document.getElementById("lastUpdated");
  el.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

async function loadTenants() {
  const select = document.getElementById("tenantSelect");
  try {
    const { tenants } = await fetchJSON("/api/tenants");
    for (const t of tenants) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      select.appendChild(opt);
    }
  } catch (err) {
    console.error("Failed to load tenants", err);
    // Non-fatal — dashboard still works scoped to "All customers".
  }
}

async function loadSummary() {
  try {
    const { deviceCount, staticGroupCount, planCount } = await fetchJSON(`/api/summary${tenantParam()}`);
    document.getElementById("statDevices").textContent = deviceCount;
    document.getElementById("statGroups").textContent = staticGroupCount;
    document.getElementById("statPlans").textContent = planCount;
  } catch (err) {
    console.error("Failed to load summary", err);
    document.getElementById("statDevices").textContent = "err";
    document.getElementById("statGroups").textContent = "err";
    document.getElementById("statPlans").textContent = "err";
  }
}

function getFilteredSortedRows() {
  let rows = allDeviceRows;

  if (currentFilter) {
    const needle = currentFilter.toLowerCase();
    rows = rows.filter(
      (r) =>
        (r.deviceName || "").toLowerCase().includes(needle) ||
        (r.planName || "").toLowerCase().includes(needle) ||
        (r.groupName || "").toLowerCase().includes(needle)
    );
  }

  if (sortState.key) {
    rows = [...rows].sort((a, b) => {
      const av = a[sortState.key] ?? "";
      const bv = b[sortState.key] ?? "";
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortState.direction;
      return String(av).localeCompare(String(bv)) * sortState.direction;
    });
  }

  return rows;
}

function renderPagination(totalRows) {
  const el = document.getElementById("devicePagination");
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  el.innerHTML = `
    <button type="button" id="prevPageBtn" ${currentPage <= 1 ? "disabled" : ""}>‹ Prev</button>
    <span class="page-info">Page ${currentPage} of ${totalPages}</span>
    <button type="button" id="nextPageBtn" ${currentPage >= totalPages ? "disabled" : ""}>Next ›</button>
  `;
  document.getElementById("prevPageBtn").addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage -= 1;
      renderDeviceTable();
    }
  });
  document.getElementById("nextPageBtn").addEventListener("click", () => {
    currentPage += 1;
    renderDeviceTable();
  });
}

function renderDeviceTable() {
  const tbody = document.getElementById("deviceTableBody");
  const sub = document.getElementById("deviceCountSub");

  const rows = getFilteredSortedRows();
  sub.textContent = currentFilter ? `${rows.length} of ${allDeviceRows.length} rows` : `${rows.length} rows`;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No matching devices.</td></tr>`;
    document.getElementById("devicePagination").innerHTML = "";
    return;
  }

  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  tbody.innerHTML = pageRows
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(r.deviceName)}</td>
        <td>${escapeHtml(r.type || "")}</td>
        <td>${escapeHtml(formatTime(r.lastBackup))}</td>
        <td>${escapeHtml(formatTime(r.lastAntivirusScan))}</td>
        <td>${escapeHtml(r.planName)}</td>
        <td>${escapeHtml(r.groupName)}</td>
        <td>${escapeHtml(r.groupDeviceCount)}</td>
      </tr>`
    )
    .join("");

  renderPagination(rows.length);
}

async function loadDevices() {
  const tbody = document.getElementById("deviceTableBody");
  try {
    const { rows } = await fetchJSON(`/api/devices${tenantParam()}`);
    allDeviceRows = rows;
    currentPage = 1;
    renderDeviceTable();
    renderGroupChart();
  } catch (err) {
    console.error("Failed to load devices", err);
    allDeviceRows = [];
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function setFilter(value) {
  currentFilter = value;
  currentPage = 1;
  document.getElementById("deviceSearch").value = value;
  document.getElementById("clearFilterBtn").hidden = !value;
  renderDeviceTable();
  document.getElementById("deviceTable").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function loadPlans() {
  const list = document.getElementById("planList");
  try {
    const { plans } = await fetchJSON(`/api/plans${tenantParam()}`);
    if (plans.length === 0) {
      list.innerHTML = `<li class="empty-row">No plans found.</li>`;
      return;
    }
    list.innerHTML = plans
      .map(
        (p) =>
          `<li class="clickable-row" data-filter="${escapeHtml(p.name)}"><span>${escapeHtml(p.name)}</span><span class="count">${escapeHtml(p.count)}</span></li>`
      )
      .join("");
    list.querySelectorAll("[data-filter]").forEach((el) => {
      el.addEventListener("click", () => setFilter(el.getAttribute("data-filter")));
    });
  } catch (err) {
    console.error("Failed to load plans", err);
    list.innerHTML = `<li class="empty-row">Error: ${escapeHtml(err.message)}</li>`;
  }
}

let lastGroupSummary = [];

async function loadGroups() {
  const list = document.getElementById("groupList");
  try {
    const { groups, usingManualMapping } = await fetchJSON(`/api/groups${tenantParam()}`);
    lastGroupSummary = groups;
    const sourceNote = usingManualMapping
      ? "manual mapping active"
      : "auto-detected — set a manual mapping in Settings for reliability";
    document.getElementById("groupCountSub").textContent =
      `${groups.length} group(s), ${sourceNote} — click to expand its devices`;

    if (groups.length === 0) {
      list.innerHTML = `<li class="empty-row">No static groups found.</li>`;
      renderGroupChart();
      return;
    }

    list.innerHTML = groups
      .map(
        (g, i) => `
        <li>
          <div class="group-row" data-group="${escapeHtml(g.name)}" data-idx="${i}">
            <span><span class="group-expand-arrow" id="arrow-${i}">▶</span>${escapeHtml(g.name)}</span>
            <span class="count">${escapeHtml(g.count)}</span>
          </div>
          <ul class="group-devices" id="devices-${i}" hidden></ul>
        </li>`
      )
      .join("");

    list.querySelectorAll(".group-row").forEach((el) => {
      el.addEventListener("click", () => toggleGroupExpand(el));
    });

    renderGroupChart();
  } catch (err) {
    console.error("Failed to load groups", err);
    list.innerHTML = `<li class="empty-row">Error: ${escapeHtml(err.message)}</li>`;
  }
}

function toggleGroupExpand(rowEl) {
  const idx = rowEl.getAttribute("data-idx");
  const groupName = rowEl.getAttribute("data-group");
  const devicesEl = document.getElementById(`devices-${idx}`);
  const arrowEl = document.getElementById(`arrow-${idx}`);

  const isOpen = !devicesEl.hidden;
  if (isOpen) {
    devicesEl.hidden = true;
    arrowEl.classList.remove("open");
    return;
  }

  arrowEl.classList.add("open");
  devicesEl.hidden = false;

  if (allDeviceRows.length === 0) {
    devicesEl.innerHTML = `<li>Loading devices…</li>`;
    return;
  }

  const members = allDeviceRows.filter((r) => r.groupName === groupName);
  devicesEl.innerHTML = members.length
    ? members.map((m) => `<li>${escapeHtml(m.deviceName)}</li>`).join("")
    : `<li>No devices found for this group.</li>`;
}

let lastIncidents = [];

async function loadIncidents() {
  const tbody = document.getElementById("incidentTableBody");
  const sub = document.getElementById("incidentCountSub");
  try {
    const { incidents } = await fetchJSON(`/api/incidents${tenantParam()}`);
    lastIncidents = incidents;
    sub.textContent = `${incidents.length} incident(s) — mitigated action taken, or suspicious file/process detected`;
    if (incidents.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="empty-row">No EDR incidents found.</td></tr>`;
      renderSeverityChart();
      return;
    }
    tbody.innerHTML = incidents
      .map((inc) => {
        const statusClass = inc.mitigated ? "status-pill--ok" : "status-pill--warn";
        const statusLabel = inc.mitigated ? "Mitigated" : "Not Mitigated";
        const idCell = inc.incidentLink
          ? `<a href="${escapeHtml(inc.incidentLink)}" target="_blank" rel="noopener">${escapeHtml(inc.incidentId)}</a>`
          : escapeHtml(inc.incidentId);
        return `<tr>
          <td>${idCell}</td>
          <td>${escapeHtml(inc.deviceName)}</td>
          <td>${escapeHtml(formatTime(inc.detectedAt))}</td>
          <td>${escapeHtml(inc.category)}</td>
          <td>${escapeHtml(inc.severity)}</td>
          <td>${escapeHtml(inc.positivity)}${inc.positivity != null ? "/10" : ""}</td>
          <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
          <td>${escapeHtml(inc.fileName)}</td>
          <td>${escapeHtml(inc.processName)}</td>
          <td>${escapeHtml(inc.action)}</td>
        </tr>`;
      })
      .join("");
    renderSeverityChart();
  } catch (err) {
    console.error("Failed to load incidents", err);
    tbody.innerHTML = `<tr><td colspan="10" class="empty-row">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadAuditLog() {
  const tbody = document.getElementById("auditTableBody");
  try {
    const { entries, totalActivitiesScanned } = await fetchJSON(`/api/group-audit${tenantParam()}`);
    document.getElementById("auditCountSub").textContent =
      `${entries.length} group change(s) found, scanned ${totalActivitiesScanned} activities`;
    if (entries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-row">No group modification activity found.</td></tr>`;
      return;
    }
    tbody.innerHTML = entries
      .map(
        (e) => `<tr>
          <td>${escapeHtml(formatTime(e.timestamp))}</td>
          <td>${escapeHtml(e.deviceName)}</td>
          <td>${escapeHtml(e.description)}</td>
          <td>${escapeHtml(e.performedBy)}</td>
        </tr>`
      )
      .join("");
  } catch (err) {
    console.error("Failed to load group audit log", err);
    tbody.innerHTML = `<tr><td colspan="4" class="empty-row">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadAlerts() {
  const list = document.getElementById("alertList");
  try {
    const { alerts } = await fetchJSON(`/api/alerts${tenantParam()}`);
    if (alerts.length === 0) {
      list.innerHTML = `<li class="empty-row">No active alerts.</li>`;
      return;
    }
    list.innerHTML = alerts
      .map((a) => {
        const severity = (a.severity || "information").toLowerCase();
        return `<li>
          <span><span class="alert-sev alert-sev--${severity}">${escapeHtml(severity)}</span>${escapeHtml(a.title)}${a.description ? " — " + escapeHtml(a.description) : ""}</span>
        </li>`;
      })
      .join("");
  } catch (err) {
    console.error("Failed to load alerts", err);
    list.innerHTML = `<li class="empty-row">Error: ${escapeHtml(err.message)}</li>`;
  }
}

async function checkConfigured() {
  try {
    const { configured } = await fetchJSON("/api/settings");
    document.getElementById("configBanner").hidden = configured;
  } catch (err) {
    console.error("Failed to check settings", err);
  }
}

function updateDownloadLink() {
  const link = document.getElementById("downloadReportLink");
  link.href = `/api/report/download${tenantParam()}`;
}

// ── Charts ──
const CHART_COLORS = ["#3ED9C0", "#5B8DEF", "#F5A623", "#F0506E", "#8592AD", "#B47EDE", "#57D9A3"];

function renderGroupChart() {
  const canvas = document.getElementById("groupChart");
  const emptyEl = document.getElementById("groupChartEmpty");
  if (!canvas || typeof Chart === "undefined") return;
  if (groupChartInstance) groupChartInstance.destroy();

  const labels = lastGroupSummary.map((g) => g.name);
  const data = lastGroupSummary.map((g) => g.count);
  const hasAnyDevices = data.some((c) => c > 0);

  if (labels.length === 0 || !hasAnyDevices) {
    canvas.hidden = true;
    if (emptyEl) {
      emptyEl.hidden = false;
      emptyEl.innerHTML = labels.length === 0
        ? `No static groups found. Acronis's API doesn't expose group membership directly — add a mapping on the <a href="/settings">Settings</a> page.`
        : `Groups were found (${labels.length}) but have 0 devices linked. Add a Group → Device mapping on the <a href="/settings">Settings</a> page.`;
    }
    return;
  }
  canvas.hidden = false;
  if (emptyEl) emptyEl.hidden = true;

  groupChartInstance = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{ label: "Devices", data, backgroundColor: "#3ED9C0", borderRadius: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#8592AD", font: { size: 10 } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: "#8592AD", precision: 0 }, grid: { color: "#232E45" } },
      },
    },
  });
}

function renderSeverityChart() {
  const canvas = document.getElementById("severityChart");
  const emptyEl = document.getElementById("severityChartEmpty");
  if (!canvas || typeof Chart === "undefined") return;
  if (severityChartInstance) severityChartInstance.destroy();

  const counts = {};
  for (const inc of lastIncidents) {
    const sev = (inc.severity || "UNKNOWN").toUpperCase();
    counts[sev] = (counts[sev] || 0) + 1;
  }
  const labels = Object.keys(counts);
  const data = Object.values(counts);

  if (labels.length === 0) {
    canvas.hidden = true;
    if (emptyEl) {
      emptyEl.hidden = false;
      emptyEl.textContent = "No EDR incidents in range.";
    }
    return;
  }
  canvas.hidden = false;
  if (emptyEl) emptyEl.hidden = true;

  severityChartInstance = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data, backgroundColor: CHART_COLORS, borderColor: "#131B2C", borderWidth: 2 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: "#8592AD", font: { size: 11 }, boxWidth: 12 } },
      },
    },
  });
}

async function loadAll() {
  updateDownloadLink();
  await Promise.all([loadSummary(), loadDevices(), loadPlans(), loadGroups(), loadIncidents(), loadAuditLog(), loadAlerts(), checkConfigured()]);
  updateTimestamp();
}

document.getElementById("tenantSelect").addEventListener("change", (e) => {
  selectedTenantId = e.target.value;
  setFilter(""); // clear any device-table filter, scope has changed
  loadAll();
});

document.getElementById("deviceSearch").addEventListener("input", (e) => {
  currentFilter = e.target.value;
  currentPage = 1;
  document.getElementById("clearFilterBtn").hidden = !currentFilter;
  renderDeviceTable();
});

document.getElementById("clearFilterBtn").addEventListener("click", () => setFilter(""));

document.getElementById("refreshBtn").addEventListener("click", () => {
  loadAll();
});

document.querySelectorAll("#deviceTable thead th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.getAttribute("data-sort");
    if (sortState.key === key) {
      sortState.direction *= -1;
    } else {
      sortState = { key, direction: 1 };
    }
    currentPage = 1;
    document.querySelectorAll("#deviceTable thead .sort-arrow").forEach((s) => (s.textContent = ""));
    th.querySelector(".sort-arrow").textContent = sortState.direction === 1 ? "▲" : "▼";
    renderDeviceTable();
  });
});

document.getElementById("footerYear").textContent = new Date().getFullYear();

loadTenants();
loadAll();
