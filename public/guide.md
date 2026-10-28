# Scrawl guide

Scrawl turns one HTML page into a shareable link. You only need to fetch URLs and make one POST: no shell, no install, no local files.

With the Scrawl MCP server ({{BASE_URL}}/mcp), the tools `get_recipe`, `publish_pad`, `update_pad` and `check_pad` make the calls below for you, with the same fields and replies.

## 1. Pick a recipe
Fetch the closest one with GET, replace everything marked `EDIT`, keep the structure. Do not start from a blank page. Every recipe already looks good on a phone and in dark mode.

| Recipe | Use when | URL |
|---|---|---|
| dashboard | key numbers, status, a table | {{BASE_URL}}/recipes/dashboard.html |
| compare | options side by side: products, listings, plans | {{BASE_URL}}/recipes/compare.html |
| chart | one chart (bar, line, pie) from data | {{BASE_URL}}/recipes/chart.html |
| table | many rows to search and sort | {{BASE_URL}}/recipes/table.html |
| calculator | inputs that give live results | {{BASE_URL}}/recipes/calculator.html |
| ranking | a ranked list with bars: results, shares, budget breakdown | {{BASE_URL}}/recipes/ranking.html |
| faq | items the reader opens to read more: FAQ, glossary, explainers | {{BASE_URL}}/recipes/faq.html |
| checklist | things to tick off, saved on the reader's device | {{BASE_URL}}/recipes/checklist.html |
| quiz | questions with scoring | {{BASE_URL}}/recipes/quiz.html |
| itinerary | a day-by-day plan, schedule or steps | {{BASE_URL}}/recipes/itinerary.html |
| diagram | a flowchart, process or architecture | {{BASE_URL}}/recipes/diagram.html |
| map | places on a map | {{BASE_URL}}/recipes/map.html |
| article | a written summary or report with key points | {{BASE_URL}}/recipes/article.html |
| starter | anything else | {{BASE_URL}}/recipes/starter.html |

Fill the recipe in:
- Replace every `EDIT` text with real content, and delete the HTML comments that contain `EDIT`. No `EDIT` may remain anywhere in the page.
- Delete whole parts that do not fit (an alert, a card, a table). Keep the rest of the structure.
- Keep `<script src="/scrawl.js"></script>` in `<head>` exactly as it is. It loads Tailwind 3, daisyUI 4, Alpine.js 3 and the Scrawl theme. Do not add other copies of these libraries.
- Need two layouts? Copy the block you need from a second recipe. Mixing recipes is fine.
- Invent plausible sample data only when the user gave none, and say so in the footer: `Source: sample data invented for this page, <date>.` If the user gave the data but no source: `Source: provided by the user, <date>.`

## What you can use
Write HTML with daisyUI components and Tailwind 3 utility classes. No `<style>` needed.

| Need | Use |
|---|---|
| page | `<main class="max-w-5xl mx-auto px-4 py-8 md:py-12 space-y-6">` (`max-w-3xl` for reading) |
| box | `<div class="card bg-base-100"><div class="card-body"><h2 class="card-title">..</h2>..</div></div>` |
| columns | `<div class="grid gap-4 md:grid-cols-3">` (one column on a phone) |
| key numbers | `<div class="stats stats-vertical sm:stats-horizontal w-full bg-base-100 border border-base-300"><div class="stat"><div class="stat-title">..</div><div class="stat-value">..</div><div class="stat-desc">..</div></div></div>` |
| tag | `badge` plus `badge-primary`, `badge-success`, `badge-warning`, `badge-error`, `badge-ghost`, `badge-outline` |
| button or link | `<a class="btn btn-primary" href="https://.." target="_blank" rel="noopener">`, also `btn-outline`, `btn-ghost`, `btn-sm` |
| note | `<div role="alert" class="alert alert-info">` (or `alert-warning`, `alert-success`, `alert-error`) |
| table | `<div class="overflow-x-auto"><table class="table">..</table></div>` |
| open to read | `<details class="collapse collapse-plus bg-base-100 border border-base-300"><summary class="collapse-title font-medium">..</summary><div class="collapse-content">..</div></details>` |
| progress bar | `<progress class="progress progress-primary" value="72" max="100"></progress>` |
| steps or timeline | `<ul class="steps steps-vertical">` or `<ul class="timeline timeline-vertical">` |
| form fields | `input input-bordered`, `select select-bordered`, `checkbox`, `radio`, `range`, `toggle` |
| icon | `<i data-lucide="map-pin" class="w-5 h-5"></i>`, any name from lucide.dev. No emoji as icons. |
| colors | only theme colors: `primary`, `secondary`, `accent`, `success`, `warning`, `error`, `base-100/200/300`, `base-content`. Never hex codes or `blue-500`: they break dark mode. |
| grey text | `opacity-70` |

