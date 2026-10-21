import type { Config } from "@netlify/functions";
import { filesStore } from "../shared/store.mts";
import { verify } from "../shared/sign.mts";

function sniff(b: Uint8Array) {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return "image/webp";
  return "application/octet-stream";
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const key = url.searchParams.get("k");
  if (!key || !verify(key, url.searchParams.get("s"))) return new Response("Not found", { status: 404 });
  const data = await filesStore().get(key, { type: "arrayBuffer" });
  if (!data) return new Response("Not found", { status: 404 });
  return new Response(data, {
    headers: { "Content-Type": sniff(new Uint8Array(data)), "Cache-Control": "private, max-age=3600" },
  });
};

export const config: Config = { path: "/api/files" };
