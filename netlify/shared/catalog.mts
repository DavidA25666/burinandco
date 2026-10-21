// Products, prices and prompts live here. Prices are in cents and include US shipping.
export type StyleId = "engraved" | "atelier" | "prism";
export type CategoryId = "automobile" | "yacht" | "aircraft" | "building" | "other";
export type SizeId = "16x20" | "24x30" | "30x40";
export type FrameId = "walnut" | "ebony";

interface Style {
  name: string;
  blurb: string;
  intro: string;     // {subject} is replaced with the subject, e.g. "car"
  prompt: string;
  setting: string;
  finish: string;
}

// Styles customers can order. Lab-only candidates live in LAB_STYLES until one is chosen.
export const STYLES: Partial<Record<StyleId, Style>> = {
  engraved: {
    name: "Engraved",
    blurb: "Black ink on warm cotton rag, like a vintage patent plate.",
    intro: "Turn the {subject} in this photo into a fine banknote-style line engraving, like the portraits on currency or a 19th-century share certificate, suitable for framing as a fine-art print.",
    prompt: "black ink only on warm cream cotton paper. Every tone is built from fine parallel engraved lines that swell thicker in shadow and thin out in highlight, with cross-hatching only in the deepest shadows. Let the lines follow the curves and planes of the {subject}. Show reflections on paint, metal and glass as clean streaks",
    setting: "Show the {subject} alone, centered, with generous empty paper around it and a soft engraved ground line or shadow. Remove the background, people, other vehicles and clutter.",
    finish: "No text, lettering, signature, border or frame. Crisp lines, no blur or gray wash.",
  },
  atelier: {
    name: "Atelier",
    blurb: "A precise ink drawing in your true colors, with bold sweeps of paint behind it.",
    intro: "Turn the {subject} in this photo into a fine-art mixed-media drawing for a framed gallery print: a precise ink rendering of the {subject} in its true colors, set against bold, expressive sweeps of color.",
    prompt: "crisp, confident black ink linework defines every edge, panel line and detail, like a master automotive or architectural designer's presentation drawing. Fill the {subject} with its exact colors from the photo (paint, trim, glass tint, wheels) in rich layered gouache and marker with clean highlights and reflections, so the color is instantly recognizable as the owner's. Behind and around it, three to five large, fast, sweeping brushstrokes of that same color plus one or two harmonious accent colors suggest motion and energy. The strokes are loose and painterly, overlap the edges of the {subject} slightly, and fade out into the paper",
    setting: "Show the {subject} alone, centered, on warm white cotton paper with generous margins. Remove the real background, people, other vehicles and clutter; the color sweeps are the only background.",
    finish: "No text, lettering, signature, border or frame. The {subject} itself stays sharp and exact; only the background strokes are loose. Not a watercolor, not a cartoon, not a photo filter.",
  },
};

export const LAB_STYLES: Record<StyleId, Style> = {
  ...(STYLES as Record<StyleId, Style>),
  prism: {
    name: "Prism (test)",
    blurb: "A precise drawing over abstract planes of color, like a mid-century poster.",
    intro: "Turn the {subject} in this photo into a bold modern art print: a precise, finely drawn {subject} in its true colors over an abstract composition of overlapping color planes.",
    prompt: "fine, exact ink and colored-pencil linework captures every edge, panel line and detail, and the {subject} keeps its exact colors from the photo. Behind it, large overlapping translucent geometric shapes, arcs and bands in the {subject}'s own color plus two harmonious accent colors fracture the space like a mid-century modernist or Bauhaus poster. A few of the planes pass through the {subject} as subtle tints without hiding any detail",
    setting: "Show the {subject} centered and fully visible, with the abstract color shapes filling the space around it on warm white paper. Remove the real background, people, other vehicles and clutter.",
    finish: "No text, lettering, signature, border or frame. Clean, crisp edges on the {subject}; no blur, no photo filter look.",
  },
};

// Retired styles stay so old orders and tests still read correctly.
const RETIRED: Record<string, Style> = {
  noir: {
    name: "Noir",
    blurb: "Silver lines on matte black.",
    intro: LAB_STYLES.engraved.intro,
    prompt: "silver-white engraved lines on matte black paper, so the lines represent light rather than shadow. Every tone is built from fine parallel lines that swell where the light is strongest and fade into the black paper in shadow. Let the lines follow the curves and planes of the {subject}. Show reflections on paint, metal and glass as clean streaks",
    setting: LAB_STYLES.engraved.setting,
    finish: LAB_STYLES.engraved.finish,
  },
};

export function styleInfo(id: string): Style {
  return LAB_STYLES[id as StyleId] ?? RETIRED[id] ?? { ...LAB_STYLES.engraved, name: id, blurb: "" };
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
  const st = styleInfo(style);
  const fill = (t: string) => t.replaceAll("{subject}", c.subject);
  const lines = [
    fill(st.intro),
    `Accuracy matters most: keep ${c.fidelity} exactly as in the photo, from the same viewing angle. Do not add, remove or invent anything.`,
    `Style: ${fill(st.prompt)}.`,
    fill(st.setting),
    fill(st.finish),
  ];
  if (customerNotes) lines.push(`Customer request: ${customerNotes}`);
  if (adjustment) lines.push(`Adjustments for this version: ${adjustment}`);
  return lines.join("\n");
}