Interaction without writing JavaScript: use Alpine.js attributes. Put the data in `x-data` and bind it: `x-model`, `x-text`, `x-show`, `@click`, `:class`, `<template x-for>`. Example: `<div x-data="{ qty: 2, price: 9 }"><input type="number" class="input input-bordered" x-model.number="qty"><p x-text="'$' + qty * price"></p></div>`.

Put `x-data` on one element that wraps every part using its data, usually `<main>`. Alpine shows nothing for attributes outside it.

When `x-data` holds a list, write the attribute in single quotes and the strings in double quotes, as the recipes do: `x-data='{ items: ["Tent", "Stove"] }'`. Then an apostrophe in the text ends the attribute: write "do not", not "don't", inside `x-data`.

Saving: wrap a value in `$persist(...)` to keep it on the reader's device across visits, for example `x-data="{ done: $persist([]).as('done') }"`. Each reader has their own copy; nobody else sees it.

## 2. Publish
POST the page. Plain HTML or JSON both work.

```
POST {{BASE_URL}}/api/publish
content-type: text/html

<the whole page>
```

or `content-type: application/json` with `{"html": "<the whole page>", "title": "optional", "expires_in_days": 30}`.

Pads are deleted 30 days after their last update. If the user wants to keep the page longer, send `expires_in_days` up to 365 (with raw HTML, add `?expires_in_days=90` to the URL). Each update starts the period again.

For a page only the user should open (a security report, anything not for strangers), send `"private": true` (with raw HTML, add `?private=1` to the URL). The reply's `url` then carries a key (`?k=...`): share that whole link. Without the key the pad answers 404, as if it did not exist. A pad is private or public from its publish on: to change it, publish a new pad. If the link leaks, delete the pad and publish again.

With a shell: `curl -sS -X POST --data-binary @pad.html -H 'content-type: text/html' {{BASE_URL}}/api/publish`

To send the file with a shell, write it to a temp file first (any writable path, such as your session scratch folder) and send it with `--data-binary @file`. That is the safest way. With a fetch tool, send the JSON form.

The reply is JSON:
```
{"id","url","edit_key","expires_at","private"?,"series"?,"warnings":[...],"advice":[...],"update":"...","delete":"..."}
```
1. Read `warnings`: each one breaks the page for readers. Fix every one, then update the pad (below). `advice` holds quality hints: follow them when they fit the page.
2. Show `url` to the user, and when it expires (`expires_at`).
3. Keep `id` and `edit_key` for this conversation. `update` and `delete` tell you exactly how to change or remove the pad.

After publishing, tell the user the link and one or two sentences with the main point of the page (the answer to their question). Do not paste the HTML in the chat.

## Images
- Images from the web: use the real https URL you found, with `alt` text. Never invent an image URL or use placeholder sites: the reader sees a broken image.
- Your own image files (a photo, a screenshot, a chart you rendered): send them with the page and refer to each by its file name, `<img src="photo.jpg" alt="...">`. Scrawl stores them and points the page at them. With a shell, send a form:
  `curl -sS -F html=@pad.html -F image=@photo.jpg {{BASE_URL}}/api/publish`
  With JSON, add `"images": {"photo.jpg": "<the file as base64>"}`. The reply lists each stored file in `images`. The same works on update.
- To add one image to a pad that exists: `curl -sS --data-binary @photo.jpg -H 'x-edit-key: <edit_key>' {{BASE_URL}}/api/pads/<id>/images`. The reply is `{"url": "..."}` for your `<img src>`.
- JPEG, PNG, WebP or GIF, 2 MB each, 20 per pad. Sending the same file again does not use up a place. They are deleted with the pad.
- Photos fill a card well with `<figure><img src="..." alt="..." class="h-48 w-full object-cover"></figure>` as the card's first child.

## 3. Update the same link
`PUT {{BASE_URL}}/api/pads/<id>` with header `x-edit-key: <edit_key>` and the new HTML as the body. Do not publish a new pad for each change.

## Pages a job updates
For a page a scheduled job refreshes (a weekly report, a dashboard), two things save work and keep history:

- **Data without the page.** `PUT {{BASE_URL}}/api/pads/<id>/data` with header `x-edit-key: <edit_key>` and any JSON document (up to 256 KB) as the body. Scrawl puts it in the page, and the page reads it on load:
  ```html
  <script>const data = JSON.parse(document.getElementById("scrawl-data")?.textContent ?? "null");</script>
  ```
  Publish the page once, then send only the data on each run. Readers see the new data when they reload.
