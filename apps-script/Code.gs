/**
 * Cellar API: the Google Apps Script backend for the cellar page.
 *
 * Data lives in two tabs of the spreadsheet this script is bound to:
 *   Cellar  bottles you own. One row per wine + vintage, with a bottle count and a status.
 *   Consumed  one row per bottle you've opened.
 * Opening a bottle moves it from Cellar to Consumed. When the last bottle of a wine is opened,
 * its Cellar row is deleted.
 *
 * Columns are matched by header name, so you can reorder them or add your own columns in the
 * sheet; the app leaves columns it doesn't know about alone.
 *
 * First run:  setPassword() → setup() → Deploy as web app.   (See README.md.)
 * Telegram:   setTelegram() → findTelegramChatId() → installTelegram(), then for fast replies
 *             relaySecret() → Cloudflare Worker → installTelegramRelay().   (Optional; see README.md.)
 * New field:  add it to SCHEMA (and FIELD_RULES if it isn't free text), then run migrate().
 * Lists:      colours, grapes and storage places live in the "Lists" tab; currency and reminder
 *             timing in the "Settings" tab. migrate() creates both. Edit them in the sheet.
 * Check-up:   status() shows the stored settings, timers and whether the web app runs this build.
 * Tests:      `node --test` in the repo runs this file against an in-memory sheet.
 *
 * Written for the Apps Script V8 runtime. Avoids ?. and ?? to stay on safe syntax.
 */

const API_VERSION = 1;

// Change this whenever you change this file. status() compares it with the deployed web app's,
// so you can tell when the web app is still running an older version.
const BUILD = '2026-11-23.13';

const SCHEMA = {
  Cellar: ['id', 'producer', 'wine', 'vintage', 'colour', 'grape', 'window', 'bottles', 'status',
    'storage', 'price', 'purchased', 'notes', 'hidden', 'created', 'updated', 'collectBy'],
  Consumed: ['id', 'producer', 'wine', 'vintage', 'colour', 'grape', 'price', 'purchased',
    'consumedOn', 'rating', 'notes', 'hidden', 'created', 'updated'],
};

// How each field is checked. A field not listed here is free text (trimmed, max 1000 characters).
const FIELD_RULES = {
  producer: { required: true, label: 'Producer' },
  wine: { required: true, label: 'Wine' },
  vintage: { type: 'int', min: 1800, max: 2100, label: 'Vintage' },
  bottles: { type: 'int', min: 1, max: 9999, label: 'Bottles' },
  price: { type: 'number', min: 0, max: 10000000, label: 'Price' },
  rating: { type: 'number', min: 0, max: 10, label: 'Rating' },
  purchased: { type: 'date', label: 'Bought on' },
  consumedOn: { type: 'date', label: 'Consumed on' },
  collectBy: { type: 'date', label: 'Collect by' },
  status: { type: 'enum', values: ['In cellar', 'To collect'], label: 'Status' },
  hidden: { type: 'bool' },
};

const SYSTEM_FIELDS = ['id', 'created', 'updated'];
// Wrong passkeys lock one device after 8 tries; 40 from anywhere locks everyone, as a backstop.
const AUTH = { maxFailedLogins: 8, maxFailedLoginsAll: 40, lockoutSeconds: 600 };

/* ---------- Lookup tabs: lists and settings you edit in the sheet ---------- */
//
// "Lists": one column per list, read down from row 2. Colour order is the order on the page.
//   colourTone (red, white or rose) picks the colour of the dot, timeline bar and year.
// "Settings": setting / value rows. Blank or invalid values fall back to the defaults below.
// migrate() creates both tabs, filled with these defaults, if they don't exist yet.

const LOOKUP_TABS = { lists: 'Lists', settings: 'Settings', log: 'Reminders log' };

const DEFAULT_LISTS = {
  colours: [
    { name: 'Sparkling', tone: 'white' }, { name: 'White', tone: 'white' }, { name: 'Rosé', tone: 'rose' },
    { name: 'Red', tone: 'red' }, { name: 'Sweet', tone: 'white' }, { name: 'Fortified', tone: 'red' },
  ],
  grapes: ['Pinot Noir', 'Chardonnay', 'Gamay', 'Shiraz', 'Syrah', 'Grenache', 'Mourvèdre', 'Cabernet Sauvignon',
    'Merlot', 'Cabernet Franc', 'Malbec', 'Nebbiolo', 'Sangiovese', 'Tempranillo', 'Riesling', 'Sauvignon Blanc',
    'Chenin Blanc', 'Sémillon', 'Viognier', 'Pinot Meunier'],
  storage: [],
};

const SETTINGS = {
  currency: { value: 'S$', about: 'Shown before prices on the page and in Telegram',
    check: function (v) { return v.length <= 6 ? v : null; } },
  reminderHour: { value: 9, about: 'Hour (0–23) the Telegram reminders go out, in the project time zone',
    check: function (v) { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null; } },
  closeReminderMonths: { value: 6, about: 'Months before a drinking window ends to remind you (0 = never)',
    check: function (v) { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 11 ? n : null; } },
  nudgeDay: { value: 'Monday', about: 'Day of the weekly "still to collect" reminder (or none)',
    check: function (v) {
      const day = WEEKDAYS.filter(function (d) { return d.toLowerCase() === String(v).toLowerCase(); })[0];
      return day || (String(v).toLowerCase() === 'none' ? 'none' : null);
    } },
  aiDailyLimit: { value: 100, about: 'Most AI look-ups (bot and website together) in one day, so a leaked passkey or a stuck loop can\'t run up the bill',
    check: function (v) { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : null; } },
};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Fields whose values are matched to a list's spelling when saved ("pinot noir" → "Pinot Noir").
const LIST_FIELDS = {
  colour: function (l) { return l.colours.map(function (c) { return c.name; }); },
  grape: function (l) { return l.grapes; },
  storage: function (l) { return l.storage; },
};

// Every action the page can call. `auth` needs the passkey; `write` runs under a lock.
const ROUTES = {
  list: { auth: false, run: function () { return null; } },
  login: { auth: true, run: function () { return null; } },
  create: { auth: true, write: true, run: function (req) { return createWine_(req.wine); } },
  update: { auth: true, write: true, run: function (req) { return updateWine_(req.id, req.wine); } },
  remove: { auth: true, write: true, run: function (req) { return removeWine_(req.id); } },
  adjust: { auth: true, write: true, run: function (req) { return adjustBottles_(req.id, req.delta); } },
  drink: { auth: true, write: true, run: function (req) { return drinkWine_(req.id, req.drink); } },
  identify: { auth: true, run: function (req) { return identifyFromPage_(req.identify); } },
};

/* ============================== Setup (run from the editor) ============================== */

function setPassword() {
  const passkey = 'type-your-passkey-here';
  if (!passkey || passkey === 'type-your-passkey-here') {
    throw new Error('Replace type-your-passkey-here with your passkey, then run setPassword again.');
  }
  const salt = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperties({ PASS_SALT: salt, PASS_HASH: sha256_(salt + passkey) });
  Logger.log('Saved as a salted SHA-256 hash. Now change the line back to type-your-passkey-here and save.');
}

// Creates the tabs (Cellar, Consumed, Lists, Settings) on a new sheet; they start empty, and you add
// bottles from the page. Safe to run again. Demo mode and the tests pass `sample` bottles
// (dev/fake-gas.js) to start from; those are only added to empty tabs.
function setup(sample) {
  migrate();
  if (!sample || !sample.cellar) {
    Logger.log('Your tabs are ready. Add bottles from the page.');
    return;
  }
  const cellar = table_('Cellar');
  const consumed = table_('Consumed');
  if (readRows_(cellar).length || readRows_(consumed).length) {
    throw new Error('Your tabs already have bottles, so no sample bottles were added.');
  }
  const now = timestamp_();
  const base = function () { return { id: newId_(), hidden: false, created: now, updated: now }; };
  sample.cellar.forEach(function (w) { appendRow_(cellar, encode_(cellar, Object.assign(base(), w))); });
  (sample.consumed || []).forEach(function (w) { appendRow_(consumed, encode_(consumed, Object.assign(base(), w))); });
}

// Adds any SCHEMA columns a tab is missing (at the end), and creates the Lists, Settings and
// Reminders log tabs if they don't exist. Never deletes, moves or overwrites anything.
function migrate() {
  freshReads_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(LOOKUP_TABS.lists)) {
    const l = DEFAULT_LISTS;
    const rows = Math.max(l.colours.length, l.grapes.length, 1);
    const values = [['colour', 'colourTone', 'grape', 'storage']];
    for (let i = 0; i < rows; i++) {
      const c = l.colours[i];
      values.push([c ? c.name : '', c ? c.tone : '', l.grapes[i] || '', l.storage[i] || '']);
    }
    writeTab_(ss.insertSheet(LOOKUP_TABS.lists), values);
  }
  if (!ss.getSheetByName(LOOKUP_TABS.settings)) {
    writeTab_(ss.insertSheet(LOOKUP_TABS.settings), [['setting', 'value', 'about']].concat(Object.keys(SETTINGS)
      .map(function (k) { return [k, String(SETTINGS[k].value), SETTINGS[k].about]; })));
  }
  if (!ss.getSheetByName(LOOKUP_TABS.log)) {
    writeTab_(ss.insertSheet(LOOKUP_TABS.log), [['key', 'sentOn']]).hideSheet();
  }
  Object.keys(SCHEMA).forEach(function (name) {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    const width = sh.getLastColumn();
    const header = width ? sh.getRange(1, 1, 1, width).getDisplayValues()[0].map(trim_) : [];
    const missing = SCHEMA[name].filter(function (f) { return header.indexOf(f) < 0; });
    if (missing.length) {
      sh.getRange(1, header.length + 1, 1, missing.length).setNumberFormat('@').setValues([missing]).setFontWeight('bold');
    }
    sh.setFrozenRows(1);
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  freshReads_();
}

// Replaces a whole tab with `values` (first row is the header), as plain text.
function writeTab_(sh, values) {
  sh.clearContents();
  sh.getRange(1, 1, values.length, values[0].length).setNumberFormat('@').setValues(values);
  sh.getRange(1, 1, 1, values[0].length).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

/* ============================== Web app entry points ============================== */

// Opening the web app URL in a browser shows the public list. Handy for checking a deployment.
function doGet() {
  return json_(handle_({ action: 'list' }));
}

// The page POSTs plain-text JSON ({ action, key?, ... }) so the browser skips the CORS preflight.
// The Telegram relay (relay/worker.mjs) POSTs { telegram: update, relayKey } to the same URL.
function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, apiVersion: API_VERSION, build: BUILD, error: 'Bad request: the body must be JSON.' });
  }
  if (req && req.telegram) return json_({ ok: relayTelegram_(req), build: BUILD });
  return json_(handle_(req));
}

