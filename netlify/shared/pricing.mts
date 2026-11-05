// Prices the storefront charges, with HQ's owner prices and seasonal schedules on top of the
// defaults in catalog.mts. Every price change goes through here and is refused below break-even.
import { SIZES, type SizeId } from "./catalog.mts";
import { nyDate, type Settings, type PriceSchedule } from "./ops-store.mts";

export const STRIPE_FEES = { percent: 0.029, fixedCents: 30 };

// FinerWorks cost per framed print, with Ground shipping, until a real invoice amount is known.
// FinerWorks quoted $145 (16 × 12) and $199 (20 × 16) before shipping; shipping is estimated.
export const DEFAULT_UNIT_COSTS: Partial<Record<SizeId, number>> = { "12x16": 16500, "16x20": 22400 };

// AI per order: one render, about one regeneration on average, and the 2x print upscale.
export const AI_CENTS_PER_ORDER = 70;

export const activeSkus = () => (Object.keys(SIZES) as SizeId[]).filter((s) => !SIZES[s].retired);
export const isSku = (s: string): s is SizeId => activeSkus().includes(s as SizeId);

export function unitCostCents(sku: string, settings: Settings) {
  return settings.unitCosts[sku] ?? DEFAULT_UNIT_COSTS[sku as SizeId] ?? 0;
}

/** Lowest price that still breaks even after fulfillment, AI and Stripe's fees. */
export function floorCents(sku: string, settings: Settings) {
  const cost = unitCostCents(sku, settings) + AI_CENTS_PER_ORDER + STRIPE_FEES.fixedCents;
  return Math.ceil(cost / (1 - STRIPE_FEES.percent));
}

export function activeSchedule(sku: string, settings: Settings, today = nyDate()): PriceSchedule | null {
  return settings.priceSchedules.find((p) => p.sku === sku && p.startsOn <= today && p.endsOn >= today) ?? null;
}

export function priceCents(sku: string, settings: Settings, today = nyDate()) {
  const def = SIZES[sku as SizeId]?.price ?? 0;
  const scheduled = activeSchedule(sku, settings, today)?.cents;
  const own = settings.priceOverrides[sku];
  // Never charge below the floor, even if the floor rose after a price was set (raisedToFloor).
  return Math.max(scheduled ?? own ?? def, floorCents(sku, settings));
}

export function priceSource(sku: string, settings: Settings, today = nyDate()) {
  if (activeSchedule(sku, settings, today)) return "seasonal";
  if (settings.priceOverrides[sku] != null) return "override";
  return "default";
}

export const marginCents = (sku: string, price: number, settings: Settings) =>
  Math.round((price - unitCostCents(sku, settings) - AI_CENTS_PER_ORDER - (price * STRIPE_FEES.percent + STRIPE_FEES.fixedCents)) * 100) / 100;

export const feeCents = (amount: number) => Math.round(amount * STRIPE_FEES.percent + STRIPE_FEES.fixedCents);

// ---------- §14 GET /api/ops/pricing ----------

export function pricingView(settings: Settings) {
  const today = nyDate();
  const cells: Record<string, Record<string, Record<string, unknown>>> = { base: {} };
  for (const sku of activeSkus()) {
    const cents = priceCents(sku, settings, today);
    const wanted = activeSchedule(sku, settings, today)?.cents ?? settings.priceOverrides[sku] ?? SIZES[sku].price;
    cells.base[sku] = {
      single: {
        cents,
        label: SIZES[sku].name,
        defaultCents: SIZES[sku].price,
        source: priceSource(sku, settings, today),
        floorCents: floorCents(sku, settings),
        breakEvenCents: floorCents(sku, settings),
        marginCents: marginCents(sku, cents, settings),
        aiCents: AI_CENTS_PER_ORDER,
        unitCostCents: unitCostCents(sku, settings),
        overrideCents: settings.priceOverrides[sku] ?? null,
        schedule: activeSchedule(sku, settings, today),
        raisedToFloor: wanted < floorCents(sku, settings),
      },
    };
  }
  return {
    contractVersion: 5,
    version: settings.pricingVersion,
    money_unit: "cents",
    note: "One framed print per order; US shipping is included in the price.",
    tiers: [{ id: "single", label: "1", minItems: 1 }],
    cells,
    schedules: settings.priceSchedules.filter((s) => s.endsOn >= today).map((s) => ({ id: s.id, line: "base", product: s.sku, tier: "single", cents: s.cents, startsOn: s.startsOn, endsOn: s.endsOn, created_by: s.createdBy })),
    aiBudget: { monthly_cap_cents: settings.aiMonthlyCapCents },
  };
}

