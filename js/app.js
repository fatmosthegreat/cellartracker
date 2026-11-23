// Page wiring: state, rendering, dialogs and events. Backend calls go through api.js,
// HTML comes from views.js.
import { config } from "./config.js";
import { call, isDemo } from "./api.js";
import { todayISO, bottleCount, esc } from "./format.js";
import { titleHTML, statsHTML, timelineHTML, listHTML, tastingHTML, FALLBACK_LISTS } from "./views.js";

const $ = (sel, el = document) => el.querySelector(sel);

const saved = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* fine */ } },
};
const KEY = "cellar.key";
const SNAPSHOT = isDemo ? "cellar.demo.snapshot" : "cellar.snapshot";

const state = {
  cellar: [],
  consumed: [],
  lists: FALLBACK_LISTS,  // colours, grapes, storage places: from the sheet's Lists tab
  settings: {},           // currency etc.: from the sheet's Settings tab
  key: isDemo ? null : saved.get(KEY),
  owner: false,
  loaded: false,
  filter: "All",
  q: "",
};
// Show the last copy straight away; Apps Script takes a second or two to answer.
const snapshot = isDemo ? null : saved.get(SNAPSHOT);
if (snapshot) {
  Object.assign(state, {
    cellar: snapshot.cellar || [], consumed: snapshot.consumed || [], owner: !!state.key,
    lists: snapshot.lists || FALLBACK_LISTS, settings: snapshot.settings || {},
  });
}

/* ---------- Data ---------- */

function apply(res) {
  Object.assign(state, {
    cellar: res.cellar || [], consumed: res.consumed || [], owner: !!res.owner, loaded: true,
    lists: res.lists || state.lists, settings: res.settings || state.settings,
  });
  if (!isDemo) saved.set(SNAPSHOT, { cellar: state.cellar, consumed: state.consumed, lists: state.lists, settings: state.settings });
  render();
  return res;
}

async function run(action, payload) {
  try {
    return apply(await call(action, payload, state.key));
  } catch (err) {
    if (err.auth) logOut();
    throw err;
  }
}

async function refresh() {
  try {
    await run("list");
  } catch (err) {
    state.loaded = true;
    render();
    toast(err.message, true);
  }
}

function logOut() {
  state.key = null;
  state.owner = false;
  saved.del(KEY);
  saved.del(SNAPSHOT);
  state.cellar = state.cellar.filter(w => !w.hidden);
  state.consumed = state.consumed.filter(w => !w.hidden);
  render();
}

const findWine = id => {
  const c = state.cellar.find(w => w.id === id);
  if (c) return { wine: c, source: "cellar" };
  const d = state.consumed.find(w => w.id === id);
  return d ? { wine: d, source: "consumed" } : null;
};

/* ---------- Render ---------- */

function render() {
  $("#stats").innerHTML = statsHTML(state);
  $("#timeline").innerHTML = timelineHTML(state.cellar, new Date(), state.lists);
  $("#list").innerHTML = !state.loaded && !state.cellar.length
    ? `<p class="empty">Opening the cellar…</p>`
    : listHTML(state);
  document.body.classList.toggle("is-owner", state.owner);
  $("#owner-link").textContent = state.owner ? "Log out" : "Owner login";
  $("#owner-state").textContent = state.owner ? "Logged in. Bottles tagged Hidden are only visible to you." : "";
  document.querySelectorAll(".chip").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter)));
  // Typing suggestions: the sheet's lists first, then anything already used on your bottles.
  const all = [...state.cellar, ...state.consumed];
  const options = (listed, field) => [...new Set([...listed, ...all.map(w => w[field]).filter(Boolean).sort()])]
    .map(v => `<option value="${esc(v)}"></option>`).join("");
  $("#producers").innerHTML = options([], "producer");
  $("#grapes").innerHTML = options(state.lists.grapes, "grape");
  $("#places").innerHTML = options(state.lists.storage, "storage");
}

// The Colour dropdown: the Lists tab's colours, plus the bottle's own colour if it isn't one of them
// (so editing an older bottle never quietly clears it).
function fillColours(current) {
  const names = state.lists.colours.map(c => c.name);
  if (current && !names.includes(current)) names.push(current);
  $("#f-colour").innerHTML = `<option value="">Not set</option>` + names.map(n => `<option>${esc(n)}</option>`).join("");
}

let toastTimer;
function toast(message, isError = false) {
  const t = $("#toast");
  t.textContent = message;
  t.classList.toggle("error", isError);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), isError ? 5000 : 2600);
}

/* ---------- Dialog helpers ---------- */

// Runs a save from inside a dialog: busy button, inline error, close on success.
async function submitFrom(dialog, button, work, okMessage) {
  const error = $(".form-error", dialog);
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Saving…";
  error.textContent = "";
  try {
    const res = await work();
    dialog.close();
    toast(typeof okMessage === "function" ? okMessage(res) : okMessage);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// Reads the named controls of a form that are in use. Blank → null; the backend clears those fields.
function readFields(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.closest("[hidden]")) continue;
    const field = el.dataset.field || el.name;
    out[field] = el.type === "checkbox" ? el.checked : el.value.trim() || null;
  }
  return out;
}

