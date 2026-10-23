// The optional one-line caption printed on the paper under the artwork.
import opentype from "opentype.js";
import { CAPTION_FONT } from "./caption-font.mts";

export const CAPTION_MAX = 40;

export function cleanCaption(raw: unknown) {
  return String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, CAPTION_MAX);
}

let font: opentype.Font | null = null;
const loadFont = () =>
  (font ??= opentype.parse(CAPTION_FONT.buffer.slice(CAPTION_FONT.byteOffset, CAPTION_FONT.byteOffset + CAPTION_FONT.byteLength)));

// Share of the print's height kept free below the art for the caption.
export const CAPTION_BAND = 0.11;

// An SVG of the caption in spaced capitals with lining figures, centred in a width × height band,
// drawn as outlines so it renders the same everywhere.
export function captionSvg(text: string, width: number, height: number, printHeight: number) {
  const f = loadFont();
  // The font's default figures are old-style (they dip below the line); swap in its lining ones.
  const lining = new Map<number, number>(
    ((f as any).substitution.getSingle("lnum", "latn", "dflt") ?? []).map((s: { sub: number; by: number }) => [s.sub, s.by]),
  );
  const glyphs = [...text.toUpperCase()].map((ch) => {
    const g = f.charToGlyph(ch);
    return f.glyphs.get(lining.get(g.index) ?? g.index);
  });
  const tracking = 0.2; // em
  const measure = (size: number) =>
    glyphs.reduce((x, g) => x + ((g.advanceWidth ?? 0) / f.unitsPerEm + tracking) * size, 0) - tracking * size;
  let size = printHeight * 0.026;
  const maxW = width * 0.8;
  if (measure(size) > maxW) size *= maxW / measure(size);
  let x = (width - measure(size)) / 2;
  const baseline = height * 0.42 + size * 0.33;
  let d = "";
  for (const g of glyphs) {
    d += g.getPath(x, baseline, size).toPathData(2);
    x += ((g.advanceWidth ?? 0) / f.unitsPerEm + tracking) * size;
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path d="${d}" fill="#2a2622"/></svg>`);
}
