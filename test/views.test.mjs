// Tests for the pure view functions in js/views.js (the browser modules, imported as-is).
// Run with: node --test   (needs Node 22+, which loads these ES modules without a build step)
import test from "node:test";
import assert from "node:assert/strict";
import { historyHTML, tastingHTML, listHTML, timelineHTML, toneOf, FALLBACK_LISTS } from "../js/views.js";

const NOW = new Date(2026, 10, 23);  // 23 Nov 2026
const drunk = [
  { id: "a", producer: "Jadot", wine: "Gevrey", vintage: 2018, grape: "Pinot Noir", price: 140, consumedOn: "2026-11-02", rating: 8 },
  { id: "b", producer: "Jadot", wine: "Beaune", vintage: 2019, grape: "Pinot Noir", price: 60, consumedOn: "2026-03-10", rating: 9 },
  { id: "c", producer: "Penfolds", wine: "Bin 128", vintage: 2024, grape: "Shiraz", price: 88, consumedOn: "2025-12-24", rating: null },
  { id: "d", producer: "Leflaive", wine: "Bourgogne", vintage: 2022, grape: "Chardonnay", consumedOn: "2024-05-01", rating: 9 },
];
const text = html => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("history: totals, average of rated bottles only, money drunk, no 'this year'", () => {
  const t = text(historyHTML(drunk, NOW, "S$"));
  assert.match(t, /4 consumed/);
  assert.doesNotMatch(t, /this year/);
  assert.match(t, /8\.7 average rating/, "(8 + 9 + 9) / 3, the unrated bottle is left out");
  assert.match(t, /S\$288 spent/);
});

test("history: no monthly chart", () => {
  assert.doesNotMatch(historyHTML(drunk, NOW), /class="months?"/);
});

test("history: best bottle is the highest rated, most recent wins a tie, and opens its card", () => {
  const html = historyHTML(drunk, NOW);
  assert.match(html, /data-act="view" data-id="b">2019 <span class="producer">Jadot<\/span> <span class="wname">Beaune<\/span><\/button> <small>9\/10/);
  assert.match(text(html), /Top producers Jadot 2 · Leflaive 1 · Penfolds 1/);
  assert.match(text(html), /Top grapes Pinot Noir 2/);
});

test("history: nothing drunk, nothing shown; no ratings, no average", () => {
  assert.equal(historyHTML([], NOW), "");
  const t = text(historyHTML([{ id: "x", producer: "P", wine: "W", consumedOn: "2026-01-01" }], NOW));
  assert.doesNotMatch(t, /average/);
  assert.doesNotMatch(t, /Best bottle/);
});

test("tasting card: shows everything, notes in full and escaped", () => {
  const html = tastingHTML({ ...drunk[0], colour: "Red", purchased: "2025-01-15", notes: "Cherry <b>& earth</b>\nLong finish" }, "S$");
  const t = text(html);
  assert.match(t, /2018 Jadot Gevrey/);
  assert.match(t, /8 \/10/);
  assert.match(t, /Consumed 2 Nov 2026/);
  assert.match(t, /Bought 15 Jan 2025/);
  assert.match(t, /Price S\$140/);
  assert.match(t, /Grape Pinot Noir · Red/);
  assert.match(html, /Cherry &lt;b&gt;&amp; earth&lt;\/b&gt;\nLong finish/);
  assert.doesNotMatch(html, /<b>& earth/);
});

test("tasting card: unrated bottle with no notes", () => {
  const t = text(tastingHTML({ id: "c", producer: "Penfolds", wine: "Bin 128", rating: null, notes: "" }));
  assert.match(t, /Not rated/);
  assert.match(t, /No tasting notes/);
  assert.match(t, /NV Penfolds/);
});

test("colours: tone and order come from the sheet's Lists tab", () => {
  const lists = { ...FALLBACK_LISTS, colours: [{ name: "Orange", tone: "white" }, { name: "Red", tone: "red" }, { name: "White", tone: "white" }] };
  assert.equal(toneOf("orange", lists), "white", "matched ignoring case");
  assert.equal(toneOf("Mystery", lists), "red", "unknown colours default to red");
  assert.equal(toneOf("Rosé"), "rose", "the built-in fallback before the sheet answers");

  const cellar = [
    { id: "r", producer: "A", wine: "x", vintage: 2018, colour: "Red", status: "In cellar", window: "2024–2030" },
    { id: "o", producer: "B", wine: "y", vintage: 2020, colour: "Orange", status: "In cellar", window: "2025–2031" },
  ];
  const html = listHTML({ q: "", filter: "All", owner: false, consumed: [], cellar, lists, settings: { currency: "€" } });
  assert.ok(html.indexOf('data-id="o"') < html.indexOf('data-id="r"'), "Orange is listed first, as in the Lists tab");
  assert.match(html, /data-id="o">\s*<div class="vin" data-tone="white">/);
  assert.match(timelineHTML(cellar, NOW, lists), /tl-bar now" data-tone="white"/);
  assert.match(tastingHTML({ producer: "B", wine: "y", colour: "Orange", price: 30 }, "€", lists), /data-tone="white"[\s\S]*€30/);
});

test("list: drunk bottles open their card, cellar bottles don't; history only without a search", () => {
  const state = { q: "", filter: "All", owner: false, consumed: drunk, cellar: [{ id: "k", producer: "Duroche", wine: "Vosne", vintage: 2018, status: "In cellar" }] };
  const html = listHTML(state);
  assert.match(html, /<li class="entry consumed" data-tone="red" data-id="a">/);
  assert.match(listHTML({ ...state, consumed: [{ ...drunk[3], colour: "White" }] }), /<li class="entry consumed" data-tone="white" data-id="d">/, "Chardonnay rows wash in straw");
  assert.match(html, /class="title entry-open" data-act="view" data-id="a"/);
  assert.match(html, /<li class="entry" data-id="k">/);
  assert.doesNotMatch(html, /data-act="view" data-id="k"/);
  assert.match(html, /class="history"/);
  assert.doesNotMatch(listHTML({ ...state, q: "jadot" }), /class="history"/);
});

test("list: an on-order bottle has Arrived but no Opened one", () => {
  const cellar = [
    { id: "k", producer: "Duroche", wine: "Vosne", vintage: 2018, status: "In cellar" },
    { id: "g", producer: "Gros", wine: "Moulin-à-Vent", vintage: 2022, status: "On order", arrival: "Collect" },
  ];
  const html = listHTML({ q: "", filter: "All", owner: true, consumed: [], cellar });
  assert.match(html, /data-act="drink" data-id="k"/);
  assert.doesNotMatch(html, /data-act="drink" data-id="g"/);
  assert.match(html, /data-act="arrived" data-id="g">Collected/);
});

test("region: shown on the entry and the tasting card, and found by search", () => {
  const cellar = [
    { id: "k", producer: "Duroche", wine: "Vosne", vintage: 2018, colour: "Red", grape: "Pinot Noir", region: "Burgundy", status: "In cellar" },
    { id: "c", producer: "Chave", wine: "Hermitage", vintage: 2017, colour: "Red", grape: "Syrah", region: "Rhône", status: "In cellar" },
  ];
  const state = { q: "", filter: "All", owner: false, consumed: [], cellar };
  assert.match(text(listHTML(state)), /Burgundy · Pinot Noir · Red/);
  const found = listHTML({ ...state, q: "rhone" });
  assert.match(found, /data-id="c"/);
  assert.doesNotMatch(found, /data-id="k"/);
  assert.match(text(tastingHTML({ ...cellar[1], consumedOn: "2026-01-01" })), /Region Rhône Grape Syrah · Red/);
});
