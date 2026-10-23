import type { Config } from "@netlify/functions";
import sharp from "sharp";
import { getOrder, filesStore } from "../shared/store.mts";
import { verify } from "../shared/sign.mts";
import { WATERMARK_TILE } from "../shared/watermark-tile.mts";

// The customer's proof: sharp enough to check every detail on screen, but watermarked
// edge to edge and only 1600 px, so it can't stand in for the print.
export default async (req: Request) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("o") ?? "";
  const order = verify(`proof:${id}`, url.searchParams.get("t")) ? await getOrder(id) : null;
  const latest = order?.renders.at(-1);
  if (!order || !latest) return new Response("Not found", { status: 404 });

  const files = filesStore();
  const key = `proof/${order.id}/${order.renders.length}`;
  let jpg = await files.get(key, { type: "arrayBuffer" });
  if (!jpg) {
    const render = await files.get(latest.key, { type: "arrayBuffer" });
    if (!render) return new Response("Not found", { status: 404 });
    const small = await sharp(Buffer.from(render)).resize(1600, 1600, { fit: "inside" }).removeAlpha().toBuffer();
    const buf = await sharp(small).composite([{ input: WATERMARK_TILE, tile: true }]).jpeg({ quality: 78 }).toBuffer();
    jpg = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    await files.set(key, jpg);
  }
  return new Response(jpg, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" } });
};

export const config: Config = { path: "/api/proof-image" };
