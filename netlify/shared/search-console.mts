// Google Search Console → HQ's SEO block (SITE_CONTRACT §3c `seo.search_console`).
// Reads the Search Analytics API with a read-only Google service account. The service account's
// email must be added as a user (Restricted is enough) on the Search Console property.
// Env: GOOGLE_SERVICE_ACCOUNT_JSON (the key file's JSON, secret) and GSC_PROPERTY
// (e.g. "sc-domain:burinandco.com"). With either missing, HQ shows its "connect" hint.
import { createSign } from "node:crypto";
import { addDays, cached } from "./ops-store.mts";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }

export interface GscRow { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }
type Fetch = typeof fetch;

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export function serviceAccountJwt(sa: ServiceAccount, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(sa.private_key).toString("base64url")}`;
}

async function accessToken(sa: ServiceAccount, f: Fetch) {
  const res = await f(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountJwt(sa) }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !data.access_token) throw new Error(`Google sign-in failed: ${data.error_description || data.error || res.status}`);
  return data.access_token;
}

async function query(token: string, property: string, body: Record<string, unknown>, f: Fetch): Promise<GscRow[]> {
  const res = await f(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { rows?: GscRow[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`Search Console: ${data.error?.message || res.status}`);
  return data.rows ?? [];
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const totals = (r: GscRow | undefined) => r
  ? { clicks: r.clicks, impressions: r.impressions, ctr: round(r.ctr), position: round(r.position, 1) }
  : { clicks: 0, impressions: 0, ctr: 0, position: 0 };

/** The `search_console` object for /api/ops/metrics. Never throws. */
export async function searchConsoleBlock(from: string, to: string, opts: { env?: (k: string) => string | undefined; fetch?: Fetch; cache?: boolean } = {}) {
  const env = opts.env ?? ((k: string) => Netlify.env.get(k));
  const raw = env("GOOGLE_SERVICE_ACCOUNT_JSON")?.trim();
  const property = env("GSC_PROPERTY")?.trim();
  if (!raw || !property) {
    return { configured: false, message: "Search Console isn't connected to the store yet. Set GOOGLE_SERVICE_ACCOUNT_JSON and GSC_PROPERTY in Netlify, and add the service account as a user on the Search Console property." };
  }
  let sa: ServiceAccount;
  try { sa = JSON.parse(raw); if (!sa.client_email || !sa.private_key) throw new Error(); }
  catch { return { configured: false, message: "GOOGLE_SERVICE_ACCOUNT_JSON isn't a valid service account key (needs client_email and private_key)." }; }

  const f = opts.fetch ?? fetch;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  const prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(days - 1));
  const load = async () => {
    const token = await accessToken(sa, f);
    const [cur, prev, queries, pages] = await Promise.all([
      query(token, property, { startDate: from, endDate: to }, f),
      query(token, property, { startDate: prevFrom, endDate: prevTo }, f),
      query(token, property, { startDate: from, endDate: to, dimensions: ["query"], rowLimit: 25 }, f),
      query(token, property, { startDate: from, endDate: to, dimensions: ["page"], rowLimit: 25 }, f),
    ]);
    const row = (r: GscRow, key: string) => ({ [key]: r.keys?.[0] ?? "", clicks: r.clicks, impressions: r.impressions, ctr: round(r.ctr), position: round(r.position, 1) });
    return {
      configured: true, property, from, to,
      totals: totals(cur[0]),
      previous: { from: prevFrom, to: prevTo, ...totals(prev[0]) },
      queries: queries.map((r) => row(r, "query")),
      pages: pages.map((r) => row(r, "page")),
    };
  };
  try {
    // HQ pulls every 10 minutes; Search Console data only moves about once a day.
    return opts.cache === false ? await load() : await cached(`gsc/${property}/${from}/${to}`, 6 * 3600e3, load);
  } catch (e) {
    return { configured: false, property, message: e instanceof Error ? e.message : String(e) };
  }
}
