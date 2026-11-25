// Tests for the pure view functions in js/views.js (the browser modules, imported as-is).
// Run with: node --test   (needs Node 22+, which loads these ES modules without a build step)
import test from "node:test";
import assert from "node:assert/strict";
import { historyHTML, tastingHTML, listHTML, listedBottles, timelineHTML, toneOf, visibilityHTML, statsHTML, FALLBACK_LISTS } from "../js/views.js";

const NOW = new Date(2026, 10, 23);  // 23 Nov 2026
const drunk = [
  { id: "a", producer: "Jadot", wine: "Gevrey", vintage: 2018, grape: "Pinot Noir", price: 140, consumedOn: "2026-11-02", rating: 8 },
  { id: "b", producer: "Jadot", wine: "Beaune", vintage: 2019, grape: "Pinot Noir", price: 60, consumedOn: "2026-03-10", rating: 9 },
  { id: "c", producer: "Penfolds", wine: "Bin 128", vintage: 2024, grape: "Shiraz", price: 88, consumedOn: "2025-12-24", rating: null },
  { id: "d", producer: "Leflaive", wine: "Bourgogne", vintage: 2022, grape: "Chardonnay", price: null, consumedOn: "2024-05-01", rating: 9 },
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
  const timed = listHTML({ q: "", filter: "All", owner: true, consumed: [], cellar: [{ ...cellar[1], collectBy: "2026-11-27", collectTime: "15:00" }] });
  assert.match(timed, /Collect by 27 Nov 2026, 15:00/);
});

