// Scrawl review mode: while the pad's author holds a review open, readers pin notes on the page.
// Everything lives in a shadow root, so the pad's CSS cannot reach it and it cannot reach the pad.
(function () {
  var cfg = window.scrawlReview;
  if (!cfg) return;
  var api = cfg.api + "/api/annotations";
  var query = "?pad=" + encodeURIComponent(cfg.pad) + (cfg.k ? "&k=" + encodeURIComponent(cfg.k) : "");
  var notes = [];
  var picking = false;
  var target = null;

  var host = document.createElement("div");
  host.setAttribute("data-scrawl-review", "");
  host.style.cssText = "all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646";
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" +
    ":host{--bg:#fffdf8;--fg:#1d1b18;--muted:#6b665d;--line:#e4ded2;--accent:#e2531f;--accent-fg:#fff}" +
    "@media (prefers-color-scheme:dark){:host{--bg:#1d1c22;--fg:#f1eee8;--muted:#a9a49b;--line:#37353d;--accent:#ff7a45;--accent-fg:#1b0d06}}" +
    "*{box-sizing:border-box;font:500 15px/1.4 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--fg)}" +
    "button{cursor:pointer;border:0;border-radius:999px;min-height:44px;padding:0 18px;background:var(--line);color:var(--fg);font-weight:600}" +
    ".primary{background:var(--accent);color:var(--accent-fg)}" +
    ".fab{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));display:flex;align-items:center;gap:8px;box-shadow:0 8px 28px rgba(0,0,0,.28)}" +
    ".count{min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:var(--accent-fg);color:var(--accent);font-size:13px;display:inline-flex;align-items:center;justify-content:center}" +
    ".hint{position:fixed;left:50%;top:calc(12px + env(safe-area-inset-top));transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:10px 16px;border-radius:999px;box-shadow:0 8px 28px rgba(0,0,0,.28);white-space:nowrap;pointer-events:none}" +
    ".pin{position:absolute;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50% 50% 50% 4px;background:var(--accent);color:var(--accent-fg);font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.35);border:2px solid var(--accent-fg);cursor:pointer;padding:0;min-height:0}" +
    ".box{position:absolute;border:2px dashed var(--accent);border-radius:6px;pointer-events:none}" +
    ".sheet{position:fixed;left:50%;bottom:calc(12px + env(safe-area-inset-bottom));transform:translateX(-50%);width:min(440px,calc(100vw - 24px));background:var(--bg);border:1px solid var(--line);border-radius:18px;padding:16px;box-shadow:0 16px 48px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:12px}" +
    ".sheet p{margin:0}.muted{color:var(--muted);font-size:14px}" +
    "textarea{width:100%;min-height:96px;resize:vertical;border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:transparent;color:var(--fg);font-size:16px}" +
    ".row{display:flex;gap:8px;justify-content:flex-end}" +
    "[hidden]{display:none!important}" +
    "</style>" +
    '<div class="layer"></div>' +
    '<p class="hint" hidden>Tap the part of the page your note is about</p>' +
    '<div class="sheet" data-write hidden><p class="muted" data-about></p><textarea maxlength="2000" placeholder="What should change here?"></textarea><div class="row"><button data-cancel>Cancel</button><button class="primary" data-send>Send note</button></div></div>' +
    '<div class="sheet" data-read hidden><p class="muted" data-read-meta></p><p data-read-text></p><div class="row"><button data-close>Close</button></div></div>' +
    '<button class="fab primary" data-fab>Annotate <span class="count" hidden></span></button>';
  var $ = function (sel) { return root.querySelector(sel); };
  var layer = $(".layer"), fab = $("[data-fab]"), count = $(".count"), hint = $(".hint"), write = $("[data-write]"), read = $("[data-read]"), area = $("textarea");

  // A path of tags from the nearest element with an id, stable enough to find the spot again after a reload.
  function selectorOf(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) { parts.unshift("#" + CSS.escape(el.id)); break; }
      var n = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) n++;
      parts.unshift(el.tagName.toLowerCase() + ":nth-of-type(" + n + ")");
      el = el.parentElement;
    }
    return parts.join(" > ");
  }
  function textOf(el) {
    return ((el.innerText || el.getAttribute("aria-label") || el.getAttribute("alt") || el.tagName.toLowerCase()) + "").replace(/\s+/g, " ").trim().slice(0, 200);
  }
  function find(sel) {
    try { return sel ? document.querySelector(sel) : null; } catch (e) { return null; }
  }
  function spot(el, fx, fy) {
    var r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX + r.width * (fx == null ? 0.5 : fx), y: r.top + window.scrollY + r.height * (fy == null ? 0.5 : fy), r: r };
  }

  function draw() {
    layer.textContent = "";
    notes.forEach(function (note, i) {
      var el = find(note.selector);
      if (!el) return;
      var p = spot(el, note.fx, note.fy);
      var pin = document.createElement("button");
      pin.className = "pin";
      pin.textContent = i + 1;
      pin.style.left = p.x + "px";
      pin.style.top = p.y + "px";
      pin.setAttribute("aria-label", "Note " + (i + 1));
      pin.onclick = function () { show(note, i); };
      layer.appendChild(pin);
    });
    if (target) {
      var p = spot(target.el, target.fx, target.fy), box = document.createElement("div");
      box.className = "box";
      box.style.cssText = "left:" + (p.r.left + window.scrollX - 3) + "px;top:" + (p.r.top + window.scrollY - 3) + "px;width:" + (p.r.width + 6) + "px;height:" + (p.r.height + 6) + "px";
      layer.appendChild(box);
    }
    count.hidden = !notes.length;
    count.textContent = notes.length;
    // The button sits where a sheet's buttons do.
    fab.hidden = !write.hidden || !read.hidden;
  }
  function show(note, i) {
    write.hidden = true;
    read.hidden = false;
    $("[data-read-meta]").textContent = "Note " + (i + 1) + " · " + new Date(note.created_at).toLocaleString();
    $("[data-read-text]").textContent = note.text;
    draw();
  }
  function setPicking(on) {
    picking = on;
    hint.hidden = !on;
    fab.firstChild.textContent = on ? "Cancel " : "Annotate ";
  }

  function load() {
    fetch(api + query).then(function (res) {
      if (res.status === 404) return host.remove();
      return res.json().then(function (body) { notes = body.annotations || []; draw(); });
    }).catch(function () {});
  }

  fab.onclick = function () {
    read.hidden = true;
    if (!write.hidden) return;
    setPicking(!picking);
  };
  $("[data-close]").onclick = function () { read.hidden = true; draw(); };
  $("[data-cancel]").onclick = function () { write.hidden = true; target = null; draw(); };
  $("[data-send]").onclick = function () {
    var text = area.value.trim();
    if (!text || !target) return;
    var send = $("[data-send]");
    send.disabled = true;
    fetch(api + query, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: cfg.pad, text: text, selector: target.selector, fx: target.fx, fy: target.fy, snippet: textOf(target.el) }),
    }).then(function (res) {
      send.disabled = false;
      if (!res.ok) return res.json().then(function (body) { $("[data-about]").textContent = body.error || "The note could not be sent."; });
      write.hidden = true;
      area.value = "";
      target = null;
      load();
    }).catch(function () { send.disabled = false; $("[data-about]").textContent = "The note could not be sent. Try again."; });
  };

  // While picking, the page underneath gets no taps: a game or a link must not react to the tap that places a note.
  function outside(e) { return e.composedPath().indexOf(host) < 0; }
  ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "mousemove", "touchstart", "touchend"].forEach(function (type) {
    window.addEventListener(type, function (e) { if (picking && outside(e)) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); } }, { capture: true, passive: false });
  });
  window.addEventListener("click", function (e) {
    if (!picking || !outside(e)) return;
    e.stopPropagation();
    e.preventDefault();
    var el = e.target && e.target.nodeType === 1 ? e.target : document.elementFromPoint(e.clientX, e.clientY) || document.body;
    var r = el.getBoundingClientRect();
    target = { el: el, selector: selectorOf(el), fx: r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0.5, fy: r.height ? Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) : 0.5 };
    setPicking(false);
    $("[data-about]").textContent = "About: " + textOf(el).slice(0, 80);
    write.hidden = false;
    draw();
    area.focus();
  }, true);

  document.documentElement.appendChild(host);
  load();
  window.addEventListener("resize", draw);
  // Layouts move (fonts, images, charts); notes from other readers arrive.
  setInterval(function () { if (!document.hidden) draw(); }, 1000);
  setInterval(function () { if (!document.hidden && !picking && write.hidden) load(); }, 20000);
})();