export class PriceError extends Error {
  constructor(public status: number, public code: string, message: string, public data?: unknown) { super(message); }
}

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

/**
 * Applies one §14 pricing change to a copy of settings. Throws PriceError on refusal.
 * Returns a short message for the owner.
 */
export function applyPriceChange(settings: Settings, body: any, by: string | null): string {
  const op = body?.op;
  const sku = String(body?.product ?? body?.sku ?? "");
  const line = String(body?.line ?? "base");
  const tier = String(body?.tier ?? "single");
  const startsOn = body?.startsOn ?? body?.starts_on ?? body?.startsAt ?? body?.starts_at;
  const endsOn = body?.endsOn ?? body?.ends_on ?? body?.endsAt ?? body?.ends_at;
  if (op !== "set" && op !== "clear") throw new PriceError(400, "invalid_params", "op must be set or clear.");
  if (!isSku(sku)) throw new PriceError(404, "not_found", `Unknown product "${sku}". Products: ${activeSkus().join(", ")}.`);
  if (line !== "base" || tier !== "single") throw new PriceError(404, "not_found", "Burin & Co. has one price per size (line base, tier single).");
  if ((startsOn == null) !== (endsOn == null)) throw new PriceError(422, "invalid_dates", "Send both startsOn and endsOn, or neither.");
  if (startsOn != null && (!isDay(startsOn) || !isDay(endsOn) || endsOn < startsOn)) throw new PriceError(422, "invalid_dates", "Dates must be YYYY-MM-DD and endsOn can't be before startsOn.");

  if (op === "clear") {
    if (startsOn != null) {
      const before = settings.priceSchedules.length;
      settings.priceSchedules = settings.priceSchedules.filter((s) => !(s.sku === sku && s.startsOn === startsOn && s.endsOn === endsOn));
      if (settings.priceSchedules.length === before) throw new PriceError(404, "not_found", "No seasonal price with those dates.");
      settings.pricingVersion++;
      return `Seasonal price for ${SIZES[sku].name} ${startsOn} to ${endsOn} cancelled.`;
    }
    if (settings.priceOverrides[sku] == null) throw new PriceError(404, "not_found", `${SIZES[sku].name} already uses its default price.`);
    delete settings.priceOverrides[sku];
    settings.pricingVersion++;
    return `${SIZES[sku].name} is back to its default price, ${dollars(SIZES[sku].price)}.`;
  }

  const cents = body?.cents != null ? Math.round(Number(body.cents)) : body?.price != null ? Math.round(Number(body.price) * 100) : NaN;
  if (!Number.isFinite(cents) || cents <= 0) throw new PriceError(400, "invalid_params", "Send cents (or price in dollars).");
  const floor = floorCents(sku, settings);
  if (cents < floor) {
    throw new PriceError(422, "below_floor", `${dollars(cents)} is below break-even for ${SIZES[sku].name}. The lowest allowed price is ${dollars(floor)}.`, { floorCents: floor, floorPrice: floor / 100 });
  }
  if (startsOn != null) {
    settings.priceSchedules = settings.priceSchedules.filter((s) => !(s.sku === sku && s.startsOn === startsOn && s.endsOn === endsOn));
    settings.priceSchedules.push({ id: `ps_${crypto.randomUUID().slice(0, 8)}`, sku, cents, startsOn, endsOn, createdBy: by, createdAt: new Date().toISOString() });
    settings.pricingVersion++;
    return `${SIZES[sku].name} is ${dollars(cents)} from ${startsOn} to ${endsOn}.`;
  }
  settings.priceOverrides[sku] = cents;
  settings.pricingVersion++;
  return `${SIZES[sku].name} is now ${dollars(cents)}.`;
}
