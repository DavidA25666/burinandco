// Cookie consent, Meta Pixel and Microsoft Clarity. Nothing from Meta or Microsoft loads until the
// visitor clicks Accept. The IDs come from /api/site-config (META_PIXEL_ID, CLARITY_PROJECT_ID in
// Netlify); with neither set, no banner shows and nothing loads.
// Pages call window.bcTrack("ViewContent", {...}, eventId). Events wait until the Pixel is loaded,
// and are dropped if the visitor declines.
(function () {
  var KEY = "bc_consent"; // "granted" | "denied"
  var queue = [];
  var cfg = null;
  var started = false;

  function choice() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function remember(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private mode */ } }

  function flush() {
    if (!started || !window.fbq) return;
    while (queue.length) {
      var e = queue.shift();
      window.fbq("track", e[0], e[1], e[2] ? { eventID: e[2] } : undefined);
    }
  }

  window.bcConsent = function () { return choice() === "granted"; };
  window.bcTrack = function (event, params, eventId) {
    if (choice() === "denied") return;
    queue.push([event, params || {}, eventId || null]);
    flush();
  };

  function loadPixel(id) {
    /* Meta's standard base code */
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    window.fbq("init", id);
    window.fbq("track", "PageView");
  }

  function loadClarity(id) {
    /* Microsoft's standard Clarity snippet */
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, "clarity", "script", id);
    window.clarity("consent");
  }

  function start() {
    if (started || !cfg) return;
    started = true;
    if (cfg.metaPixelId) loadPixel(cfg.metaPixelId);
    if (cfg.clarityProjectId) loadClarity(cfg.clarityProjectId);
    flush();
  }

  var STYLE = ".bc-consent{position:fixed;z-index:9999;left:12px;right:12px;bottom:12px;max-width:560px;margin-left:auto;background:#fff;color:#1a1815;border:1px solid #1a1815;box-shadow:0 18px 40px -18px rgba(30,20,10,.45);padding:18px 20px;display:grid;gap:12px;font:400 14.5px/1.5 Archivo,'Helvetica Neue',Arial,sans-serif}" +
    ".bc-consent p{margin:0}.bc-consent a{color:#6b1d1d}.bc-consent .r{display:flex;flex-wrap:wrap;gap:10px}" +
    ".bc-consent button{cursor:pointer;font:600 13px/1 Archivo,'Helvetica Neue',Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;padding:13px 20px;border:0;background:#1a1815;color:#fbfbf9}" +
    ".bc-consent button:hover{background:#6b1d1d}.bc-consent button.g{background:transparent;color:#1a1815;box-shadow:inset 0 0 0 1px #1a1815}.bc-consent button.g:hover{background:#f6f5f1}";

  function banner() {
    if (document.querySelector(".bc-consent")) return;
    if (!document.getElementById("bc-consent-style")) {
      var st = document.createElement("style"); st.id = "bc-consent-style"; st.textContent = STYLE; document.head.appendChild(st);
    }
    var box = document.createElement("div");
    box.className = "bc-consent";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Cookie choices");
    box.innerHTML = "<p>We'd like to use cookies from Meta, to measure our ads, and Microsoft Clarity, to see how the site is used. Nothing loads unless you accept. <a href=\"/privacy.html#cookies\">Privacy</a></p>" +
      "<div class=\"r\"><button type=\"button\" data-c=\"granted\">Accept</button><button type=\"button\" class=\"g\" data-c=\"denied\">Decline</button></div>";
    box.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-c]");
      if (!b) return;
      var was = choice();
      remember(b.getAttribute("data-c"));
      box.remove();
      if (b.getAttribute("data-c") === "granted") start();
      else { queue.length = 0; if (was === "granted" && started) location.reload(); } // unload what was running
    });
    document.body.appendChild(box);
  }

  document.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("[data-consent-open]")) { e.preventDefault(); banner(); }
  });

  fetch("/api/site-config").then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
    cfg = c || {};
    if (!cfg.metaPixelId && !cfg.clarityProjectId) return;
    var v = choice();
    if (v === "granted") start();
    else if (!v) {
      if (document.body) banner(); else document.addEventListener("DOMContentLoaded", banner);
    }
  }).catch(function () {});
})();