// Pure request → response. Kept apart from doPost so the tests can call it directly.
function handle_(req) {
  freshReads_();
  const fail = function (extra) { return Object.assign({ ok: false, apiVersion: API_VERSION, build: BUILD }, extra); };
  try {
    req = req || {};
    const route = ROUTES[req.action];
    if (!route) throw new Error('Unknown action "' + req.action + '".');
    const owner = req.key ? checkKey_(req.key, req.device) : false;
    if (req.key && !owner) return fail({ auth: false, error: 'Wrong passkey.' });
    if (route.auth && !owner) return fail({ auth: false, error: 'Log in to make changes.' });
    const result = route.write ? withLock_(function () { return route.run(req); }) : route.run(req);
    const snap = snapshot_(owner);
    const look = lookups_();
    return {
      ok: true, apiVersion: API_VERSION, build: BUILD, owner: owner, result: result,
      cellar: snap.cellar, consumed: snap.consumed, lists: look.lists, settings: look.settings,
    };
  } catch (err) {
    return fail({ error: String((err && err.message) || err) });
  }
}

/* ============================== Actions ============================== */

// Adds bottles. If the same wine + vintage is already in the cellar with the same status
// (and no conflicting price), its bottle count goes up instead of adding a duplicate row.
function createWine_(input) {
  const rec = clean_('Cellar', input, false);
  rec.status = rec.status || 'In cellar';
  rec.bottles = rec.bottles || 1;
  const t = table_('Cellar');
  const key = wineKey_(rec);
  const match = readRows_(t).filter(function (r) {
    return wineKey_(r.rec) === key && r.rec.status === rec.status &&
      (rec.price === null || rec.price === undefined || r.rec.price === null || r.rec.price === rec.price);
  })[0];
  const now = timestamp_();

  if (match) {
    const merged = Object.assign({}, match.rec, { bottles: (match.rec.bottles || 1) + rec.bottles, updated: now });
    SCHEMA.Cellar.forEach(function (f) {  // fill in anything the existing row was missing
      if (isBlank_(merged[f]) && !isBlank_(rec[f])) merged[f] = rec[f];
    });
    writeRow_(t, match.row, encode_(t, merged, match.cells));
    return { id: match.rec.id, merged: true, bottles: merged.bottles };
  }

  const full = Object.assign({ hidden: false }, rec, { id: newId_(), created: now, updated: now });
  appendRow_(t, encode_(t, full));
  return { id: full.id, merged: false, bottles: full.bottles };
}

function updateWine_(id, input) {
  const found = findAnywhere_(id);
  const changes = clean_(found.tab.name, input, true);
  const next = Object.assign({}, found.rec, changes, { updated: timestamp_() });
  writeRow_(found.tab, found.row, encode_(found.tab, next, found.cells));
  return { id: found.rec.id };
}

function removeWine_(id) {
  const found = findAnywhere_(id);
  deleteRow_(found.tab, found.row, found.rec.id);
  return { id: found.rec.id };
}

// delta: +1 when you buy another bottle, -1 to correct a count. Can't go below 1.
function adjustBottles_(id, delta) {
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0 || Math.abs(d) > 100) throw new Error('Change the count by a whole number of bottles.');
  const t = table_('Cellar');
  const found = findIn_(t, id);
  if (!found) throw new Error('That bottle is no longer in the cellar. Refresh the page.');
  const next = (found.rec.bottles || 1) + d;
  if (next < 1) throw new Error('That would leave no bottles. Use "Opened one" or Delete instead.');
  writeRow_(t, found.row, encode_(t, Object.assign({}, found.rec, { bottles: next, updated: timestamp_() }), found.cells));
  return { id: found.rec.id, bottles: next };
}

// Moves `count` bottles (default 1) from Cellar to Consumed, one Consumed row per bottle.
// Consumed rows are written first, so a failure part-way can never lose a bottle.
function drinkWine_(id, input) {
  const d = input || {};
  const cellar = table_('Cellar');
  const found = findIn_(cellar, id);
  if (!found) throw new Error('That bottle is no longer in the cellar. Refresh the page.');

  const count = isBlank_(d.count) ? 1 : cleanValue_('bottles', d.count);
  const have = found.rec.bottles || 1;
  if (count > have) throw new Error(have === 1 ? 'There is only 1 bottle of this wine.' : 'There are only ' + have + ' bottles of this wine.');

  const details = clean_('Consumed', { consumedOn: d.consumedOn, rating: d.rating, notes: d.notes }, true);
  const consumed = table_('Consumed');
  const now = timestamp_();
  const ids = [];
  for (let i = 0; i < count; i++) {
    const rec = {};
    SCHEMA.Consumed.forEach(function (f) { if (f in found.rec) rec[f] = found.rec[f]; });
    Object.assign(rec, {
      id: newId_(),
      consumedOn: details.consumedOn || today_(),
      rating: 'rating' in d ? details.rating : null,
      notes: 'notes' in d ? details.notes : found.rec.notes,
      created: now,
      updated: now,
    });
    appendRow_(consumed, encode_(consumed, rec));
    ids.push(rec.id);
  }

  const left = have - count;
  if (left > 0) {
    writeRow_(cellar, found.row, encode_(cellar, Object.assign({}, found.rec, { bottles: left, updated: now }), found.cells));
  } else {
    deleteRow_(cellar, found.row, found.rec.id);
  }
  return { consumedIds: ids, left: left };
}

function snapshot_(owner) {
  const visible = function (rec) { return owner || !rec.hidden; };
  const recs = function (name) { return readRows_(table_(name)).map(function (r) { return r.rec; }).filter(visible); };
  return { cellar: recs('Cellar'), consumed: recs('Consumed') };
}

/* ============================== Validation ============================== */

// Keeps only fields that belong to the tab and checks each one. `partial` is for updates:
// only the fields sent are checked, and a blank value clears that field.
function clean_(tab, input, partial) {
  if (!input || typeof input !== 'object') throw new Error('Missing bottle details.');
  const out = {};
  SCHEMA[tab].forEach(function (f) {
    if (SYSTEM_FIELDS.indexOf(f) >= 0 || !(f in input)) return;
    out[f] = cleanValue_(f, input[f]);
  });
  SCHEMA[tab].forEach(function (f) {
    const rule = FIELD_RULES[f];
    if (!rule || !rule.required) return;
    if ((partial ? f in out : true) && isBlank_(out[f])) throw new Error(rule.label + " can't be blank.");
  });
  return out;
}

function cleanValue_(field, value) {
  const rule = FIELD_RULES[field] || {};
  if (rule.type === 'bool') return value === true || value === 'true' || value === 'TRUE';
  if (isBlank_(value)) return null;
  const s = String(value).trim();
  if (rule.type === 'int' || rule.type === 'number') {
    // Drop thousands separators and any currency in front: "S$1,200", "$45", "€ 30", "USD 80".
    const n = Number(s.replace(/[,\s]/g, '').replace(/^[^\d.\-]+/, ''));
    const whole = rule.type === 'int';
    if (!isFinite(n) || (whole && !Number.isInteger(n)) || n < rule.min || n > rule.max) {
      throw new Error(rule.label + ' must be ' + (whole ? 'a whole number' : 'a number') + ' from ' + rule.min + ' to ' + rule.max + '.');
    }
    return n;
  }
  if (rule.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(rule.label + ' must be a date like 2026-11-27.');
  if (rule.type === 'enum' && rule.values.indexOf(s) < 0) throw new Error(rule.label + ' must be one of: ' + rule.values.join(', ') + '.');
  if (LIST_FIELDS[field]) return matchList_(s, LIST_FIELDS[field](lookups_().lists)).slice(0, 1000);
  return s.slice(0, 1000);
}

// Returns the list's spelling if `s` matches an entry ignoring case, accents and extra spaces,
// otherwise `s` as typed. Values not in the list are allowed.
function matchList_(s, list) {
  const key = function (v) { return fold_(v).replace(/\s+/g, ' ').trim(); };
  const k = key(s);
  return list.filter(function (v) { return key(v) === k; })[0] || s.replace(/\s+/g, ' ');
}

// "Jadot | Gevrey-Chambertin | 2018" and "jadot | gevrey chambertin | 2018" are the same wine.
function wineKey_(w) {
  const norm = function (s) { return fold_(s).replace(/[^a-z0-9]+/g, ' ').trim(); };
  return [norm(w.producer), norm(w.wine), w.vintage || 'nv'].join('|');
}

/* ============================== Sheet access ============================== */

// Reads are cached for the length of one request (or timer run): each tab is read once, and
// re-read only after this request writes to it. Every entry point starts with freshReads_(),
// so hand edits in the sheet between requests are always picked up.
let READS_ = {};
function freshReads_() { READS_ = {}; }

// A tab plus where each schema field sits in it, looked up by header name. The header and the
// rows come from a single read.
function table_(name) {
  if (READS_[name]) return READS_[name];
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('No "' + name + '" tab. Run setup() in the script editor.');
  const width = Math.max(sh.getLastColumn(), 1);
  const values = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), width).getDisplayValues();
  const header = values[0].map(trim_);
  const col = {};
  header.forEach(function (h, i) { if (h && !(h in col)) col[h] = i; });
  const missing = SCHEMA[name].filter(function (f) { return !(f in col); });
  if (missing.length) throw new Error('The ' + name + ' tab is missing columns: ' + missing.join(', ') + '. Run migrate().');
  const t = { name: name, sh: sh, col: col, width: width, rows: null };
  t.rows = rowsFrom_(t, values.slice(1));
  READS_[name] = t;
  return t;
}

