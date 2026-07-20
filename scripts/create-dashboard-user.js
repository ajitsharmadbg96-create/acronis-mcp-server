// scripts/create-dashboard-user.js
//
// Generates a bcrypt hash for your dashboard password. Put the result in
// .env as DASHBOARD_PASSWORD_HASH — never store the plain password.
//
// Usage:
//   node scripts/create-dashboard-user.js "your-password-here"

import bcrypt from "bcryptjs";

const password = process.argv[2];

if (!password) {
  console.error("Usage: node scripts/create-dashboard-user.js \"your-password\"");
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);

console.log("\nAdd these to your .env file:\n");
console.log(`DASHBOARD_USERNAME=admin`);
console.log(`DASHBOARD_PASSWORD_HASH=${hash}`);
console.log(`DASHBOARD_SESSION_SECRET=${bcrypt.genSaltSync(12).replace(/\W/g, "")}${Date.now()}`);
console.log("\n(Change DASHBOARD_USERNAME to whatever you like.)\n");
