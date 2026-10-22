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
  // Stream the file: a buffered function response is capped at 6 MB, and 4K PNG renders are often bigger.
  const stream = await filesStore().get(key, { type: "stream" });
  if (!stream) return new Response("Not found", { status: 404 });
  const reader = stream.getReader();
  const first = await reader.read();
  if (first.done) return new Response("Not found", { status: 404 });
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(first.value); },
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) c.close(); else c.enqueue(value);
    },
    cancel() { reader.cancel(); },
  });
  return new Response(body, {
    headers: { "Content-Type": sniff(first.value), "Cache-Control": "private, max-age=3600" },
  });
};

export const config: Config = { path: "/api/files" };