function readRows_(t) {
  if (!t.rows) {
    const last = t.sh.getLastRow();
    t.rows = last < 2 ? [] : rowsFrom_(t, t.sh.getRange(2, 1, last - 1, t.width).getDisplayValues());
  }
  return t.rows;
}

function rowsFrom_(t, values) {
  return values
    .map(function (cells, i) { return { row: i + 2, cells: cells, rec: decode_(t, cells) }; })
    .filter(function (r) { return r.rec.id; });
}

function findIn_(t, id) {
  if (!id) return null;
  return readRows_(t).filter(function (r) { return r.rec.id === String(id); })[0] || null;
}

function findAnywhere_(id) {
  const names = Object.keys(SCHEMA);
  for (let i = 0; i < names.length; i++) {
    const t = table_(names[i]);
    const found = findIn_(t, id);
    if (found) return Object.assign({ tab: t }, found);
  }
  throw new Error('That bottle no longer exists. Refresh the page.');
}

function decode_(t, cells) {
  const rec = {};
  SCHEMA[t.name].forEach(function (f) { rec[f] = parseCell_(f, cells[t.col[f]]); });
  return rec;
}

// `base` is the row as it was, so columns outside the schema keep their values.
function encode_(t, rec, base) {
  const cells = base ? base.slice() : [];
  while (cells.length < t.width) cells.push('');
  SCHEMA[t.name].forEach(function (f) { cells[t.col[f]] = formatCell_(f, rec[f]); });
  return cells;
}

function parseCell_(field, text) {
  const rule = FIELD_RULES[field] || {};
  const s = text === null || text === undefined ? '' : String(text);
  if (rule.type === 'bool') return /^true$/i.test(s);
  if (s === '') return null;
  if (rule.type === 'int' || rule.type === 'number') {
    const n = Number(s.replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : null;
  }
  return s;
}

function formatCell_(field, value) {
  const rule = FIELD_RULES[field] || {};
  if (rule.type === 'bool') return value ? 'TRUE' : 'FALSE';
  if (isBlank_(value)) return '';
  const s = String(value);
  return /^[=+\-@']/.test(s) ? "'" + s : s;  // a leading ' keeps text from being read as a formula
}

function appendRow_(t, cells) {
  t.sh.getRange(t.sh.getLastRow() + 1, 1, 1, cells.length).setNumberFormat('@').setValues([cells]);
  t.rows = null;
}

// Overwrites an existing row. The row number was read earlier in this request, so first check
// it still holds the same bottle: sorting or inserting rows by hand in the sheet can move it.
function writeRow_(t, row, cells) {
  const at = rowFor_(t, row, cells[t.col.id]);
  t.sh.getRange(at, 1, 1, cells.length).setNumberFormat('@').setValues([cells]);
  t.rows = null;
}

function deleteRow_(t, row, id) {
  t.sh.deleteRow(rowFor_(t, row, id));
  t.rows = null;
}

function rowFor_(t, row, id) {
  if (trim_(t.sh.getRange(row, t.col.id + 1).getDisplayValues()[0][0]) === String(id)) return row;
  t.rows = null;  // the sheet moved under us: look the bottle up again
  const found = readRows_(t).filter(function (r) { return r.rec.id === String(id); })[0];
  if (!found) throw new Error('The sheet changed while saving. Try again.');
  return found.row;
}

/* ---------- Lists and Settings tabs ---------- */

// Reads the Lists and Settings tabs (once per request). Missing tabs, columns or values fall
// back to DEFAULT_LISTS and SETTINGS, so the app works before migrate() creates them.
// `problems` lists settings that were ignored; status() shows them.
function lookups_() {
  if (READS_.lookups) return READS_.lookups;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const read = function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 1) return null;
    const v = sh.getRange(1, 1, sh.getLastRow(), Math.max(sh.getLastColumn(), 1)).getDisplayValues();
    const head = v[0].map(function (h) { return trim_(h).toLowerCase(); });
    return { rows: v.slice(1), at: function (h) { return head.indexOf(h.toLowerCase()); } };
  };

  const lists = { colours: DEFAULT_LISTS.colours, grapes: DEFAULT_LISTS.grapes, storage: DEFAULT_LISTS.storage };
  const l = read(LOOKUP_TABS.lists);
  if (l) {
    const column = function (h) {
      const i = l.at(h);
      return i < 0 ? null : l.rows.map(function (r) { return trim_(r[i]); }).filter(Boolean);
    };
    const c = l.at('colour');
    const tone = l.at('colourTone');
    if (c >= 0) {
      lists.colours = l.rows.filter(function (r) { return trim_(r[c]); }).map(function (r) {
        const t = fold_(tone >= 0 ? r[tone] : '').trim();
        return { name: trim_(r[c]), tone: t === 'white' || t === 'rose' ? t : 'red' };
      });
    }
    if (column('grape')) lists.grapes = column('grape');
    if (column('storage')) lists.storage = column('storage');
  }

  const settings = {};
  const problems = [];
  Object.keys(SETTINGS).forEach(function (k) { settings[k] = SETTINGS[k].value; });
  const s = read(LOOKUP_TABS.settings);
  if (s && s.at('setting') >= 0 && s.at('value') >= 0) {
    s.rows.forEach(function (r) {
      const key = trim_(r[s.at('setting')]);
      const raw = trim_(r[s.at('value')]);
      if (!SETTINGS[key] || raw === '') return;
      const ok = SETTINGS[key].check(raw);
      if (ok === null) problems.push(key + ' "' + raw + '" isn\'t valid, so ' + SETTINGS[key].value + ' is used. ' + SETTINGS[key].about + '.');
      else settings[key] = ok;
    });
  }
  READS_.lookups = { lists: lists, settings: settings, problems: problems };
  return READS_.lookups;
}

/* ============================== Passkey ============================== */

// `device` is a random id the page keeps in the browser, so wrong passkeys from one device
// lock out only that device. A higher limit across all devices is the backstop.
function checkKey_(key, device) {
  const cache = CacheService.getScriptCache();
  const dev = 'failedLogins:' + (/^[A-Za-z0-9_-]{8,64}$/.test(String(device || '')) ? device : 'unknown');
  const fails = Number(cache.get(dev) || 0);
  const allFails = Number(cache.get('failedLogins:all') || 0);
  if (fails >= AUTH.maxFailedLogins || allFails >= AUTH.maxFailedLoginsAll) {
    throw new Error('Too many wrong passkeys. Try again in 10 minutes.');
  }
  const props = PropertiesService.getScriptProperties();
  const salt = props.getProperty('PASS_SALT');
  const hash = props.getProperty('PASS_HASH');
  if (!salt || !hash) throw new Error('No passkey set yet. Run setPassword() in the script editor.');
  const ok = sha256_(salt + String(key)) === hash;
  if (!ok) {
    cache.put(dev, String(fails + 1), AUTH.lockoutSeconds);
    cache.put('failedLogins:all', String(allFails + 1), AUTH.lockoutSeconds);
  }
  return ok;
}

function sha256_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('');
}

/* ============================== Telegram bot (optional) ============================== */
//
// Messages reach the bot in one of two ways:
//   Relay (fast, replies in seconds): Telegram → Cloudflare Worker (relay/worker.mjs) → doPost.
//     Telegram can't call Apps Script directly: Apps Script answers with a 302 redirect, which
//     Telegram treats as a failure, and messages queue up unanswered. The Worker answers Telegram
//     itself and passes each message on. Set up with relaySecret() → installTelegramRelay().
//   Polling (fallback, replies within a minute): a timer runs pollTelegram(). Set up with installTelegram().
// Either way an hourly timer runs sendReminders(), which sends once a day at the reminderHour
// set in the Settings tab (so changing the hour there needs no reinstall).
// Your chat gets everything. Guests (addTelegramGuest) can only look things up, never see hidden
// bottles and get no reminders. Every other chat is ignored. The token, chat ids and relay secret
// live in Script Properties; status() lists everything stored there.

const BOT = { maxButtons: 30 };

// Run once from the editor. Paste your token, run, then put the placeholder back.
function setTelegram() {
  const token = 'paste-your-bot-token-here';
  if (token.indexOf('paste-') === 0) throw new Error('Paste your bot token into setTelegram(), then run it again.');
  if (!/^\d+:[\w-]{30,}$/.test(token)) throw new Error('That doesn\'t look like a bot token. Copy it again from @BotFather.');
  PropertiesService.getScriptProperties().setProperties({ TELEGRAM_TOKEN: token });
  Logger.log('Saved. Send your bot a message in Telegram, then run findTelegramChatId(). Put the placeholder back afterwards.');
}

// Finds your chat from the last message you sent the bot, and saves it as the only chat it answers.
function findTelegramChatId() {
  telegramApi_('deleteWebhook', {});  // getUpdates refuses to work while a webhook is set
  const updates = telegramApi_('getUpdates', {}).result;
  const msgs = updates.filter(function (u) { return u.message && u.message.chat; }).map(function (u) { return u.message; });
  if (!msgs.length) throw new Error('No messages yet. Send your bot "hi" in Telegram, then run this again.');
  const chat = msgs[msgs.length - 1].chat;
  PropertiesService.getScriptProperties().setProperties({ TELEGRAM_CHAT_ID: String(chat.id) });
  telegramSend_('Cellar bot connected 🍷\nRun installTelegram() in Apps Script to turn on commands and reminders.');
  Logger.log('Connected to ' + (chat.first_name || chat.title || 'chat') + ' (' + chat.id + '). Now run installTelegram().');
}

// Turns on commands (checked every minute) and the daily reminders. Safe to run again.
// Messages sent before this are dropped, so you don't get a burst of stale replies.
function installTelegram() {
  telegramConfig_();
  telegramApi_('deleteWebhook', { drop_pending_updates: true });
  setBotCommands_();
  replaceTrigger_('pollTelegram', function (b) { return b.everyMinutes(1); });
  replaceTrigger_('sendReminders', function (b) { return b.everyHours(1); });
  Logger.log('Done. Try /help in Telegram; replies take up to a minute. Reminders go out at ' +
    lookups_().settings.reminderHour + ':00 (Project Settings time zone) when something is due.');
}

