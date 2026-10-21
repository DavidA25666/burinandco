// Products, prices and prompts live here. Prices are in cents and include US shipping.
export type StyleId = "engraved" | "noir";
export type CategoryId = "automobile" | "yacht" | "aircraft" | "building" | "other";
export type SizeId = "16x20" | "24x30" | "30x40";
export type FrameId = "walnut" | "ebony";

export const STYLES: Record<StyleId, { name: string; blurb: string; prompt: string }> = {
  engraved: {
    name: "Engraved",
    blurb: "Black ink on warm cotton rag, like a vintage patent plate.",
    prompt: "black ink only on warm cream cotton paper. Every tone is built from fine parallel engraved lines that swell thicker in shadow and thin out in highlight, with cross-hatching only in the deepest shadows",
  },
  noir: {
    name: "Noir",
    blurb: "Silver lines on matte black. Dramatic and modern.",
    prompt: "silver-white engraved lines on matte black paper, so the lines represent light rather than shadow. Every tone is built from fine parallel lines that swell where the light is strongest and fade into the black paper in shadow",
  },
};

export function styleInfo(id: string) {
  return STYLES[id as StyleId] ?? { name: id, blurb: "", prompt: STYLES.engraved.prompt };
}

export const CATEGORIES: Record<CategoryId, { name: string; subject: string; fidelity: string; portrait: boolean }> = {
  automobile: {
    name: "Automobile", subject: "car", portrait: false,
    fidelity: "the exact make, model, body shape, proportions, wheels, badges, lights, mirrors, grille, trim, livery and stance",
  },
  yacht: {
    name: "Yacht", subject: "yacht", portrait: false,
    fidelity: "the exact hull shape, sheer line, superstructure, window shapes and count, masts, rigging, radar arches, tenders and any hull markings",
  },
  aircraft: {
    name: "Aircraft", subject: "aircraft", portrait: false,
    fidelity: "the exact airframe, wing and tail shape, engines, window count and spacing, landing gear, livery lines and registration markings",
  },
  building: {
    name: "Building", subject: "building", portrait: true,
    fidelity: "the exact massing, number of floors, window grid, setbacks, crown, entrance and facade materials",
  },
  other: {
    name: "Something else", subject: "subject", portrait: false,
    fidelity: "the exact shape, proportions and every visible detail",
  },
};

export function categoryInfo(id: string) {
  return CATEGORIES[id as CategoryId] ?? CATEGORIES.other;
}

export const FRAMES: Record<FrameId, string> = { walnut: "American walnut", ebony: "Ebonized oak" };

export const COLLECTOR_PRICE = 30000;

// aspect is landscape (width:height); portrait subjects such as buildings flip it.
export const SIZES: Record<SizeId, { name: string; price: number; aspect: string }> = {
  "16x20": { name: "16 × 20 in", price: 39500, aspect: "5:4" },
  "24x30": { name: "24 × 30 in", price: 69500, aspect: "5:4" },
  "30x40": { name: "30 × 40 in", price: 125000, aspect: "4:3" },
};

export function aspectFor(size: string, category: string) {
  const a = (SIZES[size as SizeId] ?? SIZES["16x20"]).aspect;
  return categoryInfo(category).portrait ? a.split(":").reverse().join(":") : a;
}

export function buildPrompt(style: string, category: string, customerNotes?: string | null, adjustment?: string | null) {
  const c = categoryInfo(category);
  const lines = [
    `Turn the ${c.subject} in this photo into a fine banknote-style line engraving, like the portraits on currency or a 19th-century share certificate, suitable for framing as a fine-art print.`,
    `Accuracy matters most: keep ${c.fidelity} exactly as in the photo, from the same viewing angle. Do not add, remove or invent anything.`,
    `Style: ${styleInfo(style).prompt}. Let the lines follow the curves and planes of the ${c.subject}. Show reflections on paint, metal and glass as clean streaks.`,
    `Show the ${c.subject} alone, centered, with generous empty paper around it and a soft engraved ground line or shadow. Remove the background, people, other vehicles and clutter.`,
    "No text, lettering, signature, border or frame. Crisp lines, no blur or gray wash.",
  ];
  if (customerNotes) lines.push(`Customer request: ${customerNotes}`);
  if (adjustment) lines.push(`Adjustments for this version: ${adjustment}`);
  return lines.join("\n");
}
