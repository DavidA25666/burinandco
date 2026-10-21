import type { Config } from "@netlify/functions";
import { STYLES, SIZES, FRAMES, CATEGORIES, COLLECTOR_PRICE } from "../shared/catalog.mts";

export default async () =>
  Response.json({
    categories: Object.entries(CATEGORIES).map(([id, c]) => ({ id, name: c.name })),
    styles: Object.entries(STYLES).map(([id, s]) => ({ id, name: s.name, blurb: s.blurb })),
    sizes: Object.entries(SIZES).map(([id, s]) => ({ id, name: s.name, price: s.price })),
    frames: Object.entries(FRAMES).map(([id, name]) => ({ id, name })),
    collectorPrice: COLLECTOR_PRICE,
  });

export const config: Config = { path: "/api/catalog" };
