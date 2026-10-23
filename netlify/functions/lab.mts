import type { Config } from "@netlify/functions";
import { labStore, filesStore } from "../shared/store.mts";
import { isAdmin, fileUrl, sign } from "../shared/sign.mts";
import { LAB_STYLES, SIZES, CATEGORIES, type StyleId, type SizeId, type CategoryId, styleInfo, categoryInfo } from "../shared/catalog.mts";
import { COMPARE_MODELS } from "../shared/replicate.mts";

// Compare page: render one photo with every model in COMPARE_MODELS so you can pick the most faithful one.
interface LabTest { id: string; createdAt: string; label: string; style: StyleId; category: CategoryId; size: SizeId; photoKey: string; pick?: string | null }
interface LabResult { model: string; status: "rendering" | "done" | "failed"; key?: string; error?: string; seconds?: number }

const fail = (error: string, status = 400) => Response.json({ error }, { status });

async function startRun(origin: string, testId: string, model: string) {
  const fail = (error: string) => labStore().setJSON(`result/${testId}/${model.replace("/", "--")}`, { model, status: "failed", error });
  try {
    const res = await fetch(`${origin}/.netlify/functions/lab-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-sig": sign(`lab:${testId}:${model}`) },
      body: JSON.stringify({ testId, model }),
    });
    if (res.status !== 202 && !res.ok) await fail(`Couldn't start (status ${res.status}).`);
  } catch (e) {
    // Record the failure so the test shows "Try again" instead of rendering forever.
    await fail(`Couldn't start: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// A model with no result this long after the test started never began (renders stop at 12 minutes).
const NEVER_STARTED_MS = 15 * 60 * 1000;

export default async (req: Request) => {
  if (!isAdmin(req)) return fail("Wrong password.", 401);
  const origin = new URL(req.url).origin;
  const store = labStore();

  try {
    if (req.method === "GET") {
      const { blobs } = await store.list({ prefix: "test/" });
      const tests = await Promise.all(blobs.map(async (b) => {
        const t = await store.get(b.key, { type: "json" }) as LabTest;
        const results = await Promise.all(COMPARE_MODELS.map(async (m) => {
          const r = await store.get(`result/${t.id}/${m.id.replace("/", "--")}`, { type: "json" }) as LabResult | null;
          const stale = !r && Date.now() - Date.parse(t.createdAt) > NEVER_STARTED_MS;
          const status = r?.status ?? (stale ? "failed" : "rendering");
          const error = r?.error ?? (stale ? "Never started. Try again." : undefined);
          return { ...m, status, error, seconds: r?.seconds, url: r?.key ? fileUrl(origin, r.key) : null };
        }));
        return { ...t, styleName: styleInfo(t.style).name, categoryName: categoryInfo(t.category).name, photoUrl: fileUrl(origin, t.photoKey), results };
      }));
      tests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return Response.json({ tests });
    }

    if (req.headers.get("content-type")?.includes("application/json")) {
      // Record which model got this photo most right.
      const { id, pick, retry } = await req.json();
      if (retry) {
        // Re-run one model that failed.
        if (!COMPARE_MODELS.some((m) => m.id === retry)) return fail("Unknown model.");
        await store.setJSON(`result/${id}/${retry.replace("/", "--")}`, { model: retry, status: "rendering" });
        await startRun(origin, id, retry);
        return Response.json({ ok: true });
      }
      const test = await store.get(`test/${id}`, { type: "json" }) as LabTest | null;
      if (!test) return fail("Test not found.", 404);
      if (pick && !COMPARE_MODELS.some((m) => m.id === pick)) return fail("Unknown model.");
      test.pick = pick || null;
      await store.setJSON(`test/${id}`, test);
      return Response.json({ ok: true });
    }

    const form = await req.formData();
    const photo = form.get("photo");
    const style = String(form.get("style") ?? "") as StyleId;
    const size = String(form.get("size") ?? "16x20") as SizeId;
    const category = String(form.get("category") ?? "automobile") as CategoryId;
    if (!(photo instanceof File) || photo.size === 0) return fail("Add a photo.");
    if (photo.size > 5.5 * 1024 * 1024) return fail("That photo is too large. Use one under 5 MB.");
    if (!LAB_STYLES[style]) return fail("Pick a style.");
    if (!SIZES[size]) return fail("Pick a size.");
    if (!CATEGORIES[category]) return fail("Pick what's in the photo.");

    const id = crypto.randomUUID();
    const test: LabTest = {
      id, createdAt: new Date().toISOString(),
      label: String(form.get("label") ?? "").trim().slice(0, 80) || photo.name,
      style, category, size,
      photoKey: `lab/${id}/photo`,
    };
    await filesStore().set(test.photoKey, await photo.arrayBuffer());
    await store.setJSON(`test/${id}`, test);

    await Promise.all(COMPARE_MODELS.map((m) => startRun(origin, id, m.id)));
    return Response.json({ id });
  } catch (e) {
    console.error(e);
    return fail(e instanceof Error ? e.message : "Something went wrong.", 500);
  }
};

export const config: Config = { path: "/api/lab" };
