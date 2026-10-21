import { createHmac, createHash, timingSafeEqual } from "node:crypto";

function secret() {
  const s = Netlify.env.get("SITE_SECRET");
  if (!s) throw new Error("SITE_SECRET is not set");
  return s;
}

export function sign(value: string) {
  return createHmac("sha256", secret()).update(value).digest("base64url").slice(0, 32);
}

export function verify(value: string, sig: string | null | undefined) {
  if (!sig) return false;
  const expected = Buffer.from(sign(value));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// Unguessable links to stored files, so Replicate, the print lab and the proof page can fetch them.
export function fileUrl(origin: string, key: string) {
  return `${origin}/api/files?k=${encodeURIComponent(key)}&s=${sign(key)}`;
}

export function isAdmin(req: Request) {
  const pw = Netlify.env.get("ADMIN_PASSWORD");
  if (!pw) return false;
  const a = createHash("sha256").update(pw).digest();
  const b = createHash("sha256").update(req.headers.get("x-admin-password") ?? "").digest();
  return timingSafeEqual(a, b);
}
