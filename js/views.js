// Turns state into HTML strings. Pure: no DOM access, no network. Everything user-typed goes through esc().
//
// Colours (and their order and tone) and the currency come from the Lists and Settings tabs in
// the sheet, sent with every response as state.lists and state.settings.
import { config } from "./config.js";
import { esc, money, formatDate, bottleCount, fold, parseWindow, windowState } from "./format.js";

// Only used before the first response arrives (and in tests). The sheet's Lists tab is the real list.
export const FALLBACK_LISTS = {
  colours: [
    { name: "Sparkling", tone: "white" }, { name: "White", tone: "white" }, { name: "Rosé", tone: "rose" },
    { name: "Red", tone: "red" }, { name: "Sweet", tone: "white" }, { name: "Fortified", tone: "red" },
  ],
  grapes: [],
  regions: [],
  storage: [],
};

const listsOf = state => (state && state.lists) || FALLBACK_LISTS;
const currencyOf = state => (state && state.settings && state.settings.currency) || "";

/** "red", "white" or "rose": picks the colour of a bottle's dot, timeline bar and year. */
export function toneOf(colour, lists = FALLBACK_LISTS) {
  const key = fold(String(colour || "").trim());
  const match = lists.colours.find(c => fold(c.name) === key);
  return match ? match.tone : "red";
}

export const SECTIONS = [
  { status: "In cellar", title: "In the cellar", source: "cellar" },
  { status: "On order", title: "On order", source: "cellar" },
  { status: "Consumed", title: "Consumed", source: "consumed" },
];

export function titleHTML(name = config.cellarName) {
  const words = name.trim().split(/\s+/);
  const last = words.pop();
  return `${esc(words.join(" "))} <em>${esc(last)}</em>`;
}

// A price the server didn't send (hidden from friends in ⚙️ Settings) shows as **.
const noPrice = w => !("price" in w);
const bottles = list => list.reduce((n, w) => n + bottleCount(w), 0);

export function statsHTML(state) {
  const { cellar, consumed } = state;
  const inCellar = bottles(cellar.filter(w => w.status === "In cellar"));
  const onOrder = bottles(cellar.filter(w => w.status === "On order"));
  const value = cellar.reduce((n, w) => n + (w.price || 0) * bottleCount(w), 0);
  return [
    `<span><b>${inCellar}</b> in the cellar</span>`,
    onOrder ? `<span><b>${onOrder}</b> on order</span>` : "",
    `<span><b>${consumed.length}</b> consumed</span>`,
    `<span><b>${cellar.some(noPrice) ? "**" : esc(currencyOf(state)) + money(value)}</b> on the shelf</span>`,
  ].join("");
}

// The graph's chips, in order. A chip shows only if it has a bottle, and shows at most GRAPH_MAX.
// Windows are whole years, so "soon" means this year or next. `soonest` sorts by the window's end.
const GRAPH_MAX = 5;
const soonest = (a, b) => a.win.to - b.win.to;
const GRAPH_CHIPS = [
  { key: "pinned", label: "Pinned", has: r => !!r.w.pinned },
  { key: "opening", label: "Opening", has: (r, year) => r.win.from === year + 1 },
  { key: "closing", label: "Closing", has: (r, year) => r.win.to === year || r.win.to === year + 1, sort: soonest },
  { key: "overdue", label: "Overdue", has: (r, year) => r.win.to < year, sort: soonest },
];

/** "When to open": cellar bottles' drinking windows on a shared year axis, with a line for today.
 *  Bottles on order are left out: they can't be opened until they arrive. `chip` is the chip picked
 *  (state.graph); it starts on the first chip that has a bottle. With no chip, the 5 soonest to close. */
