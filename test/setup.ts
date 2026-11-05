// Test doubles for the Netlify runtime: the Netlify global, and an in-memory Netlify Blobs.
import { vi, beforeEach } from "vitest";

export const env = new Map<string, string>();
export const blobs = new Map<string, Map<string, string>>();

(globalThis as any).Netlify = {
  env: { get: (k: string) => env.get(k), has: (k: string) => env.has(k) },
  context: { deploy: { context: "production" } },
};

vi.mock("@netlify/blobs", () => ({
  getStore: (opts: { name: string } | string) => {
    const name = typeof opts === "string" ? opts : opts.name;
    if (!blobs.has(name)) blobs.set(name, new Map());
    const m = blobs.get(name)!;
    return {
      async get(key: string, o?: { type?: string }) {
        const v = m.get(key);
        if (v === undefined) return null;
        return o?.type === "json" ? JSON.parse(v) : v;
      },
      async set(key: string, value: unknown, o?: { onlyIfNew?: boolean }) {
        if (o?.onlyIfNew && m.has(key)) return { modified: false };
        m.set(key, typeof value === "string" ? value : "[binary]");
        return { modified: true };
      },
      async setJSON(key: string, value: unknown) { m.set(key, JSON.stringify(value)); return { modified: true }; },
      async delete(key: string) { m.delete(key); },
      async list(o?: { prefix?: string }) {
        return { blobs: [...m.keys()].filter((k) => !o?.prefix || k.startsWith(o.prefix)).map((key) => ({ key, etag: "" })) };
      },
    };
  },
}));

beforeEach(() => {
  blobs.clear();
  env.clear();
  // No real network in tests: every outside call fails the way an unreachable service would.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "offline in tests" } }), { status: 503 })));
});
