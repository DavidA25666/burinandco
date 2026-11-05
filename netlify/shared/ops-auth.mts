// Tenfold HQ Admin Plug: the reference verifier from docs/SITE_CONTRACT.md §1, as supplied by HQ.
import { createHmac, timingSafeEqual } from 'node:crypto'

export type OpsVerify = { ok: true; body: string } | { ok: false; reason: 'missing_secret' | 'missing_headers' | 'bad_timestamp' | 'expired' | 'bad_signature' }

/** Verifies a signed Tenfold HQ request. Read the body only through this (it returns the raw text). */
export async function verifyOps(request: Request, secret: string | undefined = process.env.PORTFOLIO_OPS_SECRET, nowMs: number = Date.now()): Promise<OpsVerify> {
  if (!secret) return { ok: false, reason: 'missing_secret' }
  const ts = request.headers.get('x-portfolio-timestamp')
  const sig = request.headers.get('x-portfolio-signature')
  if (!ts || !sig) return { ok: false, reason: 'missing_headers' }
  if (!/^\d{9,11}$/.test(ts)) return { ok: false, reason: 'bad_timestamp' }
  if (Math.abs(Math.floor(nowMs / 1000) - Number(ts)) > 300) return { ok: false, reason: 'expired' }
  const url = new URL(request.url)
  // GET has no body: the canonical string ends with "." + ""
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text()
  const canonical = `${ts}.${request.method.toUpperCase()}.${url.pathname}${url.search}.${body}`
  // the secret is used as a plain string, not hex/base64-decoded
  const expected = 'v1=' + createHmac('sha256', secret).update(canonical).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(sig.trim())
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' }
  return { ok: true, body }
}

/** 401 for a failed check (no details beyond the reason code). */
export function opsUnauthorized(reason: string) {
  return new Response(JSON.stringify({ ok: false, code: 'unauthorized', reason }), { status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

/** Every /api/ops/* answer goes through this. */
export function opsJson(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
