// Turns state into HTML strings. Pure: no DOM access, no network. Everything user-typed goes through esc().
import { config } from "./config.js";
import { esc, money, formatDate, bottleCount, parseWindow, windowState } from "./format.js";

const COLOUR_ORDER = { Sparkling: 0, White: 1, "Rosé": 2, Red: 3, Sweet: 4, Fortified: 5 };

export const SECTIONS = [
  { status: "In cellar", title: "In the cellar", source: "cellar" },
  { status: "To collect", title: "To collect", source: "cellar" },
  { status: "Drunk", title: "Drunk", source: "drunk" },
];

export function titleHTML(name = config.cellarName) {
  const words = name.trim().split(/\s+/);
  const last = words.pop();
  return `${esc(words.join(" "))} <em>${esc(last)}</em>`;
}

export function statsHTML({ cellar, drunk }) {
  const sum = list => list.reduce((n, w) => n + bottleCount(w), 0);
  const inCellar = sum(cellar.filter(w => w.status === "In cellar"));
  const toCollect = sum(cellar.filter(w => w.status === "To collect"));
  const value = cellar.reduce((n, w) => n + (w.price || 0) * bottleCount(w), 0);
  return [
    `<span><b>${inCellar}</b> in the cellar</span>`,
    toCollect ? `<span><b>${toCollect}</b> to collect</span>` : "",
    `<span><b>${drunk.length}</b> drunk</span>`,
    `<span><b>${esc(config.currency)}${money(value)}</b> on the shelf</span>`,
  ].join("");
}

/** "When to open": each cellar bottle's drinking window on a shared year axis, with a line for today. */
export function timelineHTML(cellar, now = new Date()) {
  const rows = cellar
    .map(w => ({ w, win: parseWindow(w.window) }))
    .filter(r => r.win)
    .sort((a, b) => a.win.from - b.win.from || a.win.to - b.win.to);
  if (!rows.length) return "";

  const today = now.getFullYear() + now.getMonth() / 12;
  const start = Math.min(Math.floor(today), ...rows.map(r => r.win.from));
  const end = Math.max(Math.ceil(today) + 1, ...rows.map(r => r.win.to + 1));
  const x = year => `${(((year - start) / (end - start)) * 100).toFixed(2)}%`;
  const span = end - start;
  const step = span > 18 ? 5 : span > 9 ? 2 : 1;
  const ticks = [];
  for (let y = Math.ceil(start / step) * step; y < end; y += step) ticks.push(y);
  const grid = ticks.map(y => `<i class="tl-grid" style="left:${x(y)}"></i>`).join("");
  const nowLine = `<i class="tl-now" style="left:${x(today)}"></i>`;
  const year = now.getFullYear();

  const lines = rows.map(({ w, win }) => {
    const state = windowState(w.window, year);
    const label = `${w.vintage || "NV"} ${w.producer}`;
    const tip = `${label} ${w.wine}: drink ${w.window}`;
    return `<div class="tl-row" title="${esc(tip)}">
      <span class="tl-label"><b>${esc(w.vintage || "NV")}</b> ${esc(w.producer)}</span>
      <span class="tl-track">${grid}${nowLine}
        <i class="tl-bar ${state.key}" data-c="${esc(String(w.colour || "").toLowerCase())}"
           style="left:${x(win.from)};right:calc(100% - ${x(win.to + 1)})"></i>
      </span></div>`;
  }).join("");

  const axis = `<div class="tl-row tl-axis"><span class="tl-label"></span><span class="tl-track">
      ${ticks.map((y, i) => `<span class="tl-tick${i % 2 ? " alt" : ""}" style="left:${x(y)}">${y}</span>`).join("")}
      <span class="tl-now-label" style="left:${x(today)}">Now</span></span></div>`;

  return `<h2 class="section-title">When to open</h2>
    <div class="tl" role="img" aria-label="Drinking windows for ${rows.length} bottles">${lines}${axis}</div>
    <p class="tl-key"><span><i class="key now"></i>Drink now</span><span><i class="key hold"></i>Not ready</span><span><i class="key late"></i>Past its window</span></p>`;
}

