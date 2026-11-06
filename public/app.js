(function () {
  const $ = (id) => document.getElementById(id);
  const form = $("order");
  const money = (n) => "$" + n.toLocaleString("en-US");
  const sizeLabel = { "12x16": "16 × 12 in", "16x20": "20 × 16 in" };
  const label = (input) => input.closest("label").textContent.trim();
  // Meta Pixel events (consent.js only sends them after the visitor accepts cookies).
  const track = (event, extra) => {
    if (!window.bcTrack) return;
    const size = form.querySelector('input[name="size"]:checked');
    window.bcTrack(event, Object.assign({ content_type: "product", content_ids: [size.value], content_name: "Framed portrait " + sizeLabel[size.value], currency: "USD", value: Number(size.dataset.price) }, extra || {}));
  };

  // Photo / rendering comparison: drag to reveal, with one sweep when it scrolls into view.
  document.querySelectorAll(".ba").forEach((ba) => {
    const range = ba.querySelector("input[type=range]"), hint = ba.querySelector(".drag-hint");
    const setCut = (v) => { ba.style.setProperty("--cut", v + "%"); range.value = v; };
    range.addEventListener("input", () => { setCut(range.value); hint.hidden = true; ba.classList.add("used"); });
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches && "IntersectionObserver" in window) {
      const io = new IntersectionObserver(([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        const steps = [50, 22, 78, 50];
        let i = 0;
        ba.classList.add("sweeping");
        const next = () => {
          if (ba.classList.contains("used") || ++i >= steps.length) { ba.classList.remove("sweeping"); return; }
          setCut(steps[i]); setTimeout(next, 900);
        };
        setTimeout(next, 400);
      }, { threshold: 0.6 });
      io.observe(ba);
    }
  });

  // Hero examples: one slider, with a tab per subject.
  const examples = {
    car: { src: "compare", w: 1536, h: 864, what: "a silver Ford Mustang fastback with black stripes", cap: "A real owner's photo of a Ford Mustang fastback, and the Studio rendering we drew from it." },
    yacht: { src: "compare-yacht", w: 1536, h: 864, what: "a motor yacht underway", cap: "A photo of a motor yacht at sea, and the Studio rendering we drew from it." },
    jet: { src: "compare-jet", w: 1536, h: 864, what: "a private jet", cap: "A photo of a private jet, and the Studio rendering we drew from it." },
  };
  const heroBa = $("heroBa");
  document.querySelectorAll("[data-ba]").forEach((btn) => btn.addEventListener("click", () => {
    const ex = examples[btn.dataset.ba];
    const [photo, art] = heroBa.querySelectorAll("img");
    photo.srcset = `img/${ex.src}-photo-768.webp 768w, img/${ex.src}-photo.webp ${ex.w}w`; photo.src = `img/${ex.src}-photo.webp`; photo.alt = `The owner's photo: ${ex.what}`;
    art.srcset = `img/${ex.src}-studio-768.webp 768w, img/${ex.src}-studio.webp ${ex.w}w`; art.src = `img/${ex.src}-studio.webp`; art.alt = `The finished Studio rendering of ${ex.what}`;
    for (const img of [photo, art]) { img.width = ex.w; img.height = ex.h; }
    heroBa.style.setProperty("--ar", `${ex.w} / ${ex.h}`);
    heroBa.style.setProperty("--cut", "50%");
    heroBa.querySelector("input[type=range]").value = 50;
    $("baCap").textContent = ex.cap;
    document.querySelectorAll("[data-ba]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  }));

  function update() {
    const v = (name) => form.querySelector(`input[name="${name}"]:checked`);
    const size = v("size");
    $("sCat").textContent = label(v("category"));
    $("sStyle").textContent = v("style").closest("label").querySelector("strong").textContent;
    $("sSize").textContent = sizeLabel[size.value] + ", " + label(v("frame"));
    const cap = $("caption").value.trim();
    $("sCapRow").hidden = !cap;
    $("sCap").textContent = cap.toUpperCase();
    $("total").textContent = money(Number(size.dataset.price));
  }
  form.addEventListener("input", update);
  form.addEventListener("change", update);

  $("photo").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (!form.dataset.carted) { form.dataset.carted = "1"; track("AddToCart"); }
    const img = $("photoPrev");
    img.src = URL.createObjectURL(f);
    img.hidden = false;
    $("photoTxt").innerHTML = "<strong>" + f.name.replace(/[<>&]/g, "") + "</strong><br>Tap to choose a different photo.";
  });

  // Saves the email as soon as it's typed (the notice under the field says so), so someone who
  // leaves before sending the form can get one reminder with a free-proof link.
  let leadSent = "";
  const saveLead = () => {
    const email = $("email").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email === leadSent) return;
    leadSent = email;
    const data = JSON.stringify({ email, name: $("name").value.trim() });
    try {
      if (navigator.sendBeacon) navigator.sendBeacon("/api/lead", new Blob([data], { type: "application/json" }));
      else fetch("/api/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: data, keepalive: true });
    } catch (e) { /* never block the form */ }
  };
  $("email").addEventListener("change", saveLead);
  $("email").addEventListener("blur", saveLead);

  // Arrived from a reminder email's free-proof link: no card page, the proof comes first.
  const q = new URLSearchParams(location.search);
  const freeToken = q.get("free");
  const payLabel = freeToken ? "Request my free proof" : "Continue to request my proof";
  if (freeToken) {
    if (q.get("e") && !$("email").value) $("email").value = q.get("e");
    $("pay").textContent = payLabel;
    $("freeNote").hidden = false;
    const fine = $("freeNote").previousElementSibling;
    if (fine && fine.classList.contains("fine")) fine.hidden = true;
  }

  function showError(msg) {
    $("formErr").textContent = msg;
    $("formErr").hidden = false;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("formErr").hidden = true;
    const photo = $("photo").files[0];
    if (!photo) return showError("Add a photograph of what we're drawing.");
    if (!$("name").value.trim()) return showError("Add your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test($("email").value.trim())) return showError("Check your email address.");
    for (const [id, msg] of [["ship_name", "Add the recipient's name."], ["ship_line1", "Add the street address."], ["ship_city", "Add the city."], ["ship_state", "Add the state."], ["ship_zip", "Add the ZIP code."]]) {
      if (!$(id).value.trim()) return showError(msg);
    }

    const btn = $("pay");
    btn.disabled = true;
    btn.textContent = freeToken ? "Sending…" : "Opening secure card page…";
    track("InitiateCheckout", { num_items: 1 });
    try {
      const body = new FormData(form);
      body.set("photo", await window.shrinkPhoto(photo));
      body.set("utm_first", localStorage.getItem("bc_utm_first") || "");
      body.set("utm_last", localStorage.getItem("bc_utm_last") || "");
      body.set("ad_consent", window.bcConsent && window.bcConsent() ? "granted" : "");
      if (freeToken) body.set("free", freeToken);
      const res = await fetch("/api/orders", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !(data.checkoutUrl || data.redirectUrl)) throw new Error(data.error || "Checkout couldn't start. Try again in a moment.");
      location.href = data.checkoutUrl || data.redirectUrl;
    } catch (ex) {
      showError(ex.message);
      btn.disabled = false;
      btn.textContent = payLabel;
    }
  });

  update();
  track("ViewContent");

  // Live prices, headline and maintenance mode, all set from Tenfold HQ.
  fetch("/api/catalog").then((r) => r.ok ? r.json() : null).then((c) => {
    if (!c) return;
    for (const sz of c.sizes || []) {
      const input = form.querySelector(`input[name="size"][value="${sz.id}"]`);
      if (!input) continue;
      input.dataset.price = String(sz.price / 100);
      const pr = input.closest("label").querySelector(".pr");
      if (pr) pr.textContent = money(sz.price / 100);
    }
    const lowest = Math.min(...(c.sizes || []).map((s) => s.price));
    const from = document.querySelector(".hero-actions .price");
    if (from && Number.isFinite(lowest)) from.textContent = "From " + money(lowest / 100);
    if (c.headline) { const h1 = document.querySelector("h1"); if (h1) h1.textContent = c.headline; }
    if (c.maintenance) {
      const btn = $("pay");
      btn.disabled = true;
      btn.textContent = "Commissions are paused for a short while";
    }
    update();
  }).catch(() => {});
})();

// Visit counter and ad attribution: keeps the first landing's UTMs for 30 days, and the latest ones.
(function () {
  try {
    const q = new URLSearchParams(location.search);
    const pick = (k) => q.get("utm_" + k) || null;
    const ref = document.referrer && !document.referrer.includes(location.host) ? new URL(document.referrer).hostname : null;
    const utm = { source: pick("source") || (q.get("fbclid") ? "facebook" : q.get("gclid") ? "google" : null), medium: pick("medium"), campaign: pick("campaign"), content: pick("content"), referrer: ref, landedAt: new Date().toISOString() };
    const has = utm.source || utm.campaign || utm.referrer;
    const first = JSON.parse(localStorage.getItem("bc_utm_first") || "null");
    if (has && (!first || Date.now() - Date.parse(first.landedAt) > 30 * 864e5)) localStorage.setItem("bc_utm_first", JSON.stringify(utm));
    if (has) localStorage.setItem("bc_utm_last", JSON.stringify(utm));
    let sid = sessionStorage.getItem("bc_sid");
    if (!sid) { sid = Math.random().toString(36).slice(2, 12); sessionStorage.setItem("bc_sid", sid); }
    const source = utm.source ? utm.source + (utm.medium ? " / " + utm.medium : "") : ref || "direct";
    const data = JSON.stringify({ sid, source, path: location.pathname });
    if (navigator.sendBeacon) navigator.sendBeacon("/api/t", new Blob([data], { type: "application/json" }));
    else fetch("/api/t", { method: "POST", body: data, keepalive: true });
  } catch (e) { /* counting a visit must never break the page */ }
})();
