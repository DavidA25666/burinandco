import type { Config } from "@netlify/functions";
import { STYLES, SIZES, FRAMES, CATEGORIES, COLLECTOR_PRICE } from "../shared/catalog.mts";
import { getSettings } from "../shared/ops-store.mts";
import { priceCents } from "../shared/pricing.mts";

// The storefront reads prices, the headline and maintenance mode from here, so changes made in
// Tenfold HQ show on the site straight away.
export default async () => {
  const settings = await getSettings();
  return Response.json({
    categories: Object.entries(CATEGORIES).map(([id, c]) => ({ id, name: c.name })),
    styles: Object.entries(STYLES).map(([id, s]) => ({ id, name: s.name, blurb: s.blurb })),
    sizes: Object.entries(SIZES).filter(([, s]) => !s.retired).map(([id, s]) => ({ id, name: s.name, price: priceCents(id, settings) })),
    frames: Object.entries(FRAMES).map(([id, name]) => ({ id, name })),
    collectorPrice: COLLECTOR_PRICE,
    headline: settings.headline,
    maintenance: settings.maintenance,
  }, { headers: { "Cache-Control": "no-store" } });
};

export const config: Config = { path: "/api/catalog" };