export function timelineHTML(cellar, now = new Date(), lists = FALLBACK_LISTS, chip = null) {
  const year = now.getFullYear();
  const all = cellar
    .filter(w => w.status !== "On order")
    .map(w => ({ w, win: parseWindow(w.window) }))
    .filter(r => r.win)
    .sort((a, b) => a.win.from - b.win.from || a.win.to - b.win.to);
  const chips = GRAPH_CHIPS.filter(c => all.some(r => c.has(r, year)));
  const picked = chips.find(c => c.key === chip) || chips[0];
  const rows = (picked ? all.filter(r => picked.has(r, year)).sort(picked.sort || (() => 0)) : all.slice().sort(soonest))
    .slice(0, GRAPH_MAX);
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

  const lines = rows.map(({ w, win }) => {
    const state = windowState(w.window, year);
    const tone = toneOf(w.colour, lists);
    const label = `${w.vintage || "NV"} ${w.producer}`;
    const tip = `${label} ${w.wine}: drink ${w.window}`;
    return `<div class="tl-row" title="${esc(tip)}">
      <span class="tl-label"><b data-tone="${tone}">${esc(w.vintage || "NV")}</b> ${esc(w.producer)}</span>
      <span class="tl-track">${grid}${nowLine}
        <i class="tl-bar ${state.key}" data-tone="${tone}"
           style="left:${x(win.from)};right:calc(100% - ${x(win.to + 1)})"></i>
      </span></div>`;
  }).join("");

  const axis = `<div class="tl-row tl-axis"><span class="tl-label"></span><span class="tl-track">
      ${ticks.map((y, i) => `<span class="tl-tick${i % 2 ? " alt" : ""}" style="left:${x(y)}">${y}</span>`).join("")}
      <span class="tl-now-label" style="left:${x(today)}">Now</span></span></div>`;

  const chipBar = chips.length ? `<div class="chips tl-chips">${chips.map(c =>
    `<button class="chip" type="button" data-graph="${c.key}" aria-pressed="${c === picked}">${c.label}</button>`).join("")}</div>` : "";

  return `<h2 class="section-title">When to open</h2>${chipBar}
    <div class="tl" role="img" aria-label="Drinking windows for ${rows.length} bottles">${lines}${axis}</div>
    <p class="tl-key"><span><i class="key now"></i>Drink now</span><span><i class="key hold"></i>Not ready</span><span><i class="key late"></i>Past its window</span></p>`;
}

// Cellar sections sort by colour (in the Lists tab's order), then producer, then vintage.
function sortFor(status, lists) {
  if (status === "Consumed") return (a, b) => String(b.consumedOn || "").localeCompare(String(a.consumedOn || ""));
  const order = new Map(lists.colours.map((c, i) => [c.name, i]));
  const rank = w => (order.has(w.colour) ? order.get(w.colour) : 99);
  return (a, b) => rank(a) - rank(b)
    || String(a.producer).localeCompare(String(b.producer))
    || (a.vintage || 0) - (b.vintage || 0);
}

// The search rule, the same as searchRecs_ in Code.gs (a test checks they agree): every word must
// appear in one of these fields, ignoring case and accents. Notes aren't searched, except by
// starting the search with "notes" ("notes corked"), like the bot's /notes: then only the tasting
// notes of opened bottles are searched.
const SEARCH_FIELDS = ["producer", "wine", "region", "grape", "colour", "vintage"];
export function matchesSearch(w, q, fields = SEARCH_FIELDS) {
  const hay = fold(fields.map(f => w[f] ?? "").join(" "));
  return fold(q).split(/\s+/).filter(Boolean).every(word => hay.includes(word));
}

/** ⚙️ Settings: one "show to friends" checkbox per option (from the server), ticked when shown. */
export function visibilityHTML({ options, hidden }) {
  return options.map(o => `<label class="check"><input type="checkbox" name="${esc(o.name)}"${hidden.includes(o.name) ? "" : " checked"}>
    <span>${esc(o.label)}</span></label>`).join("");
}

// The sections the list shows, each with its bottles that match the search. While printing,
// state.print (from the Print card) picks the sections, and `now` narrows In the cellar to the
// bottles to drink now (the graph's rule).
function listed(state) {
  const lists = listsOf(state);
  const q = state.q.trim();
  const notes = /^notes(\s|$)/i.exec(q);
  const matches = notes ? w => !!w.notes && matchesSearch(w, q.slice(5), ["notes"]) : w => matchesSearch(w, q);
  const { print } = state;
  const drinkNow = w => (windowState(w.window) || {}).key === "now";
  const ready = w => !(print && print.now && w.status === "In cellar") || drinkNow(w);
  return SECTIONS
    .filter(s => notes ? s.status === "Consumed" : state.filter === "All" || state.filter === s.status)
    .filter(s => !print || print.sections.includes(s.status))
    .map(s => ({ s, items: state[s.source].filter(w => (s.source === "consumed" || w.status === s.status) && matches(w) && ready(w)).sort(sortFor(s.status, lists)) }));
}