// Relay step 1: makes the secret shared by Telegram, the Worker and this script, and shows it.
// Paste it into the Worker as the RELAY_SECRET secret. Running it again shows the same one.
function relaySecret() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('TELEGRAM_RELAY_SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperties({ TELEGRAM_RELAY_SECRET: secret });
  }
  Logger.log('RELAY_SECRET for Cloudflare: ' + secret);
  return secret;
}

// Relay step 2, after the Worker is deployed: paste its URL, run, then put the placeholder back.
function installTelegramRelay() {
  const workerUrl = 'paste-your-worker-url-here';
  if (workerUrl.indexOf('paste-') === 0) throw new Error('Paste your Worker URL into installTelegramRelay(), then run it again.');
  installTelegramRelay_(workerUrl);
}

// Points Telegram at the Worker, stops polling, and keeps the daily reminders.
function installTelegramRelay_(workerUrl) {
  telegramConfig_();
  if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(workerUrl)) throw new Error('The Worker URL should start with https://, like https://cellar-relay.yourname.workers.dev');
  const secret = PropertiesService.getScriptProperties().getProperty('TELEGRAM_RELAY_SECRET');
  if (!secret) throw new Error('Run relaySecret() first and add it to the Worker.');
  telegramApi_('setWebhook', { url: workerUrl, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  setBotCommands_();
  replaceTrigger_('pollTelegram', null);
  replaceTrigger_('sendReminders', function (b) { return b.everyHours(1); });
  PropertiesService.getScriptProperties().deleteProperty('TG_LAST_UPDATE');  // polling's bookmark
  Logger.log('Done. Try /help in Telegram; replies should take a few seconds. If nothing comes back, run installTelegram() to go back to checking every minute.');
}

// Stops commands and reminders. Your settings stay, so installTelegram() turns it back on.
function uninstallTelegram() {
  telegramApi_('deleteWebhook', {});
  replaceTrigger_('pollTelegram', null);
  replaceTrigger_('sendReminders', null);
  Logger.log('Commands and reminders are off.');
}

// Lets someone else use the bot to look things up. They send the bot any message first (it won't
// answer them yet), then you run this. They can't change anything or see hidden bottles.
function addTelegramGuest() {
  const props = PropertiesService.getScriptProperties();
  let who = null;
  try { who = JSON.parse(props.getProperty('TG_LAST_STRANGER') || 'null'); } catch (err) { who = null; }
  if (!who || !who.id) throw new Error('Nobody new has messaged the bot. Ask them to send it "hi", then run this again.');
  const guests = telegramGuests_().filter(function (g) { return g.id !== who.id; });
  guests.push(who);
  props.setProperties({ TELEGRAM_GUESTS: JSON.stringify(guests) });
  props.deleteProperty('TG_LAST_STRANGER');
  setBotCommands_();
  telegramSend_('Welcome to the cellar 🍷 You can look things up here. Try /help.', null, who.id);
  Logger.log('Added ' + who.name + ' (' + who.id + '). Guests now: ' + guests.map(function (g) { return g.name; }).join(', '));
}

// Sends a one-off message to every guest. Type it below, run, then put the placeholder back.
// Simple formatting works: <b>bold</b>, <i>italic</i>. A copy comes to you too, so you can see it went.
function messageGuests() {
  const text = 'type-your-message-here';
  if (text === 'type-your-message-here') throw new Error('Type your message into messageGuests(), then run it again.');
  messageGuests_(text);
}

function messageGuests_(text) {
  const guests = telegramGuests_();
  if (!guests.length) throw new Error('There are no guests yet. Add one with addTelegramGuest().');
  const sent = [];
  guests.forEach(function (g) {
    try {
      telegramSend_(text, null, g.id);
      sent.push(g.name);
    } catch (err) {
      Logger.log('Couldn\'t send to ' + g.name + ': ' + ((err && err.message) || err));
    }
  });
  if (sent.length) telegramSend_('📣 Sent to ' + escH_(sent.join(', ')) + ':\n\n' + text);
  Logger.log('Sent to ' + (sent.length ? sent.join(', ') : 'nobody') + '. Now put the placeholder back.');
  return sent;
}

// Takes every guest off the bot. Your own chat keeps working.
function removeTelegramGuests() {
  const names = telegramGuests_().map(function (g) { return g.name; });
  PropertiesService.getScriptProperties().deleteProperty('TELEGRAM_GUESTS');
  Logger.log(names.length ? 'Removed: ' + names.join(', ') : 'There were no guests.');
}

// [{ id, name }]
function telegramGuests_() {
  try {
    const list = JSON.parse(PropertiesService.getScriptProperties().getProperty('TELEGRAM_GUESTS') || '[]');
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

// Shows what Telegram reports: messages waiting, and the last error if there was one.
function telegramStatus() {
  Logger.log(JSON.stringify(telegramApi_('getWebhookInfo', {}).result, null, 2));
}

/* ============================== status(): everything stored outside this file ============================== */

// Run from the editor after any change. Lists, in one place, the state this script depends on
// that isn't in the code: whether the web app runs this version, stored settings, timers,
// Telegram, the time zone, and any Settings-tab values that were ignored.
function status() {
  freshReads_();
  const out = [];
  const say = function (s) { out.push(s); };

  say('Saved code: build ' + BUILD);
  try {
    const url = ScriptApp.getService().getUrl();
    if (!url) {
      say('Web app: not deployed yet (Deploy → New deployment).');
    } else {
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
      let body = null;
      try { body = JSON.parse(res.getContentText()); } catch (err) { body = null; }
      if (/\/dev$/.test(url) || !body || typeof body !== 'object' || !('ok' in body)) {
        // Not the web app's JSON (a test URL, a sign-in page…): don't guess, say so.
        say('Web app: couldn\'t check (' + url + ' didn\'t answer with the cellar\'s data). Open your /exec URL in a browser: it should show "build":"' + BUILD + '".');
      } else if (body.build === BUILD) {
        say('Web app: running this build. ✓');
      } else {
        say('Web app: running ' + (body.build ? 'build ' + body.build : 'an older version') +
          '. Deploy → Manage deployments → ✏️ → Version: New version → Deploy.');
      }
    }
  } catch (err) {
    say('Web app: couldn\'t check (' + ((err && err.message) || err) + ').');
  }

  say('Time zone: ' + Session.getScriptTimeZone() + ' (today is ' + today_() + '). Reminders and "opened today" use this.');

  const secret = ['PASS_SALT', 'PASS_HASH', 'TELEGRAM_TOKEN', 'TELEGRAM_RELAY_SECRET', 'ANTHROPIC_API_KEY'];
  const props = PropertiesService.getScriptProperties().getProperties();
  say('Stored settings (Project Settings → Script properties):');
  Object.keys(props).sort().forEach(function (k) {
    const v = String(props[k]);
    say('  ' + k + ' = ' + (secret.indexOf(k) >= 0 ? '(set, hidden)' : v.length > 40 ? v.slice(0, 40) + '…' : v));
  });

  const triggers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  say('Timers: ' + (triggers.length ? triggers.join(', ') : 'none'));

  if (props.TELEGRAM_TOKEN) {
    try {
      const info = telegramApi_('getWebhookInfo', {}).result;
      say('Telegram: ' + (info.url ? 'relay at ' + info.url : 'polling every minute') +
        (info.pending_update_count ? ', ' + info.pending_update_count + ' waiting' : '') +
        (info.last_error_message ? ', last error: ' + info.last_error_message : ''));
    } catch (err) {
      say('Telegram: ' + ((err && err.message) || err));
    }
  }

  const look = lookups_();
  say('Settings tab: ' + Object.keys(look.settings).map(function (k) { return k + ' ' + look.settings[k]; }).join(', '));
  look.problems.forEach(function (p) { say('  ⚠ ' + p); });
  say('Lists tab: ' + look.lists.colours.length + ' colours, ' + look.lists.grapes.length + ' grapes, ' +
    look.lists.storage.length + ' storage places.');

  Logger.log(out.join('\n'));
  return out;
}

// The hourly timer calls this. It sends at most once a day, from the reminderHour in Settings.
function sendReminders() {
  return sendReminders_(today_(), Number(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'H')));
}

// The every-minute timer calls this when polling (not the relay) is on. Every update fetched is
// marked as done, including ones the bot ignores (other chats), so Telegram doesn't send them
// again. TG_LAST_UPDATE is polling's bookmark; the relay doesn't use it.
function pollTelegram() {
  freshReads_();
  telegramConfig_();
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty('TG_LAST_UPDATE') || 0);
  const updates = telegramApi_('getUpdates', { offset: last + 1, timeout: 0, allowed_updates: ['message', 'callback_query'] }).result;
  updates.forEach(function (u) {
    try {
      handleTelegram_(u);
    } catch (err) {
      Logger.log('Telegram update ' + u.update_id + ' failed: ' + ((err && err.message) || err));
    }
  });
  const newest = updates.reduce(function (n, u) { return Math.max(n, u.update_id); }, 0);
  withLock_(function () {
    if (newest > Number(props.getProperty('TG_LAST_UPDATE') || 0)) props.setProperties({ TG_LAST_UPDATE: String(newest) });
  });
}

// An update passed on by the Worker. Only accepted with the shared secret.
function relayTelegram_(req) {
  const secret = PropertiesService.getScriptProperties().getProperty('TELEGRAM_RELAY_SECRET');
  if (!secret || req.relayKey !== secret) return false;
  try {
    return handleTelegram_(req.telegram);
  } catch (err) {
    Logger.log('Telegram update failed: ' + ((err && err.message) || err));
    return false;
  }
}

// The commands listed for a guest (look-ups only) or for you (everything).
function menuCommands_(guest) {
  return Object.keys(TG_COMMANDS).filter(function (c) { return TG_COMMANDS[c].menu && !(guest && TG_COMMANDS[c].owner); });
}

// Everyone sees the look-up commands in the menu; your chat also sees the ones that change things.
function setBotCommands_() {
  const menu = function (guest) {
    return menuCommands_(guest).map(function (c) { return { command: c, description: TG_COMMANDS[c].help }; });
  };
  telegramApi_('setMyCommands', { commands: menu(true) });
  const owner = PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_ID');
  if (owner) telegramApi_('setMyCommands', { commands: menu(false), scope: { type: 'chat', chat_id: owner } });
}

/* ---------- Reminders ---------- */

// `hour` comes from the hourly timer: nothing happens before reminderHour, or twice in a day.
// Called without `hour` (from tests or by hand) it always checks.
function sendReminders_(today, hour) {
  freshReads_();
  const props = PropertiesService.getScriptProperties();
  const settings = lookups_().settings;
  if (hour !== undefined) {
    if (hour < settings.reminderHour || props.getProperty('REMINDER_DAY') === today) return 0;
  }
  const sent = readReminderLog_();
  const recs = readRows_(table_('Cellar')).map(function (r) { return r.rec; });
  const due = remindersDue_(recs, today, sent, settings);
  if (due.length) {
    telegramSendLong_(['<b>Cellar reminders</b>'].concat(due.map(function (d) { return d.text; })).join('\n\n'));
    due.forEach(function (d) { sent[d.key] = today; });
  }
  // Forget bottles that are gone, weekly nudges after a week, and anything older than a year.
  const ids = {};
  recs.forEach(function (r) { ids[r.id] = true; });
  const yearAgo = addDays_(today, -400);
  const weekAgo = addDays_(today, -8);
  Object.keys(sent).forEach(function (k) {
    const parts = k.split('|');
    if (!ids[parts[0]] || sent[k] < yearAgo || (parts[1] === 'nudge' && sent[k] < weekAgo)) delete sent[k];
  });
  writeReminderLog_(sent);
  if (hour !== undefined) props.setProperties({ REMINDER_DAY: today });  // only once sending worked
  return due.length;
}

// Reminders already sent, as { key: date }, from the hidden "Reminders log" tab.
function readReminderLog_() {
  const sent = {};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOOKUP_TABS.log);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues().forEach(function (r) {
      if (trim_(r[0])) sent[trim_(r[0])] = trim_(r[1]);
    });
  }
  return sent;
}