test("a bottle on order shows no drinking window, here or on the timeline", () => {
  const cellar = [
    { id: "k", producer: "Duroche", wine: "Vosne", vintage: 2018, status: "In cellar", window: "2024–2035" },
    { id: "g", producer: "Gros", wine: "Moulin-à-Vent", vintage: 2023, status: "On order", window: "2025–2029" },
  ];
  const html = listHTML({ q: "", filter: "All", owner: true, consumed: [], cellar });
  const order = html.slice(html.indexOf('data-id="g"'));
  assert.match(html, /Drink 2024–2035/);
  assert.doesNotMatch(order, /Drink 2025–2029|Drink now/);
  const tl = timelineHTML(cellar, NOW);
  assert.match(tl, /Duroche/);
  assert.doesNotMatch(tl, /Gros/);
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

test("search: starting with 'notes' searches only the tasting notes of opened bottles", () => {
  const cellar = [{ id: "k", producer: "Duroche", wine: "Vosne", vintage: 2018, status: "In cellar", notes: "corked spare" }];
  const consumed = [
    { id: "a", producer: "Jadot", wine: "Gevrey", consumedOn: "2026-11-02", notes: "Corked, sadly" },
    { id: "b", producer: "Corked Hill", wine: "Red", consumedOn: "2026-10-01", notes: "Lovely" },
    { id: "c", producer: "Penfolds", wine: "Bin 128", consumedOn: "2026-09-01" },
  ];
  const state = { q: "Notes CORKED", filter: "In cellar", owner: false, consumed, cellar };
  const html = listHTML(state);
  assert.match(html, /data-id="a"/);
  assert.doesNotMatch(html, /data-id="[kbc]"/, "not cellar notes, not other fields");
  assert.match(listHTML({ ...state, q: "notes" }), /data-id="a"[\s\S]*data-id="b"/, "just 'notes' lists every opened bottle with notes");
  assert.doesNotMatch(listHTML({ ...state, q: "notes" }), /data-id="c"/);
  assert.match(listHTML({ ...state, q: "corked", filter: "All" }), /data-id="b"/, "a plain search never looks in notes");
  assert.doesNotMatch(listHTML({ ...state, q: "corked", filter: "All" }), /data-id="a"/);
});

test("settings card: one checkbox per option from the server, ticked when friends see it", () => {
  const html = visibilityHTML({ options: [{ name: "price", label: "Price" }, { name: "storage", label: "Where it is <b>" }], hidden: ["price"] });
  assert.match(html, /<input type="checkbox" name="price">\s*<span>Price<\/span>/, "hidden, so unticked");
  assert.match(html, /<input type="checkbox" name="storage" checked>\s*<span>Where it is &lt;b&gt;<\/span>/, "shown, so ticked; labels escaped");
});

test("a price the server hid shows as **, everywhere; an empty one still shows as before", () => {
  const hidden = { id: "k", producer: "Duroche", wine: "Vosne", status: "In cellar" };
  const strip = ({ price, ...w }) => w;
  const state = { q: "", filter: "All", owner: false, consumed: drunk.map(strip), cellar: [hidden] };
  assert.match(text(statsHTML(state)), /\*\* on the shelf/);
  assert.match(text(historyHTML(state.consumed, NOW, "S$")), /\*\* spent/);
  assert.match(listHTML(state), /<span class="price">\*\*<\/span>/);
  assert.match(text(tastingHTML(hidden, "S$")), /Price \*\*/);

  const empty = { ...hidden, price: null };
  assert.match(listHTML({ ...state, cellar: [empty] }), /<span class="price">—<\/span>/);
  assert.doesNotMatch(text(tastingHTML(empty, "S$")), /Price/);
  assert.match(tastingHTML({ producer: "P", wine: "W" }), /<p class="empty" data-needs="tastingNotes">No tasting notes/);
});

test("print: the search filters, the card picks the sections, and drink now narrows In the cellar", () => {
  const year = new Date().getFullYear();
  const cellar = [
    { id: "r", producer: "Roumier", wine: "Chambolle", grape: "Pinot Noir", status: "In cellar", window: `${year - 2}-${year + 5}`, bottles: 2 },
    { id: "h", producer: "Raveneau", wine: "Chablis", grape: "Chardonnay", status: "In cellar", window: `${year + 3}-${year + 10}` },
    { id: "o", producer: "Dauvissat", wine: "Chablis", grape: "Chardonnay", status: "On order" },
  ];
  const state = { q: "", filter: "All", owner: false, cellar, consumed: drunk };
  const print = (sections, more = {}) => ({ ...state, ...more, print: { sections, now: false, ...more.print } });

  assert.equal(listedBottles(print(["In cellar"])), 3, "bottles, not wines");
  assert.equal(listedBottles(print(["In cellar"], { print: { now: true } })), 2, "only the one to drink now");
  assert.equal(listedBottles(print(["In cellar", "On order"], { q: "chardonnay" })), 2);
  assert.equal(listedBottles(print(["Consumed"], { q: "jadot" })), 2);
  assert.equal(listedBottles(print(["Consumed"], { print: { now: true } })), 4, "drink now leaves Consumed alone");
  assert.equal(listedBottles(print([])), 0);

  const html = listHTML(print(["In cellar", "On order"], { q: "roumier" }));
  assert.match(html, /In the cellar/);
  assert.doesNotMatch(html, /On order|Nothing/, "empty sections aren't printed");
  assert.match(html, /<span class="when">Drink /, "the window can be left out of the print");
});

test("graph chips: each shows only if it has a bottle, at most 5, starting on the first", () => {
  const wine = (producer, window, more) => ({ id: producer, producer, wine: "W", status: "In cellar", window, ...more });
  const cellar = [
    wine("Pinned", "2020-2035", { pinned: true }),
    wine("Opens", "2027-2035"), wine("Later", "2030-2040"),
    wine("Closes27", "2025-2027"), wine("Closes26", "2024-2026"),
    wine("Over22", "2015-2022"), wine("Over20", "2010-2020"),
    wine("Ordered", "2027-2030", { status: "On order", pinned: true }),
  ];
  const shown = html => [...html.matchAll(/class="tl-label"><b[^>]*>[^<]*<\/b> ([^<]+)<\/span>/g)].map(m => m[1]);
  const chips = html => [...html.matchAll(/data-graph="(\w+)" aria-pressed="(\w+)"/g)].map(m => m[1] + (m[2] === "true" ? "*" : ""));

  const start = timelineHTML(cellar, NOW);
  assert.deepEqual(chips(start), ["pinned*", "opening", "closing", "overdue"]);
  assert.deepEqual(shown(start), ["Pinned"], "only what's pinned, and never a bottle on order");
  assert.deepEqual(shown(timelineHTML(cellar, NOW, undefined, "opening")), ["Opens"], "opening next year only");
  assert.deepEqual(shown(timelineHTML(cellar, NOW, undefined, "closing")), ["Closes26", "Closes27"], "soonest to close first");
  assert.deepEqual(shown(timelineHTML(cellar, NOW, undefined, "overdue")), ["Over20", "Over22"], "longest overdue first");

  // Nothing pinned: the first chip that has a bottle; a chip that's gone falls back the same way.
  const unpinned = cellar.map(w => ({ ...w, pinned: false }));
  assert.deepEqual(chips(timelineHTML(unpinned, NOW, undefined, "pinned")), ["opening*", "closing", "overdue"]);

  // No chip has a bottle: no chips, the 5 soonest to close.
  const far = ["2030-2045", "2028-2033", "2029-2050", "2026-2031", "2020-2036", "2024-2032"].map((w, i) => wine("W" + i, w));
  const none = timelineHTML(far, NOW);
  assert.deepEqual(chips(none), []);
  assert.deepEqual(shown(none), ["W3", "W5", "W1", "W4", "W0"]);

  // At most 5 in a chip.
  const many = Array.from({ length: 7 }, (_, i) => wine("C" + i, "2020-2026"));
  assert.equal(shown(timelineHTML(many, NOW)).length, 5);
});