function fillFields(form, wine) {
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = wine[el.dataset.field || el.name];
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v ?? "";
  }
}

/* ---------- Add / edit ---------- */

let editing = null;  // { wine, source } or null when adding

function openEditor(found) {
  editing = found;
  const form = $("#ed-form");
  const source = found ? found.source : "cellar";
  fillColours(found && found.wine.colour);
  form.reset();
  $(".form-error", form).textContent = "";
  form.querySelectorAll("[data-for]").forEach(el => { el.hidden = el.dataset.for !== source; });
  $("#ed-title").textContent = !found ? "Add a bottle" : source === "consumed" ? "Edit tasting" : "Edit bottle";
  $("#ed-bottles-label").textContent = found ? "Bottles" : "How many";
  if (found) fillFields(form, found.wine);
  else fillFields(form, { purchased: todayISO(), status: "In cellar", bottles: 1 });
  const del = $("#ed-delete");
  del.hidden = !found;
  del.removeAttribute("data-armed");
  del.textContent = "Delete";
  $("#ed-more").open = !!found;
  resetAi();
  $("#ai-toggle").hidden = !!found || isDemo;  // demo mode has no AI key behind it
  $("#editor").showModal();
  if (!found) $("#f-producer").focus();
}

/* ---------- ✨ Fill in with AI (when adding) ---------- */
// The text and photo go to the backend's `identify` action, the same code the Telegram bot uses,
// with your passkey like any other change. Nothing is saved: the answer fills in the form, and
// you check it and press Save as usual.

let aiPhoto = null;  // { media_type, data } once shrunk, or null

function resetAi() {
  aiPhoto = null;
  $("#ai-panel").hidden = true;
  $("#ai-toggle").setAttribute("aria-expanded", "false");
  $("#ai-text").value = "";
  $("#ai-photo").value = "";
  $(".ai-cam").classList.remove("has-photo");
  aiStatus("");
}

// Status under the panel. Set with textContent only, so nothing in a reply can become HTML.
function aiStatus(text, isError = false, offerStronger = false) {
  const s = $("#ai-status");
  s.textContent = text;
  s.classList.toggle("error", isError);
  if (offerStronger) {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "linkbtn", textContent: "Not right? Try the stronger model" });
    b.dataset.strong = "";
    s.append(" ", b);
  }
}

// Redraws the photo as a JPEG of at most 1600px before it leaves the device: smaller to send,
// cheaper to read, and redrawing drops its metadata, such as where it was taken.
async function shrinkPhoto(file, max = 1600) {
  if (!file.type.startsWith("image/")) throw new Error("not an image");
  const img = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close();
  return { media_type: "image/jpeg", data: canvas.toDataURL("image/jpeg", 0.85).split(",")[1] };
}

async function fillWithAi(strong) {
  const text = $("#ai-text").value.trim();
  if (!text && !aiPhoto) return aiStatus("Type the wine or add a photo first.", true);
  const go = $("#ai-go");
  go.disabled = true;
  aiStatus(strong ? "Asking the stronger model…" : "Looking it up…");
  try {
    const w = (await run("identify", { identify: { text, photo: aiPhoto, strong } })).result;
    const form = $("#ed-form");
    fillColours(w.colour);
    for (const k of ["producer", "wine", "vintage", "colour", "grape"]) form.elements[k].value = w[k] || "";
    $("#ed-more").open = true;
    aiStatus("Filled in. Check it, add the drinking window, then Save.", false, !strong);
    $("#f-window").focus();
  } catch (err) {
    aiStatus(err.message, true);
  } finally {
    go.disabled = false;
  }
}

$("#ai-toggle").addEventListener("click", () => {
  const opening = $("#ai-panel").hidden;
  $("#ai-panel").hidden = !opening;
  $("#ai-toggle").setAttribute("aria-expanded", String(opening));
  if (opening) $("#ai-text").focus();
});

$("#ai-photo").addEventListener("change", async e => {
  const file = e.target.files[0];
  aiPhoto = null;
  $(".ai-cam").classList.remove("has-photo");
  if (!file) return;
  try {
    aiPhoto = await shrinkPhoto(file);
    $(".ai-cam").classList.add("has-photo");
    aiStatus("Photo ready. Add a note if you like, then tap Fill in.");
  } catch {
    aiStatus("That photo couldn't be opened. Try another.", true);
  }
});

// Enter in the AI box looks the wine up; it must not submit (save) the form.
$("#ai-text").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); fillWithAi(false); } });
$("#ai-go").addEventListener("click", () => fillWithAi(false));
$("#ai-status").addEventListener("click", e => { if (e.target.closest("[data-strong]")) fillWithAi(true); });

