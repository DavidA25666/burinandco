// Background function: turns the approved render into a print-ready file.
// Topaz upscales it 2x, then it is fitted to the print's pixel size (see print-file.mts).
import { getOrder, saveOrder, log, filesStore } from "../shared/store.mts";
import { verify, fileUrl } from "../shared/sign.mts";
import { upscaleForPrint } from "../shared/replicate.mts";
import { printPixels } from "../shared/catalog.mts";
import { makePrintFile } from "../shared/print-file.mts";
import { notifyOwner, button, esc } from "../shared/email.mts";

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
    const file = await makePrintFile(new Uint8Array(await img.arrayBuffer()), width, height, dpi, order.caption);
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