function writeReminderLog_(sent) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(LOOKUP_TABS.log);
  if (!sh) sh = ss.insertSheet(LOOKUP_TABS.log).hideSheet();
  writeTab_(sh, [['key', 'sentOn']].concat(Object.keys(sent).sort().map(function (k) { return [k, sent[k]]; })));
}

// Pure: which reminders are due today. `sent` holds the keys already sent, so nothing repeats.
// The year or date is part of each key, so changing a bottle's window or date re-arms it.
function remindersDue_(recs, today, sent, settings) {
  const s = settings || lookups_().settings;
  const year = Number(today.slice(0, 4));
  const tomorrow = addDays_(today, 1);
  const nudgeToday = WEEKDAYS[new Date(today + 'T12:00:00Z').getUTCDay()] === s.nudgeDay;
  // closeReminderMonths 6 → from 1 July of the window's last year; 0 → no closing reminder.
  const closeFrom = s.closeReminderMonths ? '-' + ('0' + (13 - s.closeReminderMonths)).slice(-2) + '-01' : null;
  const out = [];
  const add = function (key, text) { if (!(key in sent)) out.push({ key: key, text: text }); };
  sortCellar_(recs).forEach(function (w) {
    const win = parseWindow_(w.window);
    if (win && year === win.from) {
      add(w.id + '|open|' + win.from, '🍷 <b>Ready to drink</b> from this year\n' + bottleLine_(w));
    }
    if (win && closeFrom && year === win.to && today >= win.to + closeFrom) {
      add(w.id + '|close|' + win.to, '⏳ <b>Drink by December</b>, its window closes this year\n' + bottleLine_(w));
    }
    if (w.status !== 'To collect') return;
    const where = w.storage ? '\n' + escH_(w.storage) : '';
    if (w.collectBy === tomorrow) {
      add(w.id + '|collect|' + w.collectBy + '|before', '📦 <b>Collect tomorrow</b>\n' + bottleLine_(w) + where);
    } else if (w.collectBy === today) {
      add(w.id + '|collect|' + w.collectBy + '|day', '📦 <b>Collect today</b>\n' + bottleLine_(w) + where);
    } else if (nudgeToday && (!w.collectBy || w.collectBy < today)) {
      const late = w.collectBy ? ' (was due ' + niceDate_(w.collectBy) + ')' : '';
      add(w.id + '|nudge|' + today, '📦 <b>Still to collect</b>' + late + '\n' + bottleLine_(w) + where);
    }
  });
  return out;
}

/* ---------- Commands ---------- */

// `menu` commands show in Telegram's command list. `run(q, recs, guest, chatId)` gets the text after
// the command, the cellar bottles the sender may see (guests never see hidden ones), whether the
// sender is a guest, and their chat. It returns the reply, or nothing if it sent its own.
const TG_COMMANDS = {
  cellar: { menu: true, help: 'Everything in the cellar', run: function (q, recs) { return { text: cellarText_(recs) }; } },
  ready: { menu: true, help: 'In its drinking window now', run: function (q, recs) {
    const year = Number(today_().slice(0, 4));
    const ready = recs.filter(function (w) { const win = parseWindow_(w.window); return win && win.from <= year && year <= win.to; });
    return { text: listText_('Ready to drink', ready, 'Nothing is in its drinking window right now.') };
  } },
  closing: { menu: true, help: 'Windows ending this year or next', run: function (q, recs) {
    const year = Number(today_().slice(0, 4));
    const soon = recs.filter(function (w) { const win = parseWindow_(w.window); return win && (win.to === year || win.to === year + 1); })
      .sort(function (a, b) { return parseWindow_(a.window).to - parseWindow_(b.window).to; });
    return { text: listText_('Drink soon', soon, 'No windows end this year or next.', true) };
  } },
  collect: { menu: true, help: 'Bottles to collect', run: function (q, recs) {
    const due = recs.filter(function (w) { return w.status === 'To collect'; });
    if (!due.length) return { text: 'Nothing to collect.' };
    return { text: '<b>To collect</b>\n\n' + due.map(function (w) {
      return bottleLine_(w) + (w.collectBy ? '\nCollect by ' + niceDate_(w.collectBy) : '') +
        (w.storage ? '\n' + escH_(w.storage) : '');
    }).join('\n\n') };
  } },
  search: { menu: true, help: 'Find a bottle, e.g. /search romanee', run: function (q, recs) {
    if (!q) return { text: 'Type what to look for, e.g. /search romanee' };
    return { text: listText_('Matches for “' + escH_(q) + '”', searchRecs_(recs, q), 'Nothing in the cellar matches “' + escH_(q) + '”.') };
  } },
  stats: { menu: true, help: 'Bottle counts and value', run: function (q, recs, guest) {
    const sum = function (status) {
      return recs.reduce(function (n, w) { return n + (w.status === status ? w.bottles || 1 : 0); }, 0);
    };
    const value = recs.reduce(function (n, w) { return n + (w.price || 0) * (w.bottles || 1); }, 0);
    return { text: [
      '<b>' + sum('In cellar') + '</b> in the cellar',
      '<b>' + sum('To collect') + '</b> to collect',
      '<b>' + readRows_(table_('Consumed')).filter(function (r) { return !guest || !r.rec.hidden; }).length + '</b> consumed',
      '<b>' + escH_(lookups_().settings.currency) + money_(value) + '</b> on the shelf',
    ].join('\n') };
  } },
  // `owner` commands change the cellar, so guests can't use them.
  opened: { menu: true, owner: true, help: 'Record a bottle you opened', run: function (q, recs) {
    return pickBottle_('drink', q, recs, 'Which one did you open?');
  } },
  collected: { menu: true, owner: true, help: 'Mark a bottle as collected', run: function (q, recs) {
    return pickBottle_('coll', q, recs.filter(function (w) { return w.status === 'To collect'; }), 'Which one did you collect?');
  } },
  add: { menu: true, owner: true, help: 'Add a wine by name, e.g. /add rousseau gevrey 2019', run: function (q, recs, guest, chatId) {
    if (!q) return { text: 'Type the wine after /add, e.g. /add rousseau gevrey 2019' };
    startDraft_({ typed: q }, chatId, '🔍 Looking up the wine…');
  } },
  add1: { menu: true, owner: true, help: 'Add another bottle of a wine', run: function (q, recs) {
    return pickBottle_('add1', q, recs, 'Which wine did you buy another bottle of?');
  } },
  help: { menu: true, help: 'What I can do', run: function (q, recs, guest) {
    return { text: menuCommands_(guest).map(function (c) { return '/' + c + ' · ' + escH_(TG_COMMANDS[c].help); }).join('\n') +
      '\n\nOr just type a name to search.' +
      (guest ? '' : ' Reminders arrive at ' + lookups_().settings.reminderHour + ':00 when something is due.' +
        '\n📷 Send a photo of a label to add that bottle.') };
  } },
};
TG_COMMANDS.start = { help: '', run: TG_COMMANDS.help.run };

// What tapping a bottle's button does. Each returns the text that replaces the buttons.
const TG_ACTIONS = {
  drink: function (w) {
    const res = withLock_(function () { return drinkWine_(w.id, {}); });
    return '🍷 Opened ' + bottleLine_(w, true) + '\n' + (res.left ? res.left + ' left' : 'That was the last one') + '. Add a rating on the website.';
  },
  coll: function (w) {
    if (w.status !== 'To collect') return bottleLine_(w, true) + ' is already in the cellar.';
    withLock_(function () { return updateWine_(w.id, { status: 'In cellar' }); });
    return '📦 Collected ' + bottleLine_(w, true) + '. It\'s now in the cellar.';
  },
  add1: function (w) {
    const res = withLock_(function () { return adjustBottles_(w.id, 1); });
    return '➕ ' + bottleLine_(w, true) + ' now ×' + res.bottles;
  },
};

// Handles one update, from the relay or from polling. Returns true if it was answered.
function handleTelegram_(update) {
  freshReads_();
  const props = PropertiesService.getScriptProperties();
  if (!update || typeof update.update_id !== 'number') return false;
  const cb = update.callback_query;
  const msg = update.message || (cb && cb.message);
  const ownerId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!msg || !msg.chat || !ownerId) return false;
  const chatId = String(msg.chat.id);
  const guest = chatId !== ownerId;
  if (guest && !telegramGuests_().some(function (g) { return String(g.id) === chatId; })) {
    // Not answered, but remembered, so addTelegramGuest() can let them in.
    if (update.message) {
      const c = msg.chat;
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || c.username || 'someone';
      props.setProperties({ TG_LAST_STRANGER: JSON.stringify({ id: chatId, name: name }) });
    }
    return false;
  }
  return answerTelegram_(update, msg, chatId, guest, props);
}