$("#ed-form").addEventListener("submit", e => {
  e.preventDefault();
  const form = e.currentTarget;
  const wine = readFields(form);
  const problem = !wine.producer || !wine.wine ? "Add a producer and a wine name."
    : wine.vintage && !/^\d{4}$/.test(wine.vintage) ? "Vintage should be a year like 2020, or blank for NV." : "";
  if (problem) { $(".form-error", form).textContent = problem; return; }

  if (editing) {
    submitFrom($("#editor"), $("#ed-save"), () => run("update", { id: editing.wine.id, wine }), "Saved");
  } else {
    submitFrom($("#editor"), $("#ed-save"), () => run("create", { wine }), res =>
      res.result.merged ? `You already had this one. Now ${res.result.bottles} bottles.` : "Added to the cellar");
  }
});

$("#ed-delete").addEventListener("click", e => {
  const b = e.currentTarget;
  if (!editing) return;
  if (!b.hasAttribute("data-armed")) {
    b.setAttribute("data-armed", "");
    b.textContent = "Tap again to delete";
    return;
  }
  submitFrom($("#editor"), b, () => run("remove", { id: editing.wine.id }), "Deleted");
});

/* ---------- Opened one ---------- */

let drinking = null;

function openDrinker(wine) {
  drinking = wine;
  const form = $("#dr-form");
  const n = bottleCount(wine);
  form.reset();
  $(".form-error", form).textContent = "";
  $("#dr-sub").textContent = `${wine.vintage || "NV"} ${wine.producer} ${wine.wine}`;
  $("#dr-count-row").hidden = n < 2;
  form.elements.count.max = n;
  form.elements.count.value = 1;
  form.elements.consumedOn.value = todayISO();
  form.elements.notes.value = wine.notes || "";
  $("#drinker").showModal();
}

$("#dr-form").addEventListener("submit", e => {
  e.preventDefault();
  const drink = readFields(e.currentTarget);
  submitFrom($("#drinker"), $("#dr-save"), () => run("drink", { id: drinking.id, drink }), res =>
    res.result.left ? `Cheers. ${res.result.left} left in the cellar.` : "Cheers. Moved to Consumed.");
});

/* ---------- Tasting card ---------- */

let viewing = null;

function openTasting(wine) {
  viewing = wine;
  $("#ts-body").innerHTML = tastingHTML(wine, state.settings.currency || "", state.lists);
  $("#ts-edit").hidden = !state.owner;
  $("#tasting").showModal();
}

$("#ts-edit").addEventListener("click", () => {
  $("#tasting").close();
  openEditor({ wine: viewing, source: "consumed" });
});

/* ---------- Print ---------- */

// Prints the bottles in the cellar as a clean list (css/cellar.css has the print styles),
// then puts the filter and search back as they were.
$("#print-link").addEventListener("click", () => {
  const before = { filter: state.filter, q: state.q };
  Object.assign(state, { filter: "In cellar", q: "" });
  render();
  window.addEventListener("afterprint", () => { Object.assign(state, before); render(); }, { once: true });
  window.print();
});

/* ---------- Login ---------- */

$("#owner-link").addEventListener("click", () => {
  if (state.owner) {
    logOut();
    refresh();
    toast("Logged out. This is what friends see.");
    return;
  }
  const form = $("#lg-form");
  form.reset();
  $(".form-error", form).textContent = "";
  $("#lg-hint").hidden = !isDemo;
  $("#login").showModal();
});

$("#lg-form").addEventListener("submit", e => {
  e.preventDefault();
  const key = e.currentTarget.elements.key.value;
  if (!key) return;
  submitFrom($("#login"), $("#lg-save"), async () => {
    const res = await call("login", {}, key);
    state.key = key;
    if (!isDemo) saved.set(KEY, key);
    return apply(res);
  }, "Logged in. You can edit now.");
});

/* ---------- Events ---------- */

document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));
document.querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => { state.filter = b.dataset.filter; render(); }));
$("#search").addEventListener("input", e => { state.q = e.target.value; render(); });
$("#add").addEventListener("click", () => openEditor(null));

$("#list").addEventListener("click", async e => {
  const button = e.target.closest("[data-act]");
  if (!button) {
    // Tapping anywhere on a consumed bottle opens its tasting card.
    const entry = e.target.closest(".entry.consumed");
    const hit = entry && findWine(entry.dataset.id);
    if (hit) openTasting(hit.wine);
    return;
  }
  const found = findWine(button.dataset.id);
  if (!found) return;
  const { wine } = found;
  const act = button.dataset.act;
  if (act === "view") return openTasting(wine);
  if (act === "edit") return openEditor(found);
  if (act === "drink") return openDrinker(wine);

  button.disabled = true;
  try {
    if (act === "more") {
      const res = await run("adjust", { id: wine.id, delta: 1 });
      toast(`${res.result.bottles} bottles of ${wine.producer} ${wine.wine}`);
    }
    if (act === "collected") {
      await run("update", { id: wine.id, wine: { status: "In cellar", storage: null } });
      toast("Moved into the cellar");
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
});

/* ---------- Start ---------- */

document.title = config.cellarName;
$("#title").innerHTML = titleHTML();
$("#demo-note").hidden = !isDemo;
render();
refresh();