- **Past editions.** Publish with `"series": true` (with raw HTML, `?series=1`). Each page update then keeps the page it replaces, with its data, as an edition. The update reply's `archived` is that edition's link, and the pad links to its past editions. The last 30 editions are kept. Data updates alone do not make an edition.

`private` and `series` are set at publish and cannot change later.

## 4. Check it on a phone
`POST {{BASE_URL}}/api/pads/<id>/check` with header `x-edit-key: <edit_key>` opens the pad on a 375px phone screen and returns `{"problems": [...]}`: sideways scrolling, small text, small buttons, images or scripts that fail. Fix them and update the pad. Add `?screenshot=1` to get a PNG of the whole page instead. It takes a few seconds; check once after your last change, not after every update.

## If publishing fails
Scrawl's errors are JSON: `{"error": "...", "code": "..."}`.

| Status | Code | What to do |
|---|---|---|
| 400 | `empty_pad`, `bad_json`, `bad_expiry` | send the whole HTML, or valid JSON `{"html": "..."}` |
| 400 | `private_at_publish`, `series_at_publish` | leave out `private` and `series` when updating, or publish a new pad |
| 400 | `bad_data` | send a valid JSON document as the data |
| 403 | `bad_edit_key` | use the `edit_key` from the publish reply |
| 404 | `not_found` | check the id, or publish a new pad |
| 413 | `pad_too_large`, `image_too_large`, `data_too_large` | page over 1 MB, image over 2 MB or data over 256 KB: cut content, upload a smaller image |
| 415 | `image_type` | send the raw bytes of a JPEG, PNG, WebP or GIF |
| 422 | `password_field`, `image_limit` | remove the password field; reuse or drop images |
| 429 | `publish_limit` | 20 new pads per hour reached: update an existing pad with PUT |
| 501, 503 | `check_unavailable`, `check_busy` | the check is off on this Scrawl, or busy: skip it or try again in a minute |

An error that is not JSON (an HTML page, often a 403) comes from a firewall between you and Scrawl, not from Scrawl. Retry once with another HTTP client or a `User-Agent` header (`curl` works), and tell the user if it still fails.

## Make it good
- Title the page with the takeaway, not the topic: "Signups doubled since spring", not "Signups".
- Lead with the answer, then the detail. Short paragraphs. The text under the title is one or two short sentences: put the longer reasoning in a card below.
- One message per page. Lead with one big number or verdict, not four of equal weight.
- At most one alert per page. Most text belongs in cards, not in alerts.
- A shared link previews as the pad's title, its first paragraph (or `<meta name="description">`) and a picture of the top of the page on a wide screen, so make that top count.
- End with a footer in the form `Source: <where>, <date>.` Mark estimates as approximate.
- Use the theme as it is: theme colors only, no fixed widths, no custom fonts.
- Charts: one message per chart, sorted bars, start the axis at zero, no legend for a single series.
- Use the right recipe: a quiz uses `quiz`, a plan or schedule uses `itinerary`, a report uses `article`, shares or rankings use `ranking`, things to tick off use `checklist`, open-to-read-more items use `faq`, a process uses `diagram`, places use `map`.

## Rules
- One file. Extra CSS in `<style>`, extra JavaScript in `<script>`. The only local file allowed is `/scrawl.js`.
- Mobile first. Keep `<meta name="viewport" content="width=device-width, initial-scale=1">`. No fixed widths over 480px. Recipes are already right on a phone.
- Add a `<title>`.
- Scripts only from: cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com, cdn.tailwindcss.com, esm.sh. Pin a version (`chart.js@4.4.0`). Stylesheets, fonts and images may come from any https URL.
- Pads are public to anyone with the link and cannot be listed. No secrets, no personal data. A private pad needs the key in its link, but anyone holding that link can read it: it is not a login.
- Forms cannot submit anywhere: use JavaScript. `fetch` to https URLs works.
- Saving is per reader and per device: `$persist` or `localStorage` keep values when that reader comes back on the same browser. Nothing is shared between readers, and the pad's author cannot see it. Never ask readers for secrets or personal data.
- Viewers cannot change a pad. Only the holder of the `edit_key` can update or delete it, so keep it for the conversation.
- Maps: copy the map from the `map` recipe (MapLibre with OpenFreeMap tiles, no key). tile.openstreetmap.org and CARTO block pads.
- Links open fine: use `<a href="https://..." target="_blank" rel="noopener">`.
- Max 1 MB, 20 new pads per hour. Pads expire 30 days after the last update, 365 at most.