function answerTelegram_(update, msg, chatId, guest, props) {
  const cb = update.callback_query;

  // Each update is handled once only. Relayed updates can arrive out of order (two quick taps),
  // so this remembers the ids it has seen rather than just the newest.
  const fresh = withLock_(function () {
    let seen = [];
    try { seen = JSON.parse(props.getProperty('TG_SEEN') || '[]'); } catch (err) { seen = []; }
    if (seen.indexOf(update.update_id) >= 0) return false;
    seen.push(update.update_id);
    props.setProperties({ TG_SEEN: JSON.stringify(seen.slice(-200)) });
    return true;
  });
  if (!fresh) return false;

  if (cb) {
    // Acknowledge first: if this fails (e.g. a stale tap), the buttons must still be replaced below,
    // or a second tap could drink another bottle.
    try { telegramApi_('answerCallbackQuery', { callback_query_id: cb.id }); } catch (err) { Logger.log(String(err.message)); }
    const lbl = /^lbl:(\w+):(\w+)$/.exec(cb.data || '');
    if (lbl && DRAFT_ACTIONS[lbl[1]]) {
      labelTap_(lbl[1], lbl[2], msg, chatId, guest);
      return true;
    }
    let text;
    try {
      const m = /^(drink|coll|add1):(\w+)$/.exec(cb.data || '');
      if (guest) throw new Error('Only the owner can change the cellar.');
      if (!m) throw new Error('That button has expired.');
      const found = findIn_(table_('Cellar'), m[2]);
      if (!found) throw new Error('That bottle is no longer in the cellar.');
      text = TG_ACTIONS[m[1]](found.rec);
    } catch (err) {
      text = '⚠️ ' + escH_(botError_(err));
    }
    telegramApi_('editMessageText', { chat_id: chatId, message_id: msg.message_id, text: text, parse_mode: 'HTML' });
    return true;
  }

  // A label photo starts a draft bottle; a reply to a draft changes it.
  if ((msg.photo && msg.photo.length) || (msg.document && /^image\//.test(msg.document.mime_type || ''))) {
    if (guest) telegramSend_('⚠️ Only the owner can change the cellar.', null, chatId);
    else if (!msg.photo) telegramSend_('Send it as a photo rather than a file, and I\'ll read the label.', null, chatId);
    else labelFromPhoto_(msg, chatId);
    return true;
  }
  const draft = !guest && msg.text && msg.reply_to_message ? draftForMessage_(msg.reply_to_message.message_id) : null;
  if (draft) {
    fixFromReply_(draft, String(msg.text).trim(), chatId);
    return true;
  }

  const m = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(String(msg.text || '').trim());
  const name = m ? m[1].toLowerCase() : 'search';
  const arg = m ? m[2].trim() : String(msg.text || '').trim();
  const cmd = TG_COMMANDS[name];
  try {
    if (!cmd) throw new Error('I don\'t know /' + name + '. Try /help.');
    if (guest && cmd.owner) throw new Error('Only the owner can change the cellar.');
    const reply = cmd.run(arg, cellarRecs_(guest), guest, chatId);
    if (reply) telegramSendLong_(reply.text, reply.buttons, chatId);  // /add sends its own messages
  } catch (err) {
    telegramSend_('⚠️ ' + escH_(botError_(err)), null, chatId);
  }
  return true;
}

// Buttons for the bottles matching `q`, so you tap the one you mean.
function pickBottle_(act, q, recs, question) {
  const matches = q ? searchRecs_(recs, q) : sortCellar_(recs);
  if (!matches.length) return { text: q ? 'Nothing matches “' + escH_(q) + '”.' : 'No bottles to choose from.' };
  if (matches.length > BOT.maxButtons) {
    return { text: matches.length + ' bottles match. Add a word or two, e.g. /' + ({ drink: 'opened', coll: 'collected', add1: 'add1' })[act] + ' duroche 2018' };
  }
  return {
    text: question,
    buttons: matches.map(function (w) {
      const label = [w.vintage || 'NV', w.producer, w.wine].join(' ') + ((w.bottles || 1) > 1 ? ' ×' + w.bottles : '');
      return [{ text: label.slice(0, 60), callback_data: act + ':' + w.id }];
    }),
  };
}

function cellarText_(recs) {
  if (!recs.length) return 'The cellar is empty.';
  return ['In cellar', 'To collect'].map(function (status) {
    const list = recs.filter(function (w) { return w.status === status; });
    if (!list.length) return '';
    const n = list.reduce(function (a, w) { return a + (w.bottles || 1); }, 0);
    return '<b>' + (status === 'In cellar' ? 'In the cellar' : 'To collect') + '</b> · ' + n + ' bottle' + (n === 1 ? '' : 's') + '\n' +
      list.map(function (w) { return bottleLine_(w); }).join('\n');
  }).filter(Boolean).join('\n\n');
}

function listText_(title, recs, empty, keepOrder) {
  if (!recs.length) return empty;
  return '<b>' + title + '</b>\n' + (keepOrder ? recs : sortCellar_(recs)).map(function (w) { return bottleLine_(w); }).join('\n');
}

// "<b>2018</b> Duroche · <i>Vosne-Romanée</i> ×2 · drink 2024–2035"
function bottleLine_(w, short) {
  const n = w.bottles || 1;
  return '<b>' + escH_(w.vintage || 'NV') + '</b> ' + escH_(w.producer) + ' · <i>' + escH_(w.wine) + '</i>' +
    (n > 1 && !short ? ' ×' + n : '') + (w.window && !short ? ' · drink ' + escH_(w.window) : '');
}

// Guests never see hidden bottles, in lists, searches or counts.
function cellarRecs_(guest) {
  return sortCellar_(readRows_(table_('Cellar')).map(function (r) { return r.rec; })
    .filter(function (w) { return !guest || !w.hidden; }));
}

// Every word must appear somewhere, ignoring case and accents: "duroche 2018" finds "Duroché … 2018".
function searchRecs_(recs, q) {
  const words = fold_(q).split(/\s+/).filter(Boolean);
  return sortCellar_(recs.filter(function (w) {
    const hay = fold_([w.producer, w.wine, w.grape, w.vintage, w.colour, w.notes].join(' '));
    return words.every(function (word) { return hay.indexOf(word) >= 0; });
  }));
}

// Same order as the website: by colour (in the Lists tab's order), then producer, then vintage.
function sortCellar_(recs) {
  const order = {};
  lookups_().lists.colours.forEach(function (c, i) { order[c.name] = i; });
  const rank = function (w) { return w.colour in order ? order[w.colour] : 99; };
  return recs.slice().sort(function (a, b) {
    return rank(a) - rank(b) || String(a.producer).localeCompare(String(b.producer)) || (a.vintage || 0) - (b.vintage || 0);
  });
}

/* ---------- Label photos: add a bottle from a photo of its label ---------- */
//
// Send the bot a photo of a label, or type /add and the wine's name (spelling mistakes are fine).
// Claude Haiku works out producer, wine, cuvée, vintage, colour and grape, asks for the drinking
// window, and the bot shows a draft with ✅ Add, ✏️ Fix, 🔁 Retry with Sonnet and ❌ Cancel. Nothing
// is added until you tap Add. Retry reads the label again with Sonnet, the stronger and costlier
// model, for labels Haiku gets wrong. You give the drinking window yourself by replying to the
// draft with it ("2028-2040"); that needs no Claude call. Any other reply ("vintage 2019") is a
// fix, which one short Haiku call applies. Cost: about US$0.0005 a label, about US$0.01 a Retry.
// Set up with setLabelReader(). Drafts are kept in the TG_DRAFTS Script Property (newest 10).

const LABEL = {
  reader: 'claude-haiku-5-5', retry: 'claude-sonnet-5-5', fixer: 'claude-haiku-5-5',
  apiVersion: '2026-10-21', maxDrafts: 10,
};
const DRAFT_FIELDS = ['producer', 'wine', 'cuvee', 'vintage', 'colour', 'grape'];

// Run once from the editor. Paste your key, run, then put the placeholder back.
// (Or add ANTHROPIC_API_KEY yourself under Project Settings → Script properties.)
function setLabelReader() {
  const anthropicKey = 'paste-your-anthropic-key-here';
  if (anthropicKey.indexOf('paste-') === 0) throw new Error('Paste your Anthropic API key into setLabelReader(), then run it again.');
  if (!/^sk-ant-[\w-]{20,}$/.test(anthropicKey)) throw new Error('That doesn\'t look like an Anthropic API key. It starts with sk-ant-.');
  PropertiesService.getScriptProperties().setProperties({ ANTHROPIC_API_KEY: anthropicKey });
  Logger.log('Saved. Send your bot a photo of a label. Put the placeholder back afterwards.');
}

function labelFromPhoto_(msg, chatId) {
  startDraft_({ fileId: pickPhoto_(msg.photo).file_id, hint: trim_(msg.caption || '') }, chatId, '🔍 Reading the label…');
}

// A new draft from a photo (`fileId`) or typed text (`typed`): read it, show it, then ask for
// the drinking window.
function startDraft_(d, chatId, status) {
  if (!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY')) {
    telegramSend_('⚠️ I can\'t look up wines yet. Run setLabelReader() in Apps Script first.', null, chatId);
    return;
  }
  Object.assign(d, { id: newId_().slice(0, 8), chatId: chatId, window: '' });
  d.msgId = messageId_(telegramSend_(status, null, chatId));
  try {
    readDraft_(d, LABEL.reader);
  } catch (err) {
    d.problem = botError_(err);
  }
  showDraft_(d);
  if (!d.problem) askDraft_(d, '🍷 What\'s the drinking window? e.g. <i>2028-2040</i>. Or tap ✅ Add on the draft to skip it.', 'e.g. 2028-2040');
}

// Asks a question about the draft with Telegram's reply box open; the reply goes to fixFromReply_.
function askDraft_(d, text, placeholder) {
  d.askId = messageId_(telegramApi_('sendMessage', { chat_id: d.chatId, parse_mode: 'HTML', text: text,
    reply_markup: { force_reply: true, input_field_placeholder: placeholder } }));
  saveDraft_(d);
}

// Telegram sends each photo in several sizes, smallest first. About 1600px is plenty for a label,
// and bigger ones cost more to read.
function pickPhoto_(sizes) {
  const fit = sizes.filter(function (s) { return Math.max(s.width || 0, s.height || 0) <= 1600; });
  return fit.length ? fit[fit.length - 1] : sizes[0];
}

// Reads the draft's photo or typed text (again) with `model`. A window you've already typed is kept.
// Throws if Telegram or Claude can't be reached.
function readDraft_(d, model) {
  d.readBy = model;
  Object.assign(d, identifyWine_(d.typed ? { typed: d.typed } : { photo: downloadPhoto_(d.fileId), hint: d.hint }, model));
}

// The one place a wine is identified, for the bot and the website alike. `src` is { typed } or
// { photo: { media_type, data }, hint }. Returns the DRAFT_FIELDS plus `problem`: what went wrong,
// or '' when the wine was identified.
function identifyWine_(src, model) {
  const content = src.typed ? [{ type: 'text', text: 'The owner typed: "' + src.typed + '"' }] : [
    { type: 'image', source: { type: 'base64', media_type: src.photo.media_type, data: src.photo.data } },
    { type: 'text', text: src.hint ? 'A note from the owner about this bottle: ' + src.hint : 'Read this label.' },
  ];
  const got = readWine_(content, model);
  const out = {};
  DRAFT_FIELDS.forEach(function (k) { out[k] = trim_(got[k] || ''); });
  out.problem = got.readable && out.producer ? ''
    : src.typed ? 'I couldn\'t tell which wine that is.' : 'I couldn\'t read a wine label in that photo.';
  return out;
}

// The website's ✨ panel: `input` is { text, photo: { media_type, data }, strong }. The owner's
// passkey was already checked (ROUTES.identify). Nothing from the browser is trusted, so the
// photo's type, encoding and size and the text's length are checked here. Returns the fields to
// fill in the Add form; nothing is saved.
const PAGE_PHOTO = { types: ['image/jpeg', 'image/png', 'image/webp'], maxChars: 2000000 };  // ~1.5 MB
function identifyFromPage_(input) {
  const i = input || {};
  const text = trim_(i.text || '').slice(0, 200);
  const p = i.photo;
  if (p && (PAGE_PHOTO.types.indexOf(p.media_type) < 0 || typeof p.data !== 'string' ||
    p.data.length > PAGE_PHOTO.maxChars || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.data))) {
    throw new Error('That photo couldn\'t be used. Try a JPEG or PNG under about 1.5 MB.');
  }
  if (!p && !text) throw new Error('Type the wine or add a photo first.');
  const got = identifyWine_(p ? { photo: { media_type: p.media_type, data: p.data }, hint: text } : { typed: text },
    i.strong ? LABEL.retry : LABEL.reader);
  if (got.problem) throw new Error(got.problem + ' Try again, or fill it in yourself.');
  return { producer: got.producer, wine: wineField_(got), vintage: got.vintage, colour: got.colour, grape: got.grape };
}

