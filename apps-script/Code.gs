/**
 * Cellar API: the Google Apps Script backend for the cellar page.
 *
 * Data lives in two tabs of the spreadsheet this script is bound to:
 *   Cellar  bottles you own. One row per wine + vintage, with a bottle count and a status.
 *   Drunk   one row per bottle you've finished.
 * Drinking a bottle moves it from Cellar to Drunk. When the last bottle of a wine is drunk,
 * its Cellar row is deleted.
 *
 * Columns are matched by header name, so you can reorder them or add your own columns in the
 * sheet; the app leaves columns it doesn't know about alone.
 *
 * First run:  setPassword() → setup() → Deploy as web app.   (See README.md.)
 * New field:  add it to SCHEMA (and FIELD_RULES if it isn't free text), then run migrate().
 * Tests:      `node --test` in the repo runs this file against an in-memory sheet.
 *
 * Written for the Apps Script V8 runtime. Avoids ?. and ?? to stay on safe syntax.
 */

const API_VERSION = 1;

const SCHEMA = {
  Cellar: ['id', 'producer', 'wine', 'vintage', 'colour', 'grape', 'window', 'bottles', 'status',
    'storage', 'price', 'purchased', 'notes', 'hidden', 'created', 'updated'],
  Drunk: ['id', 'producer', 'wine', 'vintage', 'colour', 'grape', 'price', 'purchased',
    'drunkOn', 'rating', 'notes', 'hidden', 'created', 'updated'],
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
  drunkOn: { type: 'date', label: 'Drunk on' },
  status: { type: 'enum', values: ['In cellar', 'To collect'], label: 'Status' },
  hidden: { type: 'bool' },
};

const SYSTEM_FIELDS = ['id', 'created', 'updated'];
const AUTH = { maxFailedLogins: 8, lockoutSeconds: 600 };

// Every action the page can call. `auth` needs the passkey; `write` runs under a lock.
const ROUTES = {
  list: { auth: false, run: function () { return null; } },
  login: { auth: true, run: function () { return null; } },
  create: { auth: true, write: true, run: function (req) { return createWine_(req.wine); } },
  update: { auth: true, write: true, run: function (req) { return updateWine_(req.id, req.wine); } },
  remove: { auth: true, write: true, run: function (req) { return removeWine_(req.id); } },
  adjust: { auth: true, write: true, run: function (req) { return adjustBottles_(req.id, req.delta); } },
  drink: { auth: true, write: true, run: function (req) { return drinkWine_(req.id, req.drink); } },
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

// Creates the tabs and adds your current bottles. Refuses to run twice.
function setup() {
  migrate();
  const cellar = table_('Cellar');
  const drunk = table_('Drunk');
  if (readRows_(cellar).length || readRows_(drunk).length) {
    throw new Error('Your tabs already have bottles, so setup() did nothing. migrate() is safe to run any time.');
  }
  const now = timestamp_();
  const base = function () { return { id: newId_(), hidden: false, created: now, updated: now }; };
  SEED.cellar.forEach(function (w) { appendRow_(cellar, encode_(cellar, Object.assign(base(), w))); });
  SEED.drunk.forEach(function (w) { appendRow_(drunk, encode_(drunk, Object.assign(base(), w))); });
  Logger.log('Added ' + SEED.cellar.length + ' cellar rows and ' + SEED.drunk.length + ' drunk rows.');
}

// Adds any SCHEMA columns a tab is missing (at the end). Never deletes or moves anything.
function migrate() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
}

/* ============================== Web app entry points ============================== */

// Opening the web app URL in a browser shows the public list. Handy for checking a deployment.
function doGet() {
  return json_(handle_({ action: 'list' }));
}

// The page POSTs plain-text JSON ({ action, key?, ... }) so the browser skips the CORS preflight.
function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, apiVersion: API_VERSION, error: 'Bad request: the body must be JSON.' });
  }
  return json_(handle_(req));
}

