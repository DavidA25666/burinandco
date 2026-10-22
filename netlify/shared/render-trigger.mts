import { sign } from "./sign.mts";

export async function triggerRender(origin: string, orderId: string, adjustment: string | null) {
  const res = await fetch(`${origin}/.netlify/functions/render-background`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-sig": sign(`render:${orderId}`) },
    body: JSON.stringify({ orderId, adjustment }),
  });
  if (res.status !== 202 && !res.ok) throw new Error(`Rendering couldn't start (status ${res.status}).`);
}

export async function triggerPrintFile(origin: string, orderId: string) {
  const res = await fetch(`${origin}/.netlify/functions/print-background`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-sig": sign(`print:${orderId}`) },
    body: JSON.stringify({ orderId }),
  });
  if (res.status !== 202 && !res.ok) throw new Error(`The print file couldn't start (status ${res.status}).`);
}
