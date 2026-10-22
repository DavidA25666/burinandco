// Runs the illustration model on Replicate. Change REPLICATE_MODEL to try another model.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// GPT Image only takes a fixed list of ratios, so use the closest one: 4:3 for 5:4 and 4:3 prints.
const gptSize = (aspect: string) => {
  const [w, h] = aspect.split(":").map(Number);
  return w >= h ? "4:3" : "3:4";
};

function inputFor(model: string, imageUrl: string, prompt: string, aspect: string) {
  if (model.includes("flux-kontext")) {
    return { prompt, input_image: imageUrl, aspect_ratio: aspect, output_format: "png" };
  }
  if (model.startsWith("openai/gpt-image")) {
    return { prompt, input_images: [imageUrl], aspect_ratio: gptSize(aspect), quality: "max", output_format: "png" };
  }
  if (model.includes("nano-banana")) {
    const hiRes = model.includes("nano-banana-2") || model.includes("pro");
    return {
      prompt, image_input: [imageUrl], aspect_ratio: aspect, output_format: "png",
      ...(hiRes ? { resolution: Netlify.env.get("REPLICATE_RESOLUTION") || "4K" } : {}),
    };
  }
  return { prompt, image: imageUrl };
}

export async function renderIllustration(imageUrl: string, prompt: string, aspect: string, modelOverride?: string): Promise<string> {
  const token = Netlify.env.get("REPLICATE_API_TOKEN");
  if (!token) throw new Error("REPLICATE_API_TOKEN is not set");
  const model = modelOverride || Netlify.env.get("REPLICATE_MODEL") || "google/nano-banana-pro";
  const auth = { Authorization: `Bearer ${token}` };

  // Replicate throttles new predictions (hard when credit is under $5), so wait and retry on 429.
  let res: Response;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", Prefer: "wait" },
      body: JSON.stringify({ input: inputFor(model, imageUrl, prompt, aspect) }),
    });
    if (res.status !== 429 || attempt === 8) break;
    const body = await res.json().catch(() => ({}));
    const wait = Number(res.headers.get("retry-after") ?? body?.retry_after) || 10;
    await sleep((wait + Math.random() * 5) * 1000);
  }
  let pred = await res.json();
  if (!res.ok) throw new Error(pred?.detail ?? pred?.title ?? `Replicate error ${res.status}`);

  const deadline = Date.now() + 12 * 60 * 1000;
  while (!["succeeded", "failed", "canceled"].includes(pred.status)) {
    if (Date.now() > deadline) throw new Error("Rendering took longer than 12 minutes and was stopped.");
    await sleep(4000);
    pred = await (await fetch(pred.urls.get, { headers: auth })).json();
  }
  if (pred.status !== "succeeded") throw new Error(pred.error ?? `Rendering ${pred.status}`);
  const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  if (typeof out !== "string") throw new Error("The model returned no image.");
  return out;
}

// Models the compare page (/lab.html) runs side by side on the same photo.
export const COMPARE_MODELS = [
  { id: "google/nano-banana-pro", name: "Nano Banana Pro" },
  { id: "google/nano-banana-2.1", name: "Nano Banana 2.1" },
  { id: "openai/gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst" },
  { id: "black-forest-labs/flux-kontext-max", name: "FLUX Kontext Max" },
];
