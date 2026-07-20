// acronisClient.js
// Thin wrapper around the Acronis Cyber Protect Cloud REST API.
// Handles OAuth2 client-credentials auth and automatic token refresh.
//
// Credentials are resolved dynamically on every call via settingsStore, so
// entering/updating them on the dashboard's Settings page takes effect
// immediately, with no restart needed. .env values still work as a
// fallback for anyone who prefers editing .env directly.

import "dotenv/config";
import { getAcronisCredentials } from "./settingsStore.js";

let cachedToken = null; // { access_token, expires_at, forClientId }

async function getAccessToken() {
  const { datacenterUrl, clientId, clientSecret } = getAcronisCredentials();

  if (!datacenterUrl || !clientId || !clientSecret) {
    throw new Error(
      "Acronis credentials are not configured yet. Set them on the dashboard's Settings page, or in .env (ACRONIS_DATACENTER_URL, ACRONIS_CLIENT_ID, ACRONIS_CLIENT_SECRET)."
    );
  }

  const now = Date.now();
  if (
    cachedToken &&
    cachedToken.forClientId === clientId &&
    cachedToken.expires_at > now + 60_000
  ) {
    // Reuse token if it still has more than 60s left and credentials haven't changed.
    return cachedToken.access_token;
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(`${datacenterUrl}/api/2/idp/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Acronis token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  // Acronis tokens are typically valid for 2 hours; expires_in is in seconds if provided.
  const ttlMs = (data.expires_in ? Number(data.expires_in) : 7200) * 1000;
  cachedToken = {
    access_token: data.access_token,
    expires_at: now + ttlMs,
    forClientId: clientId,
  };
  return cachedToken.access_token;
}

async function acronisRequest(path, { method = "GET", body, apiBase = "/api" } = {}) {
  const { datacenterUrl } = getAcronisCredentials();
  const token = await getAccessToken();
  const res = await fetch(`${datacenterUrl}${apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Acronis API error ${res.status} on ${path}: ${text}`);
  }

  // Some endpoints return no content.
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return null;
}

/**
 * Returns the ID of your own (partner) tenant — the root of everything
 * your API client can see. Needed for filters like
 * customer_id=direct_children(<partner_id>) on the EDR incidents API.
 *
 * Tries decoding it from the access token's JWT payload first (fast, no
 * extra request); falls back to GET /clients/{client_id} if that field
 * isn't present.
 */
let cachedOwnTenantId = null;

async function getOwnTenantId() {
  if (cachedOwnTenantId) return cachedOwnTenantId;

  const token = await getAccessToken();
  try {
    const payloadB64 = token.split(".")[1];
    const payloadJson = Buffer.from(payloadB64, "base64").toString("utf-8");
    const payload = JSON.parse(payloadJson);
    const claimTenantId = payload.tenant_id || payload.tid || payload.tenant;
    if (claimTenantId) {
      cachedOwnTenantId = claimTenantId;
      return cachedOwnTenantId;
    }
  } catch {
    // Not a decodable JWT, or no tenant claim — fall through to the API call below.
  }

  const { clientId } = getAcronisCredentials();
  const clientInfo = await acronisRequest(`/clients/${encodeURIComponent(clientId)}`, { apiBase: "/api/2" });
  cachedOwnTenantId = clientInfo?.tenant_id;
  return cachedOwnTenantId;
}

/**
 * Lists the child tenants (customers) visible to your API client — used
 * to populate the tenant/customer selector in the dashboard so reports
 * can be scoped to a single tenant instead of everything at once.
 */
async function fetchChildTenants() {
  const partnerTenantId = await resolvePartnerTenantId();
  const data = await acronisRequest(`/tenants?parent_id=${encodeURIComponent(partnerTenantId)}`, { apiBase: "/api/2" });
  const items = data?.items ?? data ?? [];
  return { ownTenantId: partnerTenantId, tenants: items };
}

/**
 * Resolves the nearest ancestor tenant of "kind": "partner" starting from
 * your own tenant. Needed because filters like
 * customer_id=direct_children(<id>) on the EDR incidents API require a
 * partner-kind tenant specifically — and API clients can be created at
 * any level (a customer, a folder, a sub-partner, etc.), not necessarily
 * at the top partner level. Confirmed real error if you pass a non-partner
 * ID: {"code":"badRequest","message":"error resolving tenants: the
 * specified tenant is not a partner"}.
 *
 * Walks up via each tenant's `parent_id` until it finds one with
 * `kind: "partner"`, caching the result. Capped at 10 hops to avoid any
 * risk of an infinite loop if the hierarchy data is ever malformed.
 */
let cachedPartnerTenantId = null;

async function resolvePartnerTenantId() {
  if (cachedPartnerTenantId) return cachedPartnerTenantId;

  let currentId = await getOwnTenantId();
  for (let hop = 0; hop < 10; hop++) {
    let tenant;
    try {
      tenant = await acronisRequest(`/tenants/${encodeURIComponent(currentId)}`, { apiBase: "/api/2" });
    } catch (err) {
      // A hop up the hierarchy can 403 even though the lower tenant we
      // started from is fully readable — e.g. the API client's role has
      // access to its own tenant and its descendants, but not to an
      // ancestor tenant above it (real confirmed error: "authZ trustee
      // resolution failed: no appropriate access policy found in trustee
      // scope for requested target"). That must NOT crash whatever
      // called this (e.g. the EDR Incidents fetch) — stop walking and
      // fall back below instead of throwing.
      console.error(`Stopped walking tenant hierarchy at ${currentId} (${err.message}) — falling back to your own tenant ID.`);
      break;
    }
    if (!tenant) break;
    if (tenant.kind === "partner") {
      cachedPartnerTenantId = tenant.id;
      return cachedPartnerTenantId;
    }
    if (!tenant.parent_id) break; // reached the top without finding "partner"
    currentId = tenant.parent_id;
  }

  // Couldn't find a partner ancestor — fall back to your own tenant ID.
  // Filters requiring a partner tenant specifically will still fail in
  // this case, but everything else (single-tenant views, resources,
  // policies, alerts) is unaffected since those don't need this at all.
  console.error(
    "Could not resolve a partner-kind tenant in your account's hierarchy — falling back to your own tenant ID. The 'All customers' aggregate view for EDR Incidents may not work; selecting a specific tenant should still work fine."
  );
  cachedPartnerTenantId = await getOwnTenantId();
  return cachedPartnerTenantId;
}

export { acronisRequest, getAccessToken, getOwnTenantId, fetchChildTenants, resolvePartnerTenantId };