function downloadPhoto_(fileId) {
  const file = telegramApi_('getFile', { file_id: fileId }).result;
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  const res = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + token + '/' + file.file_path, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Couldn\'t download the photo from Telegram. Try 🔁 Retry.');
  return { media_type: /\.png$/i.test(file.file_path) ? 'image/png' : 'image/jpeg', data: Utilities.base64Encode(res.getContent()) };
}

// Works out the wine from a label photo, or from the owner's rough typing of its name.
function readWine_(content, model) {
  return claude_({
    model: model,
    system: 'You identify one wine for a cellar list, from a photo of its label or from a name the owner typed. ' +
      'From a photo, copy names as printed, with their accents. Typed names may be misspelled or shortened: give ' +
      'the real, correctly spelled names, e.g. "rouseau" is "Domaine Armand Rousseau". producer: the domaine, château or ' +
      'house. wine: the appellation or wine name with its classification, e.g. "Vosne-Romanée 1er Cru". cuvee: ' +
      'the vineyard or cuvée name if there is one, else "". vintage: the four-digit year, or "" if non-vintage or ' +
      'not given. colour: from the label or what you know of the wine, or "" if unsure. grape: the main grape or ' +
      'grapes, spelt like this where they fit: ' + lookups_().lists.grapes.join(', ') + '. Leave a field "" ' +
      'rather than guess. readable: false if you can\'t tell which wine it is.',
    messages: [{ role: 'user', content: content }],
    schema: labelSchema_(false),
  });
}

// The colours come from the Lists tab, like everywhere else.
function labelSchema_(withWindow) {
  const str = { type: 'string' };
  const colours = lookups_().lists.colours.map(function (c) { return c.name; }).concat(['']);
  const props = { readable: { type: 'boolean' }, producer: str, wine: str, cuvee: str, vintage: str,
    colour: { type: 'string', enum: colours }, grape: str };
  if (withWindow) props.window = str;
  return { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props };
}

// "2026-2035" → "2026–2035", the way the sheet writes it. Anything else is dropped.
function cleanWindow_(text) {
  const win = parseWindow_(text);
  return win && win.from >= 1900 ? win.from + '–' + win.to : '';
}

// A reply that is just a window ("2028-2040", "drink 2028 to 2040"): two years and nothing
// else with digits in it, so "vintage 2019, drink 2028-2040" still goes to Claude as a fix.
function windowReply_(text) {
  return /^\D*\d{4}\D+\d{4}\D*$/.test(text) ? cleanWindow_(text) : '';
}

// The row ✏️ Fix sends: one "field: value" line per field, mapped to where the draft keeps it.
const ROW_FIELDS = { producer: 'producer', wine: 'wine', cuvee: 'cuvee', vintage: 'vintage', colour: 'colour',
  grape: 'grape', window: 'window', notes: 'hint' };

function draftRow_(d) {
  return Object.keys(ROW_FIELDS).map(function (k) { return k + ': ' + (d[ROW_FIELDS[k]] || ''); }).join('\n');
}

// A reply in that form, as { field: value }, or null if it isn't one. Fields left out stay as
// they are, so "vintage: 2019" alone works too. A blank value clears the field.
function rowReply_(text) {
  const lines = String(text).split('\n').filter(function (l) { return trim_(l); });
  const parsed = lines.map(function (l) { return /^\s*([^:]+?)\s*:\s*(.*)$/.exec(l); });
  const field = function (m) { const k = m ? fold_(m[1]) : ''; return { color: 'colour', note: 'notes' }[k] || k; };
  if (!parsed.some(function (m) { return ROW_FIELDS[field(m)]; })) return null;
  const row = {};
  parsed.forEach(function (m, i) {
    const key = field(m);
    if (!ROW_FIELDS[key]) throw new Error('"' + trim_(lines[i]) + '" isn\'t a field. Each line should be one of: ' + Object.keys(ROW_FIELDS).join(', ') + '.');
    row[key] = trim_(m[2]);
  });
  if (row.window && !cleanWindow_(row.window)) throw new Error('The window should look like 2028-2040.');
  if (row.vintage && !/^\d{4}$/.test(row.vintage)) throw new Error('The vintage should be a year like 2019, or blank for NV.');
  return row;
}

// The sheet has no cuvée column, so it goes after the wine's name.
function wineField_(d) {
  return d.wine && d.cuvee ? d.wine + ' · ' + d.cuvee : d.wine || d.cuvee;
}

// One Claude request with `req.model`, whose answer must match `req.schema`. Returns the parsed answer.
function claude_(req) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('I can\'t look up wines yet. Run setLabelReader() in Apps Script first.');
  // A daily cap on calls from the bot and the website together (Settings: aiDailyLimit).
  let used = {};
  try { used = JSON.parse(props.getProperty('AI_USES') || '{}'); } catch (err) { used = {}; }
  const today = today_();
  const n = used.day === today ? used.n : 0;
  const limit = lookups_().settings.aiDailyLimit;
  if (n >= limit) throw new Error('That\'s the ' + limit + ' AI look-ups allowed today. It resets tomorrow (Settings: aiDailyLimit).');
  props.setProperties({ AI_USES: JSON.stringify({ day: today, n: n + 1 }) });
  const body = {
    model: req.model, max_tokens: 4000, system: req.system, messages: req.messages,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: req.schema } },
  };
  const headers = { 'x-api-key': key, 'anthropic-version': LABEL.apiVersion };
  if (!/haiku/.test(req.model)) {  // Haiku has no refusal fallback; for Sonnet, another model answers if it declines
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: headers, payload: JSON.stringify(body),
  });
  const code = res.getResponseCode();
  let out = null;
  try { out = JSON.parse(res.getContentText()); } catch (err) { out = null; }
  if (code !== 200 || !out || !out.content) {
    const why = out && out.error && out.error.message ? out.error.message : 'HTTP ' + code;
    Logger.log('Claude error: ' + why);
    if (code === 401) throw new Error('Claude didn\'t accept the API key. Run setLabelReader() again.');
    if (/credit balance/i.test(why)) throw new Error('Your Anthropic credit has run out. Top up at console.anthropic.com.');
    throw new Error('Claude didn\'t answer (' + why + ').');
  }
  if (out.usage) Logger.log('Claude usage (' + req.model + '): ' + JSON.stringify(out.usage));
  if (out.stop_reason === 'refusal') throw new Error('Claude declined to read that one.');
  if (out.stop_reason === 'max_tokens') throw new Error('Claude\'s answer was cut short.');
  const texts = out.content.filter(function (b) { return b.type === 'text'; });
  try {
    return JSON.parse(texts[texts.length - 1].text);
  } catch (err) {
    throw new Error('Claude\'s answer didn\'t make sense.');
  }
}

/* Drafts waiting for a tap */

function drafts_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('TG_DRAFTS') || '{}'); } catch (err) { return {}; }
}

// Changes the stored drafts under the lock, keeping the newest LABEL.maxDrafts.
function editDrafts_(change) {
  withLock_(function () {
    const all = drafts_();
    change(all);
    const keep = {};
    Object.keys(all).sort(function (a, b) { return String(all[b].saved).localeCompare(String(all[a].saved)); })
      .slice(0, LABEL.maxDrafts).forEach(function (k) { keep[k] = all[k]; });
    PropertiesService.getScriptProperties().setProperties({ TG_DRAFTS: JSON.stringify(keep) });
  });
}

