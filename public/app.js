(function () {
  const $ = (id) => document.getElementById(id);
  const form = $("order");
  const money = (n) => "$" + n.toLocaleString("en-US");
  const sizeLabel = { "16x20": "16 × 20 in", "24x30": "24 × 30 in", "30x40": "30 × 40 in" };
  const label = (input) => input.closest("label").textContent.trim();

  // Hero style toggle
  document.querySelectorAll("[data-hero]").forEach((b) => {
    b.addEventListener("click", () => {
      $("heroImg").src = "img/framed-" + b.dataset.hero + ".jpg";
      document.querySelectorAll("[data-hero]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    });
  });

  function update() {
    const v = (name) => form.querySelector(`input[name="${name}"]:checked`);
    const size = v("size");
    const collector = $("collector").checked;
    $("sCat").textContent = label(v("category"));
    $("sStyle").textContent = v("style").closest("label").querySelector("strong").textContent;
    $("sSize").textContent = sizeLabel[size.value] + ", " + label(v("frame"));
    $("sColRow").hidden = !collector;
    $("total").textContent = money(Number(size.dataset.price) + (collector ? 300 : 0));
    $("pl1").textContent = $("line1").value || $("line1").placeholder;
    $("pl2").textContent = $("line2").value || $("line2").placeholder;
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
    if (!$("line1").value.trim()) return showError("Add the first line of the plaque.");
    if (!$("name").value.trim()) return showError("Add your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test($("email").value.trim())) return showError("Check your email address.");

    const btn = $("pay");
    btn.disabled = true;
    btn.textContent = "Opening secure checkout…";
    try {
      const res = await fetch("/api/orders", { method: "POST", body: new FormData(form) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.checkoutUrl) throw new Error(data.error || "Checkout couldn't start. Try again in a moment.");
      location.href = data.checkoutUrl;
    } catch (ex) {
      showError(ex.message);
      btn.disabled = false;
      btn.textContent = "Continue to payment";
    }
  });

  update();
})();
