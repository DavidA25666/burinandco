(function () {
  const $ = (id) => document.getElementById(id);
  const form = $("order");
  const money = (n) => "$" + n.toLocaleString("en-US");
  const sizeLabel = { "16x20": "16 × 20 in", "24x30": "24 × 30 in", "30x40": "30 × 40 in" };

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
    $("sCat").textContent = v("category").value;
    $("sStyle").textContent = v("style").value;
    $("sSize").textContent = sizeLabel[size.value] + ", " + (v("frame").value === "Walnut" ? "American walnut" : "Ebonized oak");
    $("sColRow").hidden = !collector;
    $("total").textContent = money(Number(size.dataset.price) + (collector ? 300 : 0));
    $("pl1").textContent = $("line1").value || " ";
    $("pl2").textContent = $("line2").value || " ";
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

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    $("draftNote").hidden = false;
  });

  update();
})();
