// Background function: turns the approved render into a print-ready file.
// Topaz upscales it 2x, then it is resized to the print's pixel size and padded to the frame shape
// by extending the paper along each edge, since renders are 16:9 and frames are 5:4 or 4:3.
import sharp from "sharp";
import { getOrder, saveOrder, log, filesStore } from "../shared/store.mts";
import { verify, fileUrl } from "../shared/sign.mts";
import { upscaleForPrint } from "../shared/replicate.mts";
import { printPixels } from "../shared/catalog.mts";
import { notifyOwner, button, esc } from "../shared/email.mts";

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

export async function makePrintFile(source: Uint8Array, width: number, height: number, dpi: number) {
  const fitted = await sharp(source).removeAlpha()
    .resize(width, height, { fit: "inside", kernel: "lanczos3" }).png().toBuffer();
  const meta = await sharp(fitted).metadata();
  const w = meta.width!, h = meta.height!;
  const left = Math.floor((width - w) / 2), top = Math.floor((height - h) / 2);
  const layers: { input: Uint8Array; left: number; top: number }[] = [];
  if (h < height) {
    if (top > 0) layers.push({ input: await edgeFill(fitted, w, h, "top", top), left: 0, top: 0 });
    layers.push({ input: await edgeFill(fitted, w, h, "bottom", height - h - top), left: 0, top: top + h });
  } else if (w < width) {
    if (left > 0) layers.push({ input: await edgeFill(fitted, w, h, "left", left), left: 0, top: 0 });
    layers.push({ input: await edgeFill(fitted, w, h, "right", width - w - left), left: left + w, top: 0 });
  }
  layers.push({ input: fitted, left, top });
  return sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .composite(layers)
    .withMetadata({ density: dpi })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

export default async (req: Request) => {
  const { orderId } = await req.json();
  if (!verify(`print:${orderId}`, req.headers.get("x-internal-sig"))) return;
  const order = await getOrder(orderId);
  if (!order || !order.renders.length) return;

  const origin = new URL(req.url).origin;
  const version = order.renders.length;
  order.printStatus = "preparing";
  delete order.printError;
  log(order, `Preparing print file from v${version}`);
  await saveOrder(order);

  try {
    const upscaledUrl = await upscaleForPrint(fileUrl(origin, order.renders[version - 1].key));
    const img = await fetch(upscaledUrl);
    if (!img.ok) throw new Error("Couldn't download the upscaled image.");
    const { width, height, dpi } = printPixels(order.size, order.category);
    const file = await makePrintFile(new Uint8Array(await img.arrayBuffer()), width, height, dpi);
    const key = `print/${order.id}/v${version}`;
    await filesStore().set(key, new Uint8Array(file).buffer);

    order.printFile = { key, version, width, height, dpi, createdAt: new Date().toISOString() };
    delete order.printStatus;
    log(order, `Print file ready: v${version}, ${width} × ${height} px at ${dpi} dpi`);
    await saveOrder(order);
    await notifyOwner(
      `Print file ready: ${order.customer.name}`,
      `<p>The print file for ${esc(order.customer.name)}'s order (v${version}) is ready to download and send to the lab.</p>${button(`${origin}/admin.html#${order.id}`, "Open dashboard")}`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    order.printStatus = "failed";
    order.printError = message;
    log(order, `Print file failed: ${message}`);
    await saveOrder(order);
  }
};