function saveDraft_(d) {
  d.saved = timestamp_();
  editDrafts_(function (all) { all[d.id] = d; });
}

function dropDraft_(id) { editDrafts_(function (all) { delete all[id]; }); }

// The draft a message belongs to: the draft itself, or the bot's "What should change?" question.
function draftForMessage_(messageId) {
  const all = drafts_();
  return Object.keys(all).map(function (k) { return all[k]; })
    .filter(function (d) { return d.msgId === messageId || d.askId === messageId; })[0] || null;
}

function messageId_(res) { return res && res.result && res.result.message_id ? res.result.message_id : null; }

// Shows the draft in its own message (editing it in place), or as a new message when `fresh`.
function showDraft_(d, fresh) {
  const view = draftView_(d);
  let edited = false;
  if (d.msgId && !fresh) {
    try {
      telegramApi_('editMessageText', { chat_id: d.chatId, message_id: d.msgId, text: view.text, parse_mode: 'HTML',
        disable_web_page_preview: true, reply_markup: { inline_keyboard: view.buttons } });
      edited = true;
    } catch (err) {
      Logger.log(botError_(err));
    }
  }
  if (!edited) d.msgId = messageId_(telegramSend_(view.text, view.buttons, d.chatId));
  saveDraft_(d);
}

function draftView_(d) {
  const btn = function (act, text) { return { text: text, callback_data: 'lbl:' + act + ':' + d.id }; };
  const retry = btn('retry', d.readBy === LABEL.retry ? '🔁 Retry' : '🔁 Retry with Sonnet');
  if (d.problem) {
    return { text: '⚠️ ' + escH_(d.problem) + '\nTry 🔁 Retry, or ' + (d.typed ? 'type it differently.' : 'send a clearer photo.'),
      buttons: [[retry, btn('no', '❌ Cancel')]] };
  }
  const lines = ['🍷 <b>' + escH_(d.vintage || 'NV') + '</b> ' + escH_(d.producer) + ' · <i>' + escH_(wineField_(d)) + '</i>'];
  const kind = [d.colour, d.grape].filter(Boolean).join(' · ');
  if (kind) lines.push(escH_(kind));
  lines.push(d.window ? 'Drink ' + escH_(d.window) : 'No drinking window yet.');
  if (d.hint) lines.push('Note: ' + escH_(d.hint));
  lines.push('', d.window ? 'Tap ✅ to add it, or ✏️ to change something.'
    : 'Reply to this message with the drinking window (e.g. <i>2028-2040</i>), or tap ✅ to add it without one.');
  const buttons = [[btn('ok', '✅ Add'), btn('fix', '✏️ Fix')], [retry, btn('no', '❌ Cancel')]];
  return { text: lines.join('\n'), buttons: buttons };
}

function draftWine_(d) {
  return { producer: d.producer, wine: wineField_(d), vintage: d.vintage, colour: d.colour, grape: d.grape,
    window: d.window, notes: d.hint };
}

// What tapping a draft's button does. Each gets the draft and `edit(text, buttons)`, which
// replaces the draft message.
const DRAFT_ACTIONS = {
  ok: function (d, edit) {
    const res = withLock_(function () { return createWine_(draftWine_(d)); });
    dropDraft_(d.id);
    const line = bottleLine_({ vintage: d.vintage, producer: d.producer, wine: wineField_(d) }, true);
    edit(res.merged ? '➕ ' + line + ' now ×' + res.bottles : '✅ Added ' + line + ' to the cellar.');
  },
  no: function (d, edit) {
    dropDraft_(d.id);
    edit('Cancelled. Nothing was added.');
  },
  fix: function (d) {
    askDraft_(d, 'Tap the row to copy it, change what\'s wrong, and send it back as a reply:\n\n<pre>' + escH_(draftRow_(d)) + '</pre>',
      'Paste the row and edit it');
  },
  retry: function (d, edit) {
    edit('🔍 Reading the label again with Sonnet…');
    readDraft_(d, LABEL.retry);
    showDraft_(d);
  },
};

// A tap on a draft's button. `msg` is the draft message, which each answer replaces.
function labelTap_(act, id, msg, chatId, guest) {
  const edit = function (text, buttons) {
    const p = { chat_id: chatId, message_id: msg.message_id, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (buttons) p.reply_markup = { inline_keyboard: buttons };
    telegramApi_('editMessageText', p);
  };
  const d = guest ? null : drafts_()[id];
  try {
    if (guest) throw new Error('Only the owner can change the cellar.');
    if (!d) throw new Error('That draft has expired. Send the photo again.');
    d.chatId = chatId;
    d.msgId = msg.message_id;
    DRAFT_ACTIONS[act](d, edit);
  } catch (err) {
    const view = d ? draftView_(d) : null;
    edit('⚠️ ' + escH_(botError_(err)) + (view ? '\n\n' + view.text : ''), view ? view.buttons : null);
  }
}

// A reply to a draft. The edited row from ✏️ Fix, or just a window ("2028-2040"), is applied
// straight away, with no Claude call. Anything else ("vintage 2019") is a fix that Claude applies.
// The new draft goes to the bottom of the chat.
function fixFromReply_(d, text, chatId) {
  d.chatId = chatId;
  try {
    if (!text) throw new Error('Type what to change, e.g. 2028-2040 or vintage 2019.');
    const row = rowReply_(text);
    const win = row ? '' : windowReply_(text);
    if (row) {
      Object.keys(row).forEach(function (k) { d[ROW_FIELDS[k]] = k === 'window' ? cleanWindow_(row[k]) : row[k]; });
      d.problem = '';
    } else if (win) {
      d.window = win;
    } else {
      const cur = { readable: true, window: d.window || '' };
      DRAFT_FIELDS.forEach(function (k) { cur[k] = d[k] || ''; });
      const got = claude_({
        model: LABEL.fixer,
        system: 'You correct a draft entry for a wine cellar list. Apply only the change the owner asks for, and ' +
          'keep every other field exactly as it is. window is "YYYY-YYYY" or "". Spell grapes like this where ' +
          'they fit: ' + lookups_().lists.grapes.join(', ') + '.',
        messages: [{ role: 'user', content: 'Draft:\n' + JSON.stringify(cur) + '\n\nChange: ' + text }],
        schema: labelSchema_(true),
      });
      DRAFT_FIELDS.forEach(function (k) { d[k] = trim_(got[k] || ''); });
      d.window = cleanWindow_(got.window);
      d.problem = '';
    }
  } catch (err) {
    telegramSend_('⚠️ ' + escH_(botError_(err)), null, chatId);
    return;
  }
  if (d.msgId) {
    try {
      telegramApi_('editMessageText', { chat_id: chatId, message_id: d.msgId, text: '✏️ Changed, see below.' });
    } catch (err) {
      Logger.log(botError_(err));
    }
  }
  showDraft_(d, true);
}

/* ---------- Talking to Telegram ---------- */

function telegramConfig_() {
  const p = PropertiesService.getScriptProperties();
  const cfg = { token: p.getProperty('TELEGRAM_TOKEN'), chatId: p.getProperty('TELEGRAM_CHAT_ID') };
  if (!cfg.token) throw new Error('Run setTelegram() first.');
  if (!cfg.chatId) throw new Error('Send your bot a message in Telegram, then run findTelegramChatId().');
  return cfg;
}

function telegramApi_(method, payload) {
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  if (!token) throw new Error('No Telegram bot token yet. Run setTelegram() first.');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload || {}), muteHttpExceptions: true,
  });
  let body = null;
  try { body = JSON.parse(res.getContentText()); } catch (err) { body = null; }
  if (!body || !body.ok) {
    throw new Error('Telegram ' + method + ' failed: ' + ((body && body.description) || 'HTTP ' + res.getResponseCode()));
  }
  return body;
}

// Sends to `chatId`, or to your chat when it's left out (reminders, set-up messages).
function telegramSend_(text, buttons, toChat) {
  const chatId = toChat || PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_ID');
  if (!chatId) throw new Error('No Telegram chat yet. Run findTelegramChatId().');
  const payload = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };
  return telegramApi_('sendMessage', payload);
}

// Telegram caps a message at 4096 characters, so long lists go out in parts, split between lines.
function telegramSendLong_(text, buttons, toChat) {
  const parts = [];
  let cur = '';
  String(text).split('\n').forEach(function (line) {
    if (cur && cur.length + line.length + 1 > 3800) { parts.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + line : line;
  });
  parts.push(cur);
  parts.forEach(function (p, i) { telegramSend_(p, i === parts.length - 1 ? buttons : null, toChat); });
}

// Replaces any timer for `fn`; `schedule` sets the new one up, or null just removes it.
function replaceTrigger_(fn, schedule) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t); });
  if (schedule) schedule(ScriptApp.newTrigger(fn).timeBased()).create();
}

function botError_(err) {
  return String((err && err.message) || err).replace(/ Refresh the page\.$/, '');
}

/* ============================== Small helpers ============================== */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  // Anything read before the lock may be out of date by now (another request may have written
  // while this one waited), so locked work always starts from a fresh read of the sheet.
  freshReads_();
  try {
    const result = fn();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function isBlank_(v) { return v === null || v === undefined || String(v).trim() === ''; }
function trim_(s) { return String(s).trim(); }
function newId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function timestamp_() { return new Date().toISOString(); }
function today_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

// '2026-11-23' + 1 → '2026-11-24'. Works on the date alone, so time zones don't matter.
function addDays_(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// '2026-11-27' → '27 Nov 2026'
function niceDate_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) return String(iso);
  return Number(m[3]) + ' ' + 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[Number(m[2]) - 1] + ' ' + m[1];
}

// Same rule as parseWindow in js/format.js: "2024–2030" → { from: 2024, to: 2030 }, anything else → null.
function parseWindow_(text) {
  const m = /(\d{4})\D+(\d{4})/.exec(String(text || ''));
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  return from <= to ? { from: from, to: to } : null;
}

// Same as fold in js/format.js: lower case without accents.
function fold_(s) { return String(s === null || s === undefined ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function escH_(s) { return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function money_(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
