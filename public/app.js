(function () {
  const $ = (id) => document.getElementById(id);
  const form = $("order");
  const money = (n) => "$" + n.toLocaleString("en-US");
  const sizeLabel = { "16x20": "16 × 20 in", "24x30": "24 × 30 in", "30x40": "30 × 40 in" };
  const label = (input) => input.closest("label").textContent.trim();

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
    bldg: { src: "compare-bldg", w: 1080, h: 1350, what: "a commercial building", cap: "A photo of a commercial building, and the Studio rendering we drew from it." },
  };
  const heroBa = $("heroBa");
  document.querySelectorAll("[data-ba]").forEach((btn) => btn.addEventListener("click", () => {
    const ex = examples[btn.dataset.ba];
    const [photo, art] = heroBa.querySelectorAll("img");
    photo.src = `img/${ex.src}-photo.jpg`; photo.alt = `The owner's photo: ${ex.what}`;
    art.src = `img/${ex.src}-studio.jpg`; art.alt = `The finished Studio rendering of ${ex.what}`;
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
    const big = size.value === "30x40";
    form.querySelector(".frames").hidden = big;
    $("frameNote").hidden = !big;
    $("sSize").textContent = sizeLabel[size.value] + ", " + (big ? "olive" : label(v("frame")));
    $("total").textContent = money(Number(size.dataset.price));
  }
  form.addEventListener("input", update);
  form.addEventListener("change", update);

  $("photo").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const img = $("photoPrev");
    img.src = URL.createObjectURL(f);
    img.hidden = false;
    $("photoTxt").innerHTML = "<strong>" + f.name.replace(/[<>&]/g, "") + "</strong><br>Tap to choose a different photo.";
  });

  function showError(msg) {
    $("formErr").textContent = msg;
    $("formErr").hidden = false;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("formErr").hidden = true;
    const photo = $("photo").files[0];
    if (!photo) return showError("Add a photograph of what we're drawing.");
    if (photo.size > 5.5 * 1024 * 1024) return showError("That photo is too large. Use one under 5 MB.");
    if (!$("name").value.trim()) return showError("Add your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test($("email").value.trim())) return showError("Check your email address.");
    for (const [id, msg] of [["ship_name", "Add the recipient's name."], ["ship_line1", "Add the street address."], ["ship_city", "Add the city."], ["ship_state", "Add the state."], ["ship_zip", "Add the ZIP code."]]) {
      if (!$(id).value.trim()) return showError(msg);
    }

    const btn = $("pay");
    btn.disabled = true;
    btn.textContent = "Opening secure card page…";
    try {
      const res = await fetch("/api/orders", { method: "POST", body: new FormData(form) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.checkoutUrl) throw new Error(data.error || "Checkout couldn't start. Try again in a moment.");
      location.href = data.checkoutUrl;
    } catch (ex) {
      showError(ex.message);
      btn.disabled = false;
      btn.textContent = "Continue to request my proof";
    }
  });

  update();
})();
