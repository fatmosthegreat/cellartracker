// Page wiring: state, rendering, dialogs and events. Backend calls go through api.js,
// HTML comes from views.js.
import { config } from "./config.js";
import { call, isDemo } from "./api.js";
import { todayISO, bottleCount } from "./format.js";
import { titleHTML, statsHTML, timelineHTML, listHTML } from "./views.js";

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
  drunk: [],
  key: isDemo ? null : saved.get(KEY),
  owner: false,
  loaded: false,
  filter: "All",
  q: "",
};
// Show the last copy straight away; Apps Script takes a second or two to answer.
const snapshot = isDemo ? null : saved.get(SNAPSHOT);
if (snapshot) Object.assign(state, { cellar: snapshot.cellar || [], drunk: snapshot.drunk || [], owner: !!state.key });

/* ---------- Data ---------- */

function apply(res) {
  Object.assign(state, { cellar: res.cellar || [], drunk: res.drunk || [], owner: !!res.owner, loaded: true });
  if (!isDemo) saved.set(SNAPSHOT, { cellar: state.cellar, drunk: state.drunk });
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
  state.drunk = state.drunk.filter(w => !w.hidden);
  render();
}

const findWine = id => {
  const c = state.cellar.find(w => w.id === id);
  if (c) return { wine: c, source: "cellar" };
  const d = state.drunk.find(w => w.id === id);
  return d ? { wine: d, source: "drunk" } : null;
};

/* ---------- Render ---------- */

function render() {
  $("#stats").innerHTML = statsHTML(state);
  $("#timeline").innerHTML = timelineHTML(state.cellar);
  $("#list").innerHTML = !state.loaded && !state.cellar.length
    ? `<p class="empty">Opening the cellar…</p>`
    : listHTML(state);
  document.body.classList.toggle("is-owner", state.owner);
  $("#owner-link").textContent = state.owner ? "Log out" : "Owner login";
  $("#owner-state").textContent = state.owner ? "Logged in. Bottles tagged Hidden are only visible to you." : "";
  document.querySelectorAll(".chip").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter)));
  const producers = [...new Set([...state.cellar, ...state.drunk].map(w => w.producer).filter(Boolean))].sort();
  $("#producers").innerHTML = producers.map(p => `<option value="${p.replace(/"/g, "&quot;")}"></option>`).join("");
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
  form.reset();
  $(".form-error", form).textContent = "";
  form.querySelectorAll("[data-for]").forEach(el => { el.hidden = el.dataset.for !== source; });
  $("#ed-title").textContent = !found ? "Add a bottle" : source === "drunk" ? "Edit tasting" : "Edit bottle";
  $("#ed-bottles-label").textContent = found ? "Bottles" : "How many";
  if (found) fillFields(form, found.wine);
  else fillFields(form, { purchased: todayISO(), status: "In cellar", bottles: 1 });
  const del = $("#ed-delete");
  del.hidden = !found;
  del.removeAttribute("data-armed");
  del.textContent = "Delete";
  $("#ed-more").open = !!found;
  $("#editor").showModal();
  if (!found) $("#f-producer").focus();
}

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

/* ---------- Drank one ---------- */

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
  form.elements.drunkOn.value = todayISO();
  form.elements.notes.value = wine.notes || "";
  $("#drinker").showModal();
}

$("#dr-form").addEventListener("submit", e => {
  e.preventDefault();
  const drink = readFields(e.currentTarget);
  submitFrom($("#drinker"), $("#dr-save"), () => run("drink", { id: drinking.id, drink }), res =>
    res.result.left ? `Cheers. ${res.result.left} left in the cellar.` : "Cheers. Moved to Drunk.");
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
  if (!button) return;
  const found = findWine(button.dataset.id);
  if (!found) return;
  const { wine } = found;
  const act = button.dataset.act;
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
