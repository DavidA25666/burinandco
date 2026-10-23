// Products, prices and prompts live here. Prices are in cents and include US shipping.
export type StyleId = "engraved" | "studio" | "heritage";
export type CategoryId = "automobile" | "yacht" | "aircraft" | "building" | "other";
export type SizeId = "12x16" | "16x20" | "24x30" | "30x40";
export type FrameId = "walnut" | "ebony" | "olive";

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
    prompt: "black ink only on warm cream cotton paper. Every tone is built from fine parallel engraved lines that swell thicker in shadow and thin out in highlight, with cross-hatching only in the deepest shadows. Every line is razor-sharp, solid pure black with clean tapered ends and clear white paper between lines, as crisp as a steel-plate engraving printed at very high resolution, so it stays sharp under a magnifying glass. Let the lines follow the curves and planes of the {subject}. Show reflections on paint, metal and glass as clean streaks",
    setting: "Show the {subject} alone, centered, with generous empty paper around it and a soft engraved ground line or shadow. Remove the background, people, other vehicles and clutter.",
    finish: "No text, lettering, signature, border or frame. No blur, softness, smudging, grain, gray wash or pencil texture.",
  },
  studio: {
    name: "Studio",
    blurb: "A designer's hand rendering in your true colors, like a master custom-car presentation drawing.",
    intro: "Turn the {subject} in this photo into a masterful hand-drawn presentation rendering by a world-class automotive designer: professional alcohol marker, colored pencil and white gouache on smooth bright-white bristol board. It must look like a signed original worth thousands of dollars, framed in a collector's study.",
    prompt: "the {subject} is the entire focus, drawn with precise, confident ink outlines that taper and vary in weight, plus a few faint, light colored-pencil perspective and construction lines that extend slightly past the body edges. Render the {subject}'s exact colors from the photo with smooth, perfectly blended marker gradients, rich and saturated in the shadows and glowing toward the highlights, so the surfaces read as deep, glossy, freshly polished paint. Crisp white gouache highlights trace the sharp body lines, panel edges and roof line, with a few bright starburst glints. A thin, cool reflected-sky edge light runs along the upper edges. Glass is dark and tinted with clean reflections and a hint of the interior. Wheels, tires, chrome, badges, lights and grille are rendered in meticulous, realistic detail with mirror-like chrome. Studio lighting from above, elegant and refined, never messy",
    setting: "Show the {subject} complete and centered on clean, bright white paper with generous empty margins all around. The only things besides the {subject} are a soft, dark grey shadow directly beneath it and a few short, subtle ground-plane pencil lines. The background is otherwise completely blank white: no streaks, swooshes, color swipes, splashes, gradients, scenery or backdrop.",
    finish: "No text, lettering, signature, logo, border or frame. Keep the {subject} exact: do not lower, widen, restyle, customize or exaggerate it. Not a photo filter, not a cartoon, not a watercolor, not a rough sketch.",
  },
  heritage: {
    name: "Heritage",
    blurb: "A painted portrait in the manner of classic mid-century automotive advertising art.",
    intro: "Turn the {subject} in this photo into an original fine-art gouache painting in the tradition of the great 1950s and 1960s automotive advertising illustrators, painted by a master for a collector, suitable for framing as a gallery print.",
    prompt: "smooth, opaque gouache with invisible brushwork and razor-sharp edges, every surface idealized but true. The {subject} keeps its exact colors from the photo, painted with deep, luminous, high-gloss reflections that make the paint look a foot deep. Chrome and glass are painted with crisp, jewel-like reflections and clean highlights. Details such as wheels, badges, lights, grille and trim are painted precisely. Warm, flattering late-afternoon light",
    setting: "Show the {subject} complete and centered on a smooth, softly graduated warm ivory-to-pale-grey backdrop with a soft, natural shadow beneath it. No scenery, people, other vehicles, streaks, swooshes or color splashes.",
    finish: "No text, lettering, signature, logo, border or frame. Keep the {subject} exact: do not lower, widen, restyle, customize or elongate it. Not a photograph, not a 3D render, not a cartoon, not a watercolor.",
  },
};

export const LAB_STYLES: Record<StyleId, Style> = {
  ...(STYLES as Record<StyleId, Style>),
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
  atelier: {
    name: "Atelier",
    blurb: "A precise ink drawing in your true colors, with bold sweeps of paint behind it.",
    intro: "Turn the {subject} in this photo into a fine-art mixed-media drawing for a framed gallery print: a precise ink rendering of the {subject} in its true colors, set against bold, expressive sweeps of color.",
    prompt: "crisp, confident black ink linework defines every edge, panel line and detail, like a master automotive or architectural designer's presentation drawing. Fill the {subject} with its exact colors from the photo (paint, trim, glass tint, wheels) in rich layered gouache and marker with clean highlights and reflections, so the color is instantly recognizable as the owner's. Behind and around it, three to five large, fast, sweeping brushstrokes of that same color plus one or two harmonious accent colors suggest motion and energy. The strokes are loose and painterly, overlap the edges of the {subject} slightly, and fade out into the paper",
    setting: "Show the {subject} alone, centered, on warm white cotton paper with generous margins. Remove the real background, people, other vehicles and clutter; the color sweeps are the only background.",
    finish: "No text, lettering, signature, border or frame. The {subject} itself stays sharp and exact; only the background strokes are loose. Not a watercolor, not a cartoon, not a photo filter.",
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

export const FRAMES: Record<FrameId, string> = { walnut: "Dark walnut", ebony: "Black oak", olive: "Olive, 2½-inch" };

export const COLLECTOR_PRICE = 30000;

// aspect is landscape (width:height); portrait subjects such as buildings flip it.
// Retired sizes stay so old orders still read correctly, but can't be ordered.
export const SIZES: Record<SizeId, { name: string; price: number; aspect: string; inches: [number, number]; dpi: number; retired?: boolean }> = {
  "12x16": { name: "16 × 12 in", price: 29500, aspect: "4:3", inches: [16, 12], dpi: 300 },
  "16x20": { name: "20 × 16 in", price: 39500, aspect: "5:4", inches: [20, 16], dpi: 300 },
  "24x30": { name: "30 × 24 in", price: 69500, aspect: "5:4", inches: [30, 24], dpi: 300 },
  "30x40": { name: "40 × 30 in", price: 125000, aspect: "4:3", inches: [40, 30], dpi: 240, retired: true },
};

// Pixel size of the print file (landscape width × height, flipped for portrait subjects).
export function printPixels(size: string, category: string) {
  const s = SIZES[size as SizeId] ?? SIZES["16x20"];
  const [w, h] = s.inches.map((i) => i * s.dpi);
  return { width: categoryInfo(category).portrait ? h : w, height: categoryInfo(category).portrait ? w : h, dpi: s.dpi };
}

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

export function productName(o: { style: string; category: string; size: SizeId; frame: FrameId; collector: boolean }) {
  return `Burin & Co. ${styleInfo(o.style).name} portrait of your ${categoryInfo(o.category).subject}: ${SIZES[o.size].name}, ${FRAMES[o.frame].toLowerCase()} frame${o.collector ? ", collector edition" : ""}`;
}
