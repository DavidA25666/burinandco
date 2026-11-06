import { describe, it, expect } from "vitest";
import { handleAddress } from "../netlify/shared/address.mts";

const S = "abcdef0123456789";
const req = (qs: string) => new Request("https://burinandco.com/api/address?" + qs);

describe("street address suggestions (/api/address)", () => {
  it("answers 503 with no key, so the form stays a plain form", async () => {
    const res = await handleAddress(req(`q=12+Main&s=${S}`), {});
    expect(res.status).toBe(503);
  });

  it("returns US suggestions with the key sent server-side and the session token passed along", async () => {
    let sent: any;
    const fakeFetch = (async (url: string, init: any) => {
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return Response.json({ suggestions: [{ placePrediction: { placeId: "ChIJ_abc123456", structuredFormat: { mainText: { text: "12 Main Street" }, secondaryText: { text: "Duxbury, MA, USA" } } } }] });
    }) as unknown as typeof fetch;
    const res = await handleAddress(req(`q=12+Main&s=${S}`), { key: "k", fetch: fakeFetch });
    expect(await res.json()).toEqual({ suggestions: [{ id: "ChIJ_abc123456", main: "12 Main Street", sub: "Duxbury, MA" }] });
    expect(sent.url).toContain("places:autocomplete");
    expect(sent.headers["X-Goog-Api-Key"]).toBe("k");
    expect(sent.body).toMatchObject({ input: "12 Main", sessionToken: S, includedRegionCodes: ["us"] });
  });

  it("skips Google for fewer than 3 characters", async () => {
    const res = await handleAddress(req(`q=12&s=${S}`), { key: "k", fetch: (() => { throw new Error("called"); }) as any });
    expect(await res.json()).toEqual({ suggestions: [] });
  });

  it("turns a picked place into line1, apt, city, state and ZIP", async () => {
    const fakeFetch = (async () => Response.json({ addressComponents: [
      { longText: "12", shortText: "12", types: ["street_number"] },
      { longText: "Main Street", shortText: "Main St", types: ["route"] },
      { longText: "4", shortText: "4", types: ["subpremise"] },
      { longText: "Duxbury", shortText: "Duxbury", types: ["locality", "political"] },
      { longText: "Massachusetts", shortText: "MA", types: ["administrative_area_level_1", "political"] },
      { longText: "02332", shortText: "02332", types: ["postal_code"] },
    ] })) as unknown as typeof fetch;
    const res = await handleAddress(req(`id=ChIJ_abc123456&s=${S}`), { key: "k", fetch: fakeFetch });
    expect(await res.json()).toEqual({ address: { line1: "12 Main St", line2: "#4", city: "Duxbury", state: "MA", zip: "02332" } });
  });

  it("rejects bad session tokens and place ids, and hides Google errors", async () => {
    expect((await handleAddress(req("q=12+Main&s=x"), { key: "k" })).status).toBe(400);
    expect((await handleAddress(req(`id=../../x&s=${S}`), { key: "k" })).status).toBe(400);
    const down = (async () => new Response("quota", { status: 429 })) as unknown as typeof fetch;
    expect((await handleAddress(req(`q=12+Main&s=${S}`), { key: "k", fetch: down })).status).toBe(502);
  });
});
