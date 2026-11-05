import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { searchConsoleBlock, serviceAccountJwt } from "../netlify/shared/search-console.mts";
import siteConfig from "../netlify/functions/site-config.mts";
import { env } from "./setup.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const sa = { client_email: "hq-reader@tenfold.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const envOf = (o: Record<string, string>) => (k: string) => o[k];

describe("Search Console → HQ SEO block", () => {
  it("shows HQ's connect hint when the env vars are missing", async () => {
    const b: any = await searchConsoleBlock("2026-10-01", "2026-10-30", { env: envOf({}) });
    expect(b.configured).toBe(false);
    expect(b.message).toMatch(/GOOGLE_SERVICE_ACCOUNT_JSON/);
  });

  it("signs a valid RS256 service-account JWT for the read-only scope", () => {
    const jwt = serviceAccountJwt(sa, 1_800_000_000);
    const [h, c, s] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    expect(claims).toMatchObject({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/webmasters.readonly", exp: 1_800_003_600 });
    const v = createVerify("RSA-SHA256"); v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("returns totals, the previous period, queries and pages", async () => {
    const calls: any[] = [];
    const fakeFetch = (async (url: string, init: any) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "tok" });
      const body = JSON.parse(init.body); calls.push({ url, body, auth: init.headers.Authorization });
      if (body.dimensions?.[0] === "query") return Response.json({ rows: [{ keys: ["porsche portrait"], clicks: 5, impressions: 100, ctr: 0.05, position: 9.04 }] });
      if (body.dimensions?.[0] === "page") return Response.json({ rows: [{ keys: ["https://burinandco.com/"], clicks: 9, impressions: 400, ctr: 0.0225, position: 12 }] });
      return Response.json({ rows: [{ clicks: body.startDate === "2026-10-01" ? 12 : 4, impressions: 600, ctr: 0.02, position: 18.23 }] });
    }) as unknown as typeof fetch;
    const b: any = await searchConsoleBlock("2026-10-01", "2026-10-30", { env: envOf({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(sa), GSC_PROPERTY: "sc-domain:burinandco.com" }), fetch: fakeFetch, cache: false });
    expect(b).toMatchObject({ configured: true, property: "sc-domain:burinandco.com", totals: { clicks: 12, impressions: 600, position: 18.2 } });
    expect(b.previous).toMatchObject({ from: "2026-09-01", to: "2026-09-30", clicks: 4 });
    expect(b.queries[0]).toMatchObject({ query: "porsche portrait", clicks: 5 });
    expect(b.pages[0]).toMatchObject({ page: "https://burinandco.com/", clicks: 9 });
    expect(calls[0].url).toContain(encodeURIComponent("sc-domain:burinandco.com"));
    expect(calls[0].auth).toBe("Bearer tok");
  });

  it("reports a Google error as a message instead of throwing", async () => {
    const fakeFetch = (async () => Response.json({ error: "invalid_grant", error_description: "Invalid JWT" }, { status: 400 })) as unknown as typeof fetch;
    const b: any = await searchConsoleBlock("2026-10-01", "2026-10-30", { env: envOf({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(sa), GSC_PROPERTY: "sc-domain:burinandco.com" }), fetch: fakeFetch, cache: false });
    expect(b.configured).toBe(false);
    expect(b.message).toMatch(/Invalid JWT/);
  });
});

describe("Google tag", () => {
  it("site-config exposes GA4_MEASUREMENT_ID", async () => {
    env.set("GA4_MEASUREMENT_ID", "G-EF2GH3T386");
    const json: any = await (await siteConfig()).json();
    expect(json.ga4MeasurementId).toBe("G-EF2GH3T386");
  });

  it("consent.js loads Google only after Accept and never sends the proof token", () => {
    const js = readFileSync("public/consent.js", "utf8");
    expect(js).toMatch(/function start\(\)[\s\S]*loadGoogle\(cfg\.ga4MeasurementId\)/);
    expect(js).toContain('"consent", "default"');
    expect(js).toContain("page_location: cleanLocation()");
    expect(js).toContain("Purchase: \"purchase\"");
  });

  it("robots.txt keeps proofs and admin out of Google and points to the sitemap", () => {
    const robots = readFileSync("public/robots.txt", "utf8");
    for (const p of ["/admin.html", "/proof.html", "/lab.html"]) expect(robots).toContain(`Disallow: ${p}`);
    expect(robots).toContain("Sitemap: https://burinandco.com/sitemap.xml");
  });
});
