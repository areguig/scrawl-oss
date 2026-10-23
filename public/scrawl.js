// Scrawl stack for pads: Tailwind 3 + daisyUI 4 + Alpine 3, with the Scrawl theme. Pinned to the versions models know.
(function () {
  var light = "--p:51.09% 0.0861 186.39;--pc:100% 0 0;--s:37.91% 0.1378 265.52;--sc:100% 0 0;--a:66.58% 0.1574 58.32;--ac:100% 0 0;--n:25.42% 0.0111 254.04;--nc:96.99% 0.0013 106.42;--b1:100% 0 0;--b2:96.98% 0.0054 95.1;--b3:92.18% 0.0083 91.49;--bc:22.23% 0.006 271.14;--in:50% 0.1193 242.75;--inc:100% 0 0;--su:52.73% 0.1371 150.07;--suc:100% 0 0;--wa:81.34% 0.145 77.95;--wac:22.23% 0.006 271.14;--er:53.86% 0.1937 26.72;--erc:100% 0 0";
  var dark = "--p:78.45% 0.1325 181.91;--pc:22.13% 0.0344 185.23;--s:68.01% 0.1583 276.93;--sc:20.63% 0.0662 274.03;--a:83.69% 0.1644 84.43;--ac:18.73% 0.0383 89.07;--n:29.66% 0.0117 264.38;--nc:93.04% 0.0027 106.45;--b1:23.03% 0.0083 264.4;--b2:18.7% 0.0063 271.07;--b3:30.46% 0.0116 264.39;--bc:93.04% 0.0027 106.45;--in:75.35% 0.139 232.66;--inc:23.04% 0.0429 234.13;--su:80.03% 0.1821 151.71;--suc:26.64% 0.0628 152.93;--wa:83.69% 0.1644 84.43;--wac:18.73% 0.0383 89.07;--er:71.06% 0.1661 22.22;--erc:19.68% 0.0601 24.53";
  var shape = "--rounded-box:1rem;--rounded-btn:.625rem;--rounded-badge:1.9rem;--tab-radius:.5rem;--animation-btn:.2s;--btn-focus-scale:.98";
  var css =
    ":root{" + light + ";" + shape + "}" +
    "@media (prefers-color-scheme:dark){:root{color-scheme:dark;" + dark + "}}" +
    "html{font-family:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}" +
    "body{background:oklch(var(--b2));color:oklch(var(--bc));min-height:100vh}" +
    "h1,h2,h3{letter-spacing:-.02em;text-wrap:balance}p{text-wrap:pretty}" +
    ".stat-value,td,.font-mono{font-variant-numeric:tabular-nums}" +
    ".card{border:1px solid oklch(var(--b3))}[x-cloak]{display:none!important}" +
    ".badge{height:auto;min-height:1.25rem;padding-block:.125rem;white-space:nowrap;flex-shrink:0}" +
    ".badge-outline.badge-warning{color:color-mix(in oklch,oklch(var(--wa)) 55%,oklch(var(--bc)))}" +
    // html prefix: map CSS loads after this style and would win a tie.
    "html .maplibregl-popup-content{background:oklch(var(--b1));color:oklch(var(--bc));border-radius:.75rem;padding:.75rem 1rem}html .maplibregl-popup-anchor-bottom .maplibregl-popup-tip{border-top-color:oklch(var(--b1))}" +
    "html .maplibregl-ctrl-attrib{background:oklch(var(--b1)/.75);color:oklch(var(--bc)/.7);font-size:11px}html .maplibregl-ctrl-attrib a{color:inherit}" +
    ".alert{grid-auto-flow:column;grid-template-columns:auto minmax(auto,1fr);justify-items:start;text-align:start}" +
    // Soft alerts: a tinted box reads as a note, a solid one as an error page.
    ["info", "in", "success", "su", "warning", "wa", "error", "er"].reduce(function (out, v, i, a) {
      return i % 2 ? out : out + ".alert-" + v + "{background:oklch(var(--" + a[i + 1] + ")/.12);border-color:oklch(var(--" + a[i + 1] + ")/.35);color:oklch(var(--bc))}";
    }, "") +
    // Hidden until Tailwind has styled the page, and shown after 2s whatever happens.
    "body{opacity:0;animation:scrawl-show 0s 2s forwards}@keyframes scrawl-show{to{opacity:1}}html.scrawl-ready body{opacity:1;animation:none}";

  // Inserted tags, not document.write: Chrome blocks written cross-site scripts on slow connections.
  var head = document.head || document.documentElement;
  function add(tag, attrs) {
    var el = document.createElement(tag);
    for (var k in attrs) el[k] = attrs[k];
    head.appendChild(el);
    return el;
  }
  function ready() { document.documentElement.classList.add("scrawl-ready"); }
  add("link", { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Inter:wght@400..800&display=swap" });
  add("link", { rel: "stylesheet", href: "https://cdn.jsdelivr.net/npm/daisyui@4.12.24/dist/full.min.css" });
  add("style", { textContent: css });
  add("script", {
    src: "https://cdn.tailwindcss.com/3.4.17",
    async: false,
    onload: function () {
      tailwind.config = { darkMode: "media", theme: { extend: { fontFamily: { sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"] } } } };
      requestAnimationFrame(function () { requestAnimationFrame(ready); });
    },
    onerror: ready,
  });
  // Alpine starts on the DOM it finds, so add it once the page is parsed (persist plugin first).
  function addAlpine() {
    add("script", { src: "https://cdn.jsdelivr.net/npm/@alpinejs/persist@3.14.9/dist/cdn.min.js", async: false });
    add("script", { src: "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js", async: false });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addAlpine);
  else addAlpine();

  // <i data-lucide="map-pin"></i> becomes that Lucide icon, fetched one by one instead of a 100 KB bundle.
  var icons = {};
  function drawIcons() {
    document.querySelectorAll("i[data-lucide]").forEach(function (el) {
      var name = el.getAttribute("data-lucide");
      icons[name] = icons[name] || fetch("https://cdn.jsdelivr.net/npm/lucide-static@1.49.0/icons/" + name + ".svg").then(function (r) { return r.ok ? r.text() : ""; });
      icons[name].then(function (svg) {
        if (!svg || !el.isConnected) return;
        var box = document.createElement("span");
        box.innerHTML = svg;
        var icon = box.querySelector("svg");
        icon.setAttribute("class", "lucide inline-block shrink-0 " + el.className);
        icon.setAttribute("aria-hidden", "true");
        if (!/(^|\s)(w|size)-/.test(el.className)) { icon.setAttribute("width", "1.15em"); icon.setAttribute("height", "1.15em"); icon.style.verticalAlign = "-0.2em"; }
        el.replaceWith(icon);
      });
    });
  }
  document.addEventListener("DOMContentLoaded", drawIcons);
  document.addEventListener("alpine:initialized", drawIcons);
})();
