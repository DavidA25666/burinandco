// Temporary, preview-only: lists what FinerWorks offers our account so we can match the site's wording.
import type { Config } from "@netlify/functions";

const API = "https://v2.api.finerworks.com/v3";

async function fw(path: string, body: unknown = {}) {
  const res = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      web_api_key: Netlify.env.get("FINERWORKS_WEB_API_KEY") ?? "",
      app_key: Netlify.env.get("FINERWORKS_APP_KEY") ?? "",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: `${res.status} ${text.slice(0, 300)}` }; }
}

const n = (v: unknown) => (typeof v === "number" ? +v.toFixed(2) : v);

export default async (req: Request) => {
  if (Netlify.context?.deploy?.context === "production") return new Response("Not found", { status: 404 });
  const part = new URL(req.url).searchParams.get("part") ?? "summary";
  const out: string[] = [];

  if (part === "summary" || part === "media") {
    const m = await fw("list_media_types");
    out.push(`MEDIA (${m.status?.message ?? m.error ?? ""})`);
    for (const t of m.media_types ?? []) out.push(`media ${t.id} | type ${t.product_type_id} | ${t.name} | ${String(t.description ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
  }
  if (part === "summary" || part === "finish") {
    const g = await fw("list_glazing");
    out.push(`GLAZING (${g.status?.message ?? g.error ?? ""})`);
    for (const x of g.glazing ?? []) out.push(`glazing ${x.id} | ${x.name} | from $${n(x.starting_price)} | ${String(x.description ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    const m = await fw("list_mats");
    out.push(`MATS (${m.status?.message ?? m.error ?? ""})`);
    for (const x of m.mats ?? []) out.push(`mat ${x.id} | ${x.name} | ${x.color} core ${x.core_color} | ${n(x.thickness)}in | max ${n(x.max_width)}x${n(x.max_height)}`);
  }
  if (part === "summary" || part === "frames") {
    const c = await fw("list_collections");
    out.push(`COLLECTIONS (${c.status?.message ?? c.error ?? ""})`);
    for (const col of c.collections ?? []) {
      out.push(`collection ${col.id} | ${col.name} | from $${n(col.starting_price)} | ${String(col.description ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
      if (part === "frames") {
        for (const f of col.frames ?? []) out.push(`  frame ${f.id} | ${f.name} | ${f.color} | ${n(f.thickness)}w x ${n(f.depth)}d | max ${n(f.max_width)}x${n(f.max_height)} | ${f.type_description ?? f.type ?? ""} | level ${f.price_level}`);
      }
    }
  }
  return new Response(out.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
};

export const config: Config = { path: "/api/fw-options" };
