// Street address suggestions for the order form, from Google Places (New).
//
// The browser never sees the API key: it asks /api/address, and this file asks Google.
// One typing session (many suggestion calls, then one pick) shares a session token, so Google
// bills it as a single session; low volume stays inside Google's free monthly allowance.
// Without GOOGLE_PLACES_API_KEY every call answers 503 and the form works as a plain form.

export type Suggestion = { id: string; main: string; sub: string };
export type Address = { line1: string; line2: string; city: string; state: string; zip: string };

type Deps = { key?: string; fetch?: typeof fetch };

const PLACES = "https://places.googleapis.com/v1";
const tokenOk = (t: string) => /^[A-Za-z0-9_-]{8,64}$/.test(t);

export async function suggest(input: string, session: string, deps: Deps): Promise<Suggestion[]> {
  const res = await (deps.fetch ?? fetch)(`${PLACES}/places:autocomplete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": deps.key!, "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat" },
    body: JSON.stringify({ input, sessionToken: session, includedRegionCodes: ["us"], includedPrimaryTypes: ["street_address", "premise", "subpremise"], languageCode: "en" }),
  });
  if (!res.ok) throw new Error(`Places autocomplete ${res.status}`);
  const data: any = await res.json();
  return (data.suggestions ?? [])
    .map((s: any) => s.placePrediction)
    .filter((p: any) => p?.placeId)
    .slice(0, 5)
    .map((p: any) => ({ id: p.placeId, main: p.structuredFormat?.mainText?.text ?? "", sub: (p.structuredFormat?.secondaryText?.text ?? "").replace(/, USA$/, "") }));
}

export async function details(placeId: string, session: string, deps: Deps): Promise<Address> {
  const res = await (deps.fetch ?? fetch)(`${PLACES}/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(session)}&languageCode=en&regionCode=us`, {
    headers: { "X-Goog-Api-Key": deps.key!, "X-Goog-FieldMask": "addressComponents" },
  });
  if (!res.ok) throw new Error(`Places details ${res.status}`);
  const data: any = await res.json();
  const parts = data.addressComponents ?? [];
  const get = (type: string, short = false) => {
    const c = parts.find((p: any) => p.types?.includes(type));
    return c ? (short ? c.shortText : c.longText) ?? "" : "";
  };
  const street = [get("street_number"), get("route", true)].filter(Boolean).join(" ");
  const unit = get("subpremise");
  return {
    line1: street || get("premise"),
    line2: unit ? (/^\d/.test(unit) ? `#${unit}` : unit) : "",
    city: get("locality") || get("postal_town") || get("sublocality") || get("neighborhood") || get("administrative_area_level_3"),
    state: get("administrative_area_level_1", true),
    zip: get("postal_code"),
  };
}

// GET /api/address?q=12 Main&s=<session>  → { suggestions: [...] }
// GET /api/address?id=<placeId>&s=<session> → { address: {...} }
export async function handleAddress(req: Request, deps: Deps): Promise<Response> {
  if (!deps.key) return Response.json({ error: "Address lookup isn't set up." }, { status: 503 });
  const url = new URL(req.url);
  const session = url.searchParams.get("s") ?? "";
  if (!tokenOk(session)) return Response.json({ error: "Bad session." }, { status: 400 });
  const noStore = { "Cache-Control": "no-store" };
  try {
    const id = url.searchParams.get("id");
    if (id) {
      if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) return Response.json({ error: "Bad place." }, { status: 400 });
      return Response.json({ address: await details(id, session, deps) }, { headers: noStore });
    }
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
    if (q.length < 3) return Response.json({ suggestions: [] }, { headers: noStore });
    return Response.json({ suggestions: await suggest(q, session, deps) }, { headers: noStore });
  } catch (e) {
    console.error("address lookup failed", e);
    return Response.json({ error: "Address lookup is unavailable." }, { status: 502 });
  }
}