// Pure request → response. Kept apart from doPost so the tests can call it directly.
function handle_(req) {
  try {
    req = req || {};
    const route = ROUTES[req.action];
    if (!route) throw new Error('Unknown action "' + req.action + '".');
    const owner = req.key ? checkKey_(req.key) : false;
    if (req.key && !owner) return { ok: false, apiVersion: API_VERSION, auth: false, error: 'Wrong passkey.' };
    if (route.auth && !owner) return { ok: false, apiVersion: API_VERSION, auth: false, error: 'Log in to make changes.' };
    const result = route.write ? withLock_(function () { return route.run(req); }) : route.run(req);
    const snap = snapshot_(owner);
    return { ok: true, apiVersion: API_VERSION, owner: owner, result: result, cellar: snap.cellar, drunk: snap.drunk };
  } catch (err) {
    return { ok: false, apiVersion: API_VERSION, error: String((err && err.message) || err) };
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
  found.tab.sh.deleteRow(found.row);
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
  if (next < 1) throw new Error('That would leave no bottles. Use "Drank one" or Delete instead.');
  writeRow_(t, found.row, encode_(t, Object.assign({}, found.rec, { bottles: next, updated: timestamp_() }), found.cells));
  return { id: found.rec.id, bottles: next };
}

// Moves `count` bottles (default 1) from Cellar to Drunk, one Drunk row per bottle.
// Drunk rows are written first, so a failure part-way can never lose a bottle.
function drinkWine_(id, input) {
  const d = input || {};
  const cellar = table_('Cellar');
  const found = findIn_(cellar, id);
  if (!found) throw new Error('That bottle is no longer in the cellar. Refresh the page.');

  const count = isBlank_(d.count) ? 1 : cleanValue_('bottles', d.count);
  const have = found.rec.bottles || 1;
  if (count > have) throw new Error(have === 1 ? 'There is only 1 bottle of this wine.' : 'There are only ' + have + ' bottles of this wine.');

  const details = clean_('Drunk', { drunkOn: d.drunkOn, rating: d.rating, notes: d.notes }, true);
  const drunk = table_('Drunk');
  const now = timestamp_();
  const ids = [];
  for (let i = 0; i < count; i++) {
    const rec = {};
    SCHEMA.Drunk.forEach(function (f) { if (f in found.rec) rec[f] = found.rec[f]; });
    Object.assign(rec, {
      id: newId_(),
      drunkOn: details.drunkOn || today_(),
      rating: 'rating' in d ? details.rating : null,
      notes: 'notes' in d ? details.notes : found.rec.notes,
      created: now,
      updated: now,
    });
    appendRow_(drunk, encode_(drunk, rec));
    ids.push(rec.id);
  }

  const left = have - count;
  if (left > 0) {
    writeRow_(cellar, found.row, encode_(cellar, Object.assign({}, found.rec, { bottles: left, updated: now }), found.cells));
  } else {
    cellar.sh.deleteRow(found.row);
  }
  return { drunkIds: ids, left: left };
}

function snapshot_(owner) {
  const visible = function (rec) { return owner || !rec.hidden; };
  const recs = function (name) { return readRows_(table_(name)).map(function (r) { return r.rec; }).filter(visible); };
  return { cellar: recs('Cellar'), drunk: recs('Drunk') };
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
    const n = Number(s.replace(/[,\s]/g, '').replace(/^S?\$/i, ''));
    const whole = rule.type === 'int';
    if (!isFinite(n) || (whole && !Number.isInteger(n)) || n < rule.min || n > rule.max) {
      throw new Error(rule.label + ' must be ' + (whole ? 'a whole number' : 'a number') + ' from ' + rule.min + ' to ' + rule.max + '.');
    }
    return n;
  }
  if (rule.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(rule.label + ' must be a date like 2026-11-27.');
  if (rule.type === 'enum' && rule.values.indexOf(s) < 0) throw new Error(rule.label + ' must be one of: ' + rule.values.join(', ') + '.');
  return s.slice(0, 1000);
}

// "Jadot | Gevrey-Chambertin | 2018" and "jadot | gevrey chambertin | 2018" are the same wine.
function wineKey_(w) {
  const norm = function (s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  };
  return [norm(w.producer), norm(w.wine), w.vintage || 'nv'].join('|');
}

/* ============================== Sheet access ============================== */

// A tab plus where each schema field sits in it, looked up by header name.
function table_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('No "' + name + '" tab. Run setup() in the script editor.');
  const width = Math.max(sh.getLastColumn(), 1);
  const header = sh.getRange(1, 1, 1, width).getDisplayValues()[0].map(trim_);
  const col = {};
  header.forEach(function (h, i) { if (h && !(h in col)) col[h] = i; });
  const missing = SCHEMA[name].filter(function (f) { return !(f in col); });
  if (missing.length) throw new Error('The ' + name + ' tab is missing columns: ' + missing.join(', ') + '. Run migrate().');
  return { name: name, sh: sh, col: col, width: width };
}

