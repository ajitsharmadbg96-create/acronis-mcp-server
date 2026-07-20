// scripts/generate-report.js
//
// Standalone CLI: fetches Device / Plan / Static Group data from Acronis
// and writes a formatted .xlsx report to the reports/ folder.
//
// Usage:
//   node scripts/generate-report.js
//   node scripts/generate-report.js --tenant-id=abc123
//   node scripts/generate-report.js --out=./reports/my-report.xlsx

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { generateDeviceReportWorkbook } from "../reportGenerator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = args["tenant-id"];

  const reportsDir = path.join(__dirname, "..", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = args.out
    ? path.resolve(args.out)
    : path.join(reportsDir, `device-report-${timestamp}.xlsx`);

  console.log("Fetching data from Acronis and building report...");
  const { workbook, rows, groupSummary } = await generateDeviceReportWorkbook({ tenantId });

  await workbook.xlsx.writeFile(outPath);

  console.log(`\nReport written to: ${outPath}`);
  console.log(`  Device/plan/group rows: ${rows.length}`);
  console.log(`  Static groups summarized: ${groupSummary.length}`);
}

main().catch((err) => {
  console.error("Failed to generate report:", err);
  process.exit(1);
});
