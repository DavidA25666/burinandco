import type { Config } from "@netlify/functions";
import { getOrder, listOrders, type Order } from "../shared/store.mts";
import { isAdmin, fileUrl } from "../shared/sign.mts";
import { SIZES, FRAMES, styleInfo, categoryInfo } from "../shared/catalog.mts";
import { checkFinerworks, finerworksCode, codeEnvName, finerworksLive } from "../shared/finerworks.mts";
import { runOrderAction, printFileProblem, ActionError } from "../shared/order-actions.mts";
import { audit } from "../shared/ops-store.mts";

function view(o: Order, origin: string) {
  return {
    ...o,
    categoryName: categoryInfo(o.category).name,
    styleName: styleInfo(o.style).name,
    sizeName: SIZES[o.size].name,
    frameName: FRAMES[o.frame],
    photoUrl: fileUrl(origin, o.photoKey),
    renders: o.renders.map((r) => ({ ...r, url: fileUrl(origin, r.key) })),
    printFileUrl: o.printFile ? fileUrl(origin, o.printFile.key) : null,
    printFileProblem: printFileProblem(o),
    paid: !!o.paidAt,
    finerworksCode: finerworksCode(o.size, o.frame),
    finerworksCodeEnv: codeEnvName(o.size, o.frame),
    finerworksLive: finerworksLive(),
  };
}

const fail = (error: string, status = 409) => Response.json({ error }, { status });

// The old password dashboard. Tenfold HQ runs the same actions through /api/ops (see ops.mts).
export default async (req: Request) => {
  if (!isAdmin(req)) return fail("Wrong password.", 401);
  const origin = new URL(req.url).origin;

  try {
    if (req.method === "GET") {
      const showAll = new URL(req.url).searchParams.get("all") === "1";
      const orders = (await listOrders()).filter(
        (o) => showAll || (o.status !== "archived" && o.status !== "awaiting_payment" && o.status !== "awaiting_card"),
      );
      return Response.json({ orders: orders.map((o) => view(o, origin)) });
    }

    const { action, id, note, force } = await req.json();
    if (action === "finerworks_check") return Response.json(await checkFinerworks());
    // Refunds are HQ-only, so money only moves with HQ's confirmation and audit log.
    if (action === "refund_order") return fail("Refund from Tenfold HQ.", 400);
    const order = await getOrder(id);
    if (!order) return fail("Order not found.", 404);
    const result = await runOrderAction(origin, action, order, { note, force });
    await audit("dashboard", `order:${action}`, { orderId: order.id, note: note ?? null, force: !!force });
    return Response.json({ order: view(result.order, origin) });
  } catch (e) {
    if (e instanceof ActionError) return fail(e.message, e.status);
    console.error(e);
    return fail(e instanceof Error ? e.message : "Something went wrong.", 500);
  }
};

export const config: Config = { path: "/api/admin" };