function readRows_(t) {
  const last = t.sh.getLastRow();
  if (last < 2) return [];
  return t.sh.getRange(2, 1, last - 1, t.width).getDisplayValues()
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
  writeRow_(t, t.sh.getLastRow() + 1, cells);
}

function writeRow_(t, row, cells) {
  t.sh.getRange(row, 1, 1, cells.length).setNumberFormat('@').setValues([cells]);
}

/* ============================== Passkey ============================== */

function checkKey_(key) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('failedLogins') || 0);
  if (fails >= AUTH.maxFailedLogins) throw new Error('Too many wrong passkeys. Try again in 10 minutes.');
  const props = PropertiesService.getScriptProperties();
  const salt = props.getProperty('PASS_SALT');
  const hash = props.getProperty('PASS_HASH');
  if (!salt || !hash) throw new Error('No passkey set yet. Run setPassword() in the script editor.');
  const ok = sha256_(salt + String(key)) === hash;
  if (!ok) cache.put('failedLogins', String(fails + 1), AUTH.lockoutSeconds);
  return ok;
}

function sha256_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('');
}

/* ============================== Small helpers ============================== */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
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

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================== Starting data for setup() ============================== */

const SEED = {
  cellar: [
    { producer: 'Leflaive', wine: 'Bourgogne Blanc', vintage: 2022, colour: 'White', grape: 'Chardonnay',
      window: '2024–2030', bottles: 1, status: 'In cellar', storage: '-', price: 150 },
    { producer: 'Jadot', wine: 'Gevrey-Chambertin', vintage: 2018, colour: 'Red', grape: 'Pinot Noir',
      window: '2023–2033', bottles: 1, status: 'In cellar', storage: '-', price: 140 },
    { producer: 'Duroche', wine: 'Vosne-Romanée', vintage: 2018, colour: 'Red', grape: 'Pinot Noir',
      window: '2024–2035', bottles: 1, status: 'In cellar', storage: '-', price: 152 },
    { producer: 'Coudray-Bizot', wine: 'Vosne-Romanée 1er Cru La Croix Rameau', vintage: 2020, colour: 'Red',
      grape: 'Pinot Noir', window: '2027–2040', bottles: 1, status: 'In cellar', storage: '-', price: 313 },
    { producer: 'A F Gros', wine: 'Moulin-à-Vent', vintage: 2023, colour: 'Red', grape: 'Gamay',
      window: '2025–2029', bottles: 1, status: 'To collect', storage: 'Grand Cru, collect Fri 27 Nov', price: 54 },
  ],
  drunk: [
    { producer: 'Penfolds', wine: 'Bin 128', vintage: 2024, colour: 'Red', grape: 'Shiraz', price: 88 },
  ],
};
