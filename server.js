// server.js
// Remote MCP server exposing Acronis Cyber Protect Cloud data as tools for Claude.
// Uses the MCP Streamable HTTP transport so it can be added to claude.ai
// as a custom connector (Settings -> Connectors -> Add custom connector).

import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { acronisRequest } from "./acronisClient.js";
import { generateDeviceReportWorkbook } from "./reportGenerator.js";

const PORT = process.env.PORT || 3000;

function buildServer() {
  const server = new McpServer({
    name: "acronis-cyber-protect",
    version: "1.0.0",
  });

  // --- Tool: list_devices ---
  server.tool(
    "list_devices",
    "List devices/resources registered in Acronis Cyber Protect Cloud, optionally filtered by tenant.",
    {
      tenant_id: z.string().optional().describe("Restrict results to a specific tenant ID"),
      limit: z.number().int().min(1).max(200).default(50).describe("Max number of devices to return"),
    },
    async ({ tenant_id, limit }) => {
      const params = new URLSearchParams();
      if (tenant_id) params.set("tenant_id", tenant_id);
      params.set("limit", String(limit));
      const data = await acronisRequest(`/resource_management/v4/resources?${params.toString()}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // --- Tool: get_backup_status ---
  // Uses the confirmed /resource_management/v4/resource_statuses endpoint.
  // NOTE: the exact query parameter for filtering by a single resource ID
  // isn't confirmed from public docs — this passes resource_id as a filter,
  // but if your account expects a different param name, check the response
  // and adjust here.
  server.tool(
    "get_backup_status",
    "Get the latest backup status/results for a specific device (resource) by its ID.",
    {
      resource_id: z.string().describe("The Acronis resource/device ID"),
    },
    async ({ resource_id }) => {
      const data = await acronisRequest(
        `/resource_management/v4/resource_statuses?resource_id=${encodeURIComponent(resource_id)}`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // --- Tool: list_alerts ---
  server.tool(
    "list_alerts",
    "List active alerts (e.g. failed backups, missed schedules, security threats) across the tenant.",
    {
      severity: z
        .enum(["critical", "error", "warning", "information"])
        .optional()
        .describe("Filter alerts by severity"),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async ({ severity, limit }) => {
      const params = new URLSearchParams();
      if (severity) params.set("severity", severity);
      params.set("limit", String(limit));
      const data = await acronisRequest(`/alert_manager/v1/alerts?${params.toString()}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // --- Tool: trigger_backup ---
  // NOTE: this is a write action. Review Acronis's Task Manager / Resource &
  // Policy Management API docs and adjust the endpoint/payload to match the
  // exact plan/policy execution model for your account before enabling this.
  server.tool(
    "trigger_backup",
    "Trigger an on-demand backup run for a device using an existing backup plan.",
    {
      resource_id: z.string().describe("The Acronis resource/device ID"),
      plan_id: z.string().describe("The backup plan ID to execute"),
    },
    async ({ resource_id, plan_id }) => {
      const data = await acronisRequest(`/resources/${encodeURIComponent(resource_id)}/plans/${encodeURIComponent(plan_id)}/run`, {
        method: "POST",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data ?? { status: "triggered" }, null, 2) }],
      };
    }
  );

  // --- Tool: generate_device_report ---
  // Builds a formatted .xlsx report: one row per (device, plan, static group),
  // plus a Group Summary sheet with device counts per static group.
  // Returns the file as a base64-encoded resource so Claude can present it
  // as a downloadable attachment in chat.
  server.tool(
    "generate_device_report",
    "Generate an Excel (.xlsx) report showing each device's assigned backup plan, its static group, and how many devices are in that static group. Returns a downloadable spreadsheet.",
    {
      tenant_id: z.string().optional().describe("Restrict the report to a specific tenant ID"),
    },
    async ({ tenant_id }) => {
      const { workbook, rows, groupSummary } = await generateDeviceReportWorkbook({
        tenantId: tenant_id,
      });
      const buffer = await workbook.xlsx.writeBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      const filename = `device-report-${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`;

      return {
        content: [
          {
            type: "text",
            text: `Generated report with ${rows.length} rows across ${groupSummary.length} static groups.`,
          },
          {
            type: "resource",
            resource: {
              uri: `attachment://${filename}`,
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              blob: base64,
            },
          },
        ],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Streamable HTTP transport: one endpoint handling POST (client->server) and
// GET (server->client streaming) per the MCP spec.
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Acronis MCP server listening on port ${PORT}`);
});