function sortFor(status) {
  if (status === "Drunk") return (a, b) => String(b.drunkOn || "").localeCompare(String(a.drunkOn || ""));
  return (a, b) => (COLOUR_ORDER[a.colour] ?? 9) - (COLOUR_ORDER[b.colour] ?? 9)
    || String(a.producer).localeCompare(String(b.producer))
    || (a.vintage || 0) - (b.vintage || 0);
}

export function listHTML(state) {
  const q = state.q.trim().toLowerCase();
  const matches = w => !q || [w.producer, w.wine, w.grape, w.vintage, w.colour, w.notes].join(" ").toLowerCase().includes(q);
  const sections = SECTIONS.filter(s => state.filter === "All" || state.filter === s.status);
  let html = "";
  for (const s of sections) {
    const items = state[s.source].filter(w => (s.source === "drunk" || w.status === s.status) && matches(w)).sort(sortFor(s.status));
    if (state.filter === "All" && !items.length && (q || s.status !== "In cellar")) continue;
    const n = items.reduce((a, w) => a + bottleCount(w), 0);
    html += `<section class="group"><h2 class="section-title">${s.title}<span class="count">${n} bottle${n === 1 ? "" : "s"}</span></h2>`;
    html += items.length
      ? `<ol class="list">${items.map(w => entryHTML(w, s.source, state.owner)).join("")}</ol>`
      : `<p class="empty">${q ? "Nothing matches your search." : "Nothing here yet."}</p>`;
    html += "</section>";
  }
  return html || `<p class="empty">Nothing matches your search.</p>`;
}

function entryHTML(w, source, owner) {
  const colour = String(w.colour || "").toLowerCase();
  const meta = [];
  const kind = [w.grape, w.colour].filter(Boolean).join(" · ");
  if (kind) meta.push(`<span><i class="swatch" data-c="${esc(colour)}"></i>${esc(kind)}</span>`);

  if (source === "drunk") {
    if (w.drunkOn) meta.push(`<span>Drunk ${esc(formatDate(w.drunkOn))}</span>`);
    if (w.rating !== null && w.rating !== undefined) meta.push(`<span class="rating">${esc(w.rating)}<small>/10</small></span>`);
  } else {
    if (w.window) meta.push(`<span>Drink ${esc(w.window)}</span>`);
    const ws = windowState(w.window);
    if (ws) meta.push(`<span class="pill ${ws.key}">${ws.label}</span>`);
    if (w.storage && w.storage !== "-") meta.push(`<span>${esc(w.storage)}</span>`);
  }
  if (owner && w.hidden) meta.push(`<span class="pill hidden">Hidden</span>`);

  const n = bottleCount(w);
  const id = esc(w.id);
  const actions = !owner ? "" : `<div class="actions">
      <button class="btn" type="button" data-act="edit" data-id="${id}">Edit</button>
      ${source === "cellar" ? `<button class="btn" type="button" data-act="more" data-id="${id}">+1 bottle</button>` : ""}
      ${source === "cellar" && w.status === "To collect" ? `<button class="btn" type="button" data-act="collected" data-id="${id}">Collected</button>` : ""}
      ${source === "cellar" ? `<button class="btn" type="button" data-act="drink" data-id="${id}">Drank one</button>` : ""}
    </div>`;

  return `<li class="entry" data-id="${id}">
    <div class="vin${w.vintage ? "" : " nv"}">${w.vintage ? esc(w.vintage) : "NV"}</div>
    <div class="body">
      <div class="line">
        <span class="title"><span class="producer">${esc(w.producer)}</span> <span class="cuvee">${esc(w.wine)}</span>${
          n > 1 ? ` <span class="qty" title="${n} bottles">×${n}</span>` : ""}</span>
        <span class="dots" aria-hidden="true"></span>
        <span class="price">${w.price !== null && w.price !== undefined ? money(w.price) : "—"}</span>
      </div>
      ${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
      ${w.notes ? `<p class="notes">${esc(w.notes)}</p>` : ""}
      ${actions}
    </div>
  </li>`;
}
