// Street address suggestions: type in "Street address", pick a match, and the rest of the
// address fills in. Talks to /api/address (Google Places behind it). If that isn't set up or
// fails, the field stays a plain text field. Same file on Burin & Co. and Namesake.
//
//   window.addressAutocomplete({ line1, line2, city, state, zip })  // element ids
(function () {
  window.addressAutocomplete = function (ids) {
    const el = (k) => document.getElementById(ids[k]);
    const input = el("line1");
    if (!input || !window.fetch) return;
    const wrap = document.createElement("div");
    wrap.className = "addr-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const list = document.createElement("ul");
    list.className = "addr-list";
    list.id = input.id + "-suggestions";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    wrap.appendChild(list);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", list.id);

    const newSession = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    let session = newSession(), items = [], active = -1, timer = 0, seq = 0, off = false;

    const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; };
    const highlight = (i) => {
      active = i;
      [...list.children].forEach((li, j) => li.setAttribute("aria-selected", j === i ? "true" : "false"));
      if (i >= 0) input.setAttribute("aria-activedescendant", list.children[i].id); else input.removeAttribute("aria-activedescendant");
    };
    const render = () => {
      list.textContent = "";
      items.forEach((s, i) => {
        const li = document.createElement("li");
        li.id = list.id + "-" + i;
        li.setAttribute("role", "option");
        const main = document.createElement("strong"); main.textContent = s.main;
        const sub = document.createElement("span"); sub.textContent = s.sub;
        li.append(main, sub);
        // pointerdown, not click: fires before the input's blur closes the list.
        li.addEventListener("pointerdown", (e) => { e.preventDefault(); pick(i); });
        list.appendChild(li);
      });
      if (items.length) {
        const credit = document.createElement("li");
        credit.className = "addr-credit"; credit.setAttribute("aria-hidden", "true"); credit.textContent = "Suggestions by Google";
        list.appendChild(credit);
      }
      list.hidden = !items.length;
      input.setAttribute("aria-expanded", items.length ? "true" : "false");
      highlight(-1);
    };
    const set = (k, v) => { const f = el(k); if (f && v != null) { f.value = v; f.dispatchEvent(new Event("input", { bubbles: true })); } };

    async function pick(i) {
      const s = items[i];
      if (!s) return;
      close();
      input.value = s.main;
      try {
        const res = await fetch("/api/address?id=" + encodeURIComponent(s.id) + "&s=" + session);
        if (!res.ok) throw 0;
        const a = (await res.json()).address;
        if (a.line1) input.value = a.line1;
        if (a.line2) set("line2", a.line2);
        set("city", a.city); set("state", a.state); set("zip", a.zip);
        // Next stop: the apartment field if there's no unit yet, so people can add one.
        const next = !a.line2 && el("line2") ? el("line2") : null;
        if (next && matchMedia("(pointer: fine)").matches) next.focus();
      } catch (_) { /* leave what they typed; they can fill the rest by hand */ }
      session = newSession();
    }

    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (off || q.length < 3) { items = []; render(); return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const res = await fetch("/api/address?q=" + encodeURIComponent(q) + "&s=" + session);
          if (res.status === 503) { off = true; return; }
          if (!res.ok) return;
          const data = await res.json();
          if (mine !== seq || document.activeElement !== input) return;
          items = data.suggestions || [];
          render();
        } catch (_) { /* offline: plain field */ }
      }, 220);
    });
    input.addEventListener("keydown", (e) => {
      if (list.hidden) return;
      if (e.key === "ArrowDown") { e.preventDefault(); highlight((active + 1) % items.length); }
      else if (e.key === "ArrowUp") { e.preventDefault(); highlight(active <= 0 ? items.length - 1 : active - 1); }
      else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(active); }
      else if (e.key === "Escape") close();
    });
    input.addEventListener("blur", () => setTimeout(close, 120));
  };
})();
