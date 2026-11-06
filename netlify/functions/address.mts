import type { Config } from "@netlify/functions";
import { handleAddress } from "../shared/address.mts";

// Street address suggestions for the Ship to form. See netlify/shared/address.mts.
export default (req: Request) => handleAddress(req, { key: Netlify.env.get("GOOGLE_PLACES_API_KEY")?.trim() || undefined });

export const config: Config = { path: "/api/address" };
