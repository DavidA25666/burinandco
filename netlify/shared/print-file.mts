// Fits a render to the print's shape: the art is scaled to fit and the paper is extended along
// each edge, since renders are 16:9 and frames are 5:4 or 4:3. An optional caption gets a band
// of paper below the art.
import sharp from "sharp";
import { captionSvg, CAPTION_BAND } from "./caption.mts";

// Fill the padding with mirrored copies of the image's own outer strip of paper, so the paper's tone,
// gradient and grain carry on with no seam. The strip is thin enough to hold only empty paper.
async function edgeFill(img: Uint8Array, w: number, h: number, side: "top" | "bottom" | "left" | "right", size: number) {
  const vertical = side === "top" || side === "bottom";
  const regionFor = (band: number) => ({
    top: { left: 0, top: 0, width: w, height: band },
    bottom: { left: 0, top: h - band, width: w, height: band },
    left: { left: 0, top: 0, width: band, height: h },
    right: { left: w - band, top: 0, width: band, height: h },
  }[side]);
  const spread = async (band: number) => {
    const { channels } = await sharp(await sharp(img).extract(regionFor(band)).greyscale().png().toBuffer()).stats();
    return channels[0].stdev;
  };
  // Use the widest strip that is still plain paper: if a wider strip varies much more than the
  // outermost few pixels, it has reached a shadow or part of the subject.
  const paper = await spread(8);
  let band = 8;
  for (const b of [256, 128, 64, 32, 16]) {
    if (b <= size && b <= (vertical ? h : w) / 10 && (await spread(b)) <= paper * 1.5 + 2) { band = b; break; }
  }
  band = Math.min(band, size);
  const strip = await sharp(img).extract(regionFor(band)).png().toBuffer();
  const mirrored = await (vertical ? sharp(strip).flip() : sharp(strip).flop()).png().toBuffer();
  const pw = vertical ? w : size, ph = vertical ? size : h;
  // Tiles alternate mirrored/plain, starting with a mirrored one against the image.
  const tiles: { input: Uint8Array; left: number; top: number }[] = [];
  for (let k = 0, at = 0; at < size; k++, at += band) {
    const input = k % 2 === 0 ? mirrored : strip;
    const nearImage = side === "top" || side === "left";
    const offset = nearImage ? size - at - band : at;
    tiles.push(vertical ? { input, left: 0, top: offset } : { input, left: offset, top: 0 });
  }
  return sharp({ create: { width: pw, height: ph, channels: 3, background: "#ffffff" } })
    .composite(tiles).png().toBuffer();
}

// Extend img (w × h) with paper: `before` pixels above/left and `after` below/right.
async function pad(img: Uint8Array, w: number, h: number, vertical: boolean, before: number, after: number) {
  if (before <= 0 && after <= 0) return img;
  const W = vertical ? w : w + before + after, H = vertical ? h + before + after : h;
  const layers: { input: Uint8Array; left: number; top: number }[] = [];
  if (before > 0) layers.push({ input: await edgeFill(img, w, h, vertical ? "top" : "left", before), left: 0, top: 0 });
  if (after > 0) layers.push({ input: await edgeFill(img, w, h, vertical ? "bottom" : "right", after), left: vertical ? 0 : before + w, top: vertical ? before + h : 0 });
  layers.push({ input: img, left: vertical ? 0 : before, top: vertical ? before : 0 });
  return sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } }).composite(layers).png().toBuffer();
}

export async function composePrint(source: Uint8Array, width: number, height: number, caption?: string | null) {
  const band = caption ? Math.round(height * CAPTION_BAND) : 0;
  const boxH = height - band;
  const fitted = await sharp(source).removeAlpha()
    .resize(width, boxH, { fit: "inside", kernel: "lanczos3" }).png().toBuffer();
  const meta = await sharp(fitted).metadata();
  const w = meta.width!, h = meta.height!;
  const top = Math.floor((boxH - h) / 2), left = Math.floor((width - w) / 2);
  // Pad top and bottom first, then the sides of the taller strip, so the corners get paper too.
  const tall = await pad(fitted, w, h, true, top, height - h - top);
  let out = sharp(await pad(tall, w, height, false, left, width - w - left));
  if (caption) out = sharp(await out.composite([{ input: captionSvg(caption, width, band, height), left: 0, top: height - band }]).png().toBuffer());
  return out;
}

export async function makePrintFile(source: Uint8Array, width: number, height: number, dpi: number, caption?: string | null) {
  return (await composePrint(source, width, height, caption))
    .withMetadata({ density: dpi })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toBuffer();
}