/** How many bottles the list shows: the Print card's count. */
export function listedBottles(state) {
  return listed(state).reduce((n, { items }) => n + bottles(items), 0);
}

export function listHTML(state) {
  const lists = listsOf(state);
  const currency = currencyOf(state);
  const q = state.q.trim();
  let html = "";
  for (const { s, items } of listed(state)) {
    if (state.filter === "All" && !items.length && (q || state.print || s.status !== "In cellar")) continue;
    const n = bottles(items);
    html += `<section class="group"><h2 class="section-title">${s.title}<span class="count">${n} bottle${n === 1 ? "" : "s"}</span></h2>`;
    if (s.status === "Consumed" && !q) html += historyHTML(state.consumed, new Date(), currency);
    html += items.length
      ? `<ol class="list">${items.map(w => entryHTML(w, s.source, state.owner, lists)).join("")}</ol>`
      : `<p class="empty">${q ? "Nothing matches your search." : "Nothing here yet."}</p>`;
    html += "</section>";
  }
  return html || `<p class="empty">Nothing matches your search.</p>`;
}

const hasRating = w => w.rating !== null && w.rating !== undefined && w.rating !== "";

/** Summary above the Consumed list: totals, best bottle, favourites. */
export function historyHTML(consumed, now = new Date(), currency = "") {
  if (!consumed.length) return "";
  const rated = consumed.filter(hasRating);
  const avg = rated.length ? rated.reduce((n, w) => n + Number(w.rating), 0) / rated.length : null;
  const spent = consumed.reduce((n, w) => n + (Number(w.price) || 0), 0);

  const best = rated.slice().sort((a, b) => Number(b.rating) - Number(a.rating)
    || String(b.consumedOn || "").localeCompare(String(a.consumedOn || "")))[0];
  const top = field => {
    const counts = new Map();
    for (const w of consumed) if (w[field]) counts.set(w[field], (counts.get(w[field]) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, 3)
      .map(([name, n]) => `${esc(name)} <small>${n}</small>`).join(" · ");
  };
  const facts = [
    best ? ["Best bottle", `<button type="button" class="linkbtn" data-act="view" data-id="${esc(best.id)}">${esc(best.vintage || "NV")} <span class="producer">${esc(best.producer)}</span> <span class="wname">${esc(best.wine)}</span></button> <small>${esc(best.rating)}/10</small>`] : null,
    ["Top producers", top("producer")],
    ["Top grapes", top("grape")],
  ].filter(f => f && f[1]);

  return `<div class="history">
    <div class="stats">
      <span><b>${consumed.length}</b> consumed</span>
      ${avg === null ? "" : `<span><b>${avg.toFixed(1)}</b> average rating</span>`}
      <span><b>${consumed.some(noPrice) ? "**" : esc(currency) + money(spent)}</b> spent</span>
    </div>
    ${facts.length ? `<dl class="history-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>` : ""}
  </div>`;
}

/** The tasting card for a consumed bottle: everything about it, notes in full. */
export function tastingHTML(w, currency = "", lists = FALLBACK_LISTS) {
  const facts = [
    ["Consumed", w.consumedOn ? formatDate(w.consumedOn) : ""],
    ["Bought", w.purchased ? formatDate(w.purchased) : ""],
    ["Price", noPrice(w) ? "**" : w.price !== null && w.price !== undefined && w.price !== "" ? `${currency}${money(w.price)}` : ""],
    ["Region", w.region],
    ["Grape", [w.grape, w.colour].filter(Boolean).join(" · ")],
  ].filter(f => f[1]);
  return `<p class="eyebrow">Tasting card</p>
    <h3 id="ts-title"><span class="ts-vin" data-tone="${toneOf(w.colour, lists)}">${esc(w.vintage || "NV")}</span> <span class="producer">${esc(w.producer)}</span><br><em class="wname">${esc(w.wine)}</em></h3>
    <p class="ts-rating">${hasRating(w) ? `${esc(w.rating)}<small>/10</small>` : `<small>Not rated</small>`}</p>
    ${facts.length ? `<dl class="ts-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}
    ${w.notes ? `<p class="ts-notes">${esc(w.notes)}</p>` : `<p class="empty" data-needs="tastingNotes">No tasting notes.</p>`}`;
}

function entryHTML(w, source, owner, lists) {
  const tone = toneOf(w.colour, lists);
  const meta = [];
  const kind = [w.region, w.grape, w.colour].filter(Boolean).join(" · ");
  if (kind) meta.push(`<span><i class="swatch" data-tone="${tone}"></i>${esc(kind)}</span>`);

  if (source === "consumed") {
    if (w.consumedOn) meta.push(`<span>Consumed ${esc(formatDate(w.consumedOn))}</span>`);
    if (hasRating(w)) meta.push(`<span class="rating">${esc(w.rating)}<small>/10</small></span>`);
  } else {
    // A bottle on order shows no drinking window until it arrives (it's still saved, and shows then).
    if (w.status !== "On order") {
      if (w.window) meta.push(`<span class="when">Drink ${esc(w.window)}</span>`);
      const ws = windowState(w.window);
      if (ws) meta.push(`<span class="pill ${ws.key}">${ws.label}</span>`);
    }
    if (w.storage) meta.push(`<span>${esc(w.storage)}</span>`);
    if (w.status === "On order") {
      const due = { Collect: "Collect by", Delivery: "Delivery by" }[w.arrival] || "Due";
      if (w.collectBy) meta.push(`<span>${due} ${esc(formatDate(w.collectBy))}${w.collectTime ? `, ${esc(w.collectTime)}` : ""}</span>`);
      else if (w.arrival) meta.push(`<span>${esc(w.arrival)}</span>`);
    }
  }
  if (owner && w.hidden) meta.push(`<span class="pill hidden">Hidden</span>`);

  const n = bottleCount(w);
  const id = esc(w.id);
  const actions = !owner ? "" : `<div class="actions">
      <button class="btn" type="button" data-act="edit" data-id="${id}">Edit</button>
      ${source === "cellar" ? `<button class="btn" type="button" data-act="more" data-id="${id}">+1 bottle</button>` : ""}
      ${source === "cellar" && w.status === "On order" ? `<button class="btn" type="button" data-act="arrived" data-id="${id}">${{ Collect: "Collected", Delivery: "Delivered" }[w.arrival] || "Arrived"}</button>` : ""}
      ${source === "cellar" && w.status === "In cellar" ? `<button class="btn" type="button" data-act="drink" data-id="${id}">Opened one</button>` : ""}
    </div>`;

  // Consumed bottles open their tasting card: the title is a button for keyboards, and app.js
  // also opens it when the rest of the entry is tapped.
  const titleInner = `<span class="producer">${esc(w.producer)}</span> <span class="cuvee wname">${esc(w.wine)}</span>${
    n > 1 ? ` <span class="qty" title="${n} bottles">×${n}</span>` : ""}`;
  const title = source === "consumed"
    ? `<button type="button" class="title entry-open" data-act="view" data-id="${id}">${titleInner}</button>`
    : `<span class="title">${titleInner}</span>`;

  return `<li class="entry${source === "consumed" ? ` consumed" data-tone="${tone}` : ""}" data-id="${id}">
    <div class="vin${w.vintage ? "" : " nv"}" data-tone="${tone}">${w.vintage ? esc(w.vintage) : "NV"}</div>
    <div class="body">
      <div class="line">
        ${title}
        <span class="dots" aria-hidden="true"></span>
        <span class="price">${noPrice(w) ? "**" : w.price !== null && w.price !== undefined ? money(w.price) : "—"}</span>
      </div>
      ${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
      ${w.notes ? `<p class="notes">${esc(w.notes)}</p>` : ""}
      ${actions}
    </div>
  </li>`;
}
