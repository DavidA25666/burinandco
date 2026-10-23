import type { Config } from "@netlify/functions";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { getOrder, filesStore } from "../shared/store.mts";
import { verify } from "../shared/sign.mts";
import { WATERMARK_TILE } from "../shared/watermark-tile.mts";
import { composePrint } from "../shared/print-file.mts";
import { printPixels } from "../shared/catalog.mts";

// The customer's proof: laid out like the print (shape and caption), sharp enough to check every
// detail on screen, but watermarked edge to edge and only 1600 px, so it can't stand in for the print.
export default async (req: Request) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("o") ?? "";
  const order = verify(`proof:${id}`, url.searchParams.get("t")) ? await getOrder(id) : null;
  const latest = order?.renders.at(-1);
  if (!order || !latest) return new Response("Not found", { status: 404 });

  const files = filesStore();
  // The layout depends on the size and caption, which can change after the render.
  const layout = createHash("sha1").update(`${order.size}|${order.caption ?? ""}`).digest("hex").slice(0, 10);
  const key = `proof/${order.id}/${order.renders.length}-${layout}`;
  let jpg = await files.get(key, { type: "arrayBuffer" });
  if (!jpg) {
    const render = await files.get(latest.key, { type: "arrayBuffer" });
    if (!render) return new Response("Not found", { status: 404 });
    const print = printPixels(order.size, order.category);
    const scale = 1600 / Math.max(print.width, print.height);
    const laid = await composePrint(new Uint8Array(render), Math.round(print.width * scale), Math.round(print.height * scale), order.caption);
    const small = await laid.png().toBuffer();
    const buf = await sharp(small).composite([{ input: WATERMARK_TILE, tile: true }]).jpeg({ quality: 78 }).toBuffer();
    jpg = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    await files.set(key, jpg);
  }
  return new Response(jpg, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" } });
};

export const config: Config = { path: "/api/proof-image" };
