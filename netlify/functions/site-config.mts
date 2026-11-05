import type { Config } from "@netlify/functions";

// Public IDs the storefront's consent script needs. These are not secrets: a Pixel ID and a
// Clarity project ID are visible in any page that loads them. The CAPI token stays server-side.
export default async () => {
  const id = (name: string) => Netlify.env.get(name)?.trim() || null;
  return Response.json(
    { metaPixelId: id("META_PIXEL_ID"), clarityProjectId: id("CLARITY_PROJECT_ID") },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
};

export const config: Config = { path: "/api/site-config" };
