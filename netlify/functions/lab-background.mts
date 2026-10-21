// Background function: renders one compare-page test with one model.
import { labStore, filesStore } from "../shared/store.mts";
import { verify, fileUrl } from "../shared/sign.mts";
import { renderIllustration } from "../shared/replicate.mts";
import { buildPrompt, aspectFor, type StyleId, type SizeId, type CategoryId } from "../shared/catalog.mts";

export default async (req: Request) => {
  const { testId, model } = await req.json();
  if (!verify(`lab:${testId}:${model}`, req.headers.get("x-internal-sig"))) return;
  const store = labStore();
  const test = await store.get(`test/${testId}`, { type: "json" }) as
    { style: StyleId; category: CategoryId; size: SizeId; photoKey: string } | null;
  if (!test) return;

  const resultKey = `result/${testId}/${model.replace("/", "--")}`;
  const started = Date.now();
  try {
    const prompt = buildPrompt(test.style, test.category, null, null);
    const origin = new URL(req.url).origin;
    const outputUrl = await renderIllustration(fileUrl(origin, test.photoKey), prompt, aspectFor(test.size, test.category), model);
    const img = await fetch(outputUrl);
    if (!img.ok) throw new Error("Couldn't download the finished image.");
    const key = `lab/${testId}/${model.replace("/", "--")}`;
    await filesStore().set(key, await img.arrayBuffer());
    await store.setJSON(resultKey, { model, status: "done", key, seconds: Math.round((Date.now() - started) / 1000) });
  } catch (e) {
    await store.setJSON(resultKey, { model, status: "failed", error: e instanceof Error ? e.message : String(e) });
  }
};
