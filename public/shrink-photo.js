// Phone photos are often 8 to 15 MB, but Netlify turns away uploads over about 6 MB.
// shrinkPhoto(file) returns the file untouched when it is already small enough, otherwise a
// JPEG copy (longest side up to 4096 px, still far more than the models use) under 4.5 MB.
window.shrinkPhoto = async function shrinkPhoto(file) {
  const LIMIT = 4.5 * 1024 * 1024;
  if (file.size <= LIMIT) return file;
  if (file.size > 40 * 1024 * 1024) throw new Error("That photo is over 40 MB. Use a smaller copy of it.");
  let img;
  try { img = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { throw new Error("That photo couldn't be read. Upload a JPG or PNG. On iPhone, picking from your photo library converts it for you."); }
  const long = Math.max(img.width, img.height);
  let side = Math.min(4096, long), blob = null;
  for (let q = 0.92; ; q -= 0.08) {
    const k = side / long;
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    blob = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
    if (!blob) throw new Error("That photo couldn't be prepared. Try a smaller copy of it.");
    if (blob.size <= LIMIT || q < 0.6) break;
    side = Math.round(side * 0.85);
  }
  return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
};
