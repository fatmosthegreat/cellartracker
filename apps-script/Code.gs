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
 * Telegram:   setTelegram() → findTelegramChatId() → installTelegram().   (Optional; see README.md.)
 * New field:  add it to SCHEMA (and FIELD_RULES if it isn't free text), then run migrate().
 * Tests:      `node --test` in the repo runs this file against an in-memory sheet.
 *
 * Written for the Apps Script V8 runtime. Avoids ?. and ?? to stay on safe syntax.
 */

const API_VERSION = 1;

const SCHEMA = {
  Cellar: ['id', 'producer', 'wine', 'vintage', 'colour', 'grape', 'window', 'bottles', 'status',
    'storage', 'price', 'purchased', 'notes', 'hidden', 'created', 'updated', 'collectBy'],
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
  collectBy: { type: 'date', label: 'Collect by' },
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
// Telegram POSTs updates to the same URL with ?tg=<secret> added (see installTelegram).
function doPost(e) {
  if (e && e.parameter && e.parameter.tg) {
    try {
      handleTelegram_(JSON.parse((e.postData && e.postData.contents) || '{}'), e.parameter.tg);
    } catch (err) {
      Logger.log('Telegram update failed: ' + ((err && err.message) || err));
    }
    return ContentService.createTextOutput('ok');
  }
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

/* ============================== Telegram bot (optional) ============================== */
//
// Reminders go out once a day from a timer; commands arrive as webhook POSTs to doPost.
// Only your chat is answered, and every update must carry the secret in the webhook URL.
// The token, chat id and secret live in Script Properties, never in this file.

const BOT = { currency: 'S$', reminderHour: 9, maxButtons: 30 };

// Run once from the editor. Paste your token and web app URL, run, then put the placeholders back.
function setTelegram() {
  const token = 'paste-your-bot-token-here';
  const webAppUrl = 'paste-your-web-app-url-here';
  if (token.indexOf('paste-') === 0 || webAppUrl.indexOf('paste-') === 0) {
    throw new Error('Paste your bot token and web app URL into setTelegram(), then run it again.');
  }
  if (!/^\d+:[\w-]{30,}$/.test(token)) throw new Error('That doesn\'t look like a bot token. Copy it again from @BotFather.');
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(webAppUrl)) {
    throw new Error('The web app URL should start with https://script.google.com/ and end in /exec.');
  }
  PropertiesService.getScriptProperties().setProperties({
    TELEGRAM_TOKEN: token,
    TELEGRAM_URL: webAppUrl,
    TELEGRAM_SECRET: Utilities.getUuid().replace(/-/g, ''),
  });
  Logger.log('Saved. Send your bot a message in Telegram, then run findTelegramChatId(). Put the placeholders back afterwards.');
}

// Finds your chat from the last message you sent the bot, and saves it as the only chat it answers.
function findTelegramChatId() {
  let updates;
  try {
    updates = telegramApi_('getUpdates', {}).result;
  } catch (err) {
    throw new Error(String(err.message) + ' (If the bot is already installed, run uninstallTelegram() first.)');
  }
  const msgs = updates.filter(function (u) { return u.message && u.message.chat; }).map(function (u) { return u.message; });
  if (!msgs.length) throw new Error('No messages yet. Send your bot "hi" in Telegram, then run this again.');
  const chat = msgs[msgs.length - 1].chat;
  PropertiesService.getScriptProperties().setProperties({ TELEGRAM_CHAT_ID: String(chat.id) });
  telegramSend_('Cellar bot connected 🍷\nRun installTelegram() in Apps Script to turn on commands and reminders.');
  Logger.log('Connected to ' + (chat.first_name || chat.title || 'chat') + ' (' + chat.id + '). Now run migrate(), then installTelegram().');
}

// Turns on commands (webhook) and the daily reminders. Safe to run again.
function installTelegram() {
  const cfg = telegramConfig_();
  telegramApi_('setWebhook', { url: cfg.url + '?tg=' + cfg.secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  telegramApi_('setMyCommands', { commands: Object.keys(TG_COMMANDS).filter(function (c) { return TG_COMMANDS[c].menu; })
    .map(function (c) { return { command: c, description: TG_COMMANDS[c].help }; }) });
  replaceTrigger_('pollTelegram', null);
  replaceTrigger_('sendReminders', function (b) { return b.everyDays(1).atHour(BOT.reminderHour); });
  Logger.log('Done. Try /help in Telegram. Reminders go out at ' + BOT.reminderHour + ':00 (Project Settings time zone) when something is due.');
}

// Fallback if commands get no reply (check with telegramStatus): checks for messages every minute instead.
function installTelegramPolling() {
  telegramConfig_();
  telegramApi_('deleteWebhook', {});
  replaceTrigger_('pollTelegram', function (b) { return b.everyMinutes(1); });
  Logger.log('Polling every minute. Replies can take up to a minute.');
}

// Stops commands and reminders. Your settings stay, so installTelegram() turns it back on.
function uninstallTelegram() {
  telegramApi_('deleteWebhook', {});
  replaceTrigger_('pollTelegram', null);
  replaceTrigger_('sendReminders', null);
  Logger.log('Commands and reminders are off.');
}

function telegramStatus() {
  Logger.log(JSON.stringify(telegramApi_('getWebhookInfo', {}).result, null, 2));
}

// The daily timer calls this.
function sendReminders() {
  return sendReminders_(today_());
}

// The every-minute timer calls this when polling is on. Every update fetched is marked as done,
// including ones the bot ignores (other chats), so Telegram doesn't send them again.
function pollTelegram() {
  const cfg = telegramConfig_();
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty('TG_LAST_UPDATE') || 0);
  const updates = telegramApi_('getUpdates', { offset: last + 1, timeout: 0, allowed_updates: ['message', 'callback_query'] }).result;
  updates.forEach(function (u) { handleTelegram_(u, cfg.secret); });
  const newest = updates.reduce(function (n, u) { return Math.max(n, u.update_id); }, 0);
  withLock_(function () {
    if (newest > Number(props.getProperty('TG_LAST_UPDATE') || 0)) props.setProperties({ TG_LAST_UPDATE: String(newest) });
  });
}

/* ---------- Reminders ---------- */

function sendReminders_(today) {
  const props = PropertiesService.getScriptProperties();
  let sent = {};
  try { sent = JSON.parse(props.getProperty('REMINDERS_SENT') || '{}'); } catch (err) { sent = {}; }
  const recs = readRows_(table_('Cellar')).map(function (r) { return r.rec; });
  const due = remindersDue_(recs, today, sent);
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
  props.setProperties({ REMINDERS_SENT: JSON.stringify(sent) });
  return due.length;
}

// Pure: which reminders are due today. `sent` holds the keys already sent, so nothing repeats.
// The year or date is part of each key, so changing a bottle's window or date re-arms it.
function remindersDue_(recs, today, sent) {
  const year = Number(today.slice(0, 4));
  const tomorrow = addDays_(today, 1);
  const monday = new Date(today + 'T12:00:00Z').getUTCDay() === 1;
  const out = [];
  const add = function (key, text) { if (!(key in sent)) out.push({ key: key, text: text }); };
  sortCellar_(recs).forEach(function (w) {
    const win = parseWindow_(w.window);
    if (win && year === win.from) {
      add(w.id + '|open|' + win.from, '🍷 <b>Ready to drink</b> from this year\n' + bottleLine_(w));
    }
    if (win && year === win.to && today >= win.to + '-07-01') {
      add(w.id + '|close|' + win.to, '⏳ <b>Drink by December</b>, its window closes this year\n' + bottleLine_(w));
    }
    if (w.status !== 'To collect') return;
    const where = w.storage && w.storage !== '-' ? '\n' + escH_(w.storage) : '';
    if (w.collectBy === tomorrow) {
      add(w.id + '|collect|' + w.collectBy + '|before', '📦 <b>Collect tomorrow</b>\n' + bottleLine_(w) + where);
    } else if (w.collectBy === today) {
      add(w.id + '|collect|' + w.collectBy + '|day', '📦 <b>Collect today</b>\n' + bottleLine_(w) + where);
    } else if (monday && (!w.collectBy || w.collectBy < today)) {
      const late = w.collectBy ? ' (was due ' + niceDate_(w.collectBy) + ')' : '';
      add(w.id + '|nudge|' + today, '📦 <b>Still to collect</b>' + late + '\n' + bottleLine_(w) + where);
    }
  });
  return out;
}

/* ---------- Commands ---------- */

// `menu` commands show in Telegram's command list. `run` gets the text after the command.
const TG_COMMANDS = {
  cellar: { menu: true, help: 'Everything in the cellar', run: function () { return { text: cellarText_(cellarRecs_()) }; } },
  ready: { menu: true, help: 'In its drinking window now', run: function () {
    const year = Number(today_().slice(0, 4));
    const recs = cellarRecs_().filter(function (w) { const win = parseWindow_(w.window); return win && win.from <= year && year <= win.to; });
    return { text: listText_('Ready to drink', recs, 'Nothing is in its drinking window right now.') };
  } },
  closing: { menu: true, help: 'Windows ending this year or next', run: function () {
    const year = Number(today_().slice(0, 4));
    const recs = cellarRecs_().filter(function (w) { const win = parseWindow_(w.window); return win && (win.to === year || win.to === year + 1); })
      .sort(function (a, b) { return parseWindow_(a.window).to - parseWindow_(b.window).to; });
    return { text: listText_('Drink soon', recs, 'No windows end this year or next.', true) };
  } },
  collect: { menu: true, help: 'Bottles to collect', run: function () {
    const recs = cellarRecs_().filter(function (w) { return w.status === 'To collect'; });
    if (!recs.length) return { text: 'Nothing to collect.' };
    return { text: '<b>To collect</b>\n\n' + recs.map(function (w) {
      return bottleLine_(w) + (w.collectBy ? '\nCollect by ' + niceDate_(w.collectBy) : '') +
        (w.storage && w.storage !== '-' ? '\n' + escH_(w.storage) : '');
    }).join('\n\n') };
  } },
  search: { menu: true, help: 'Find a bottle, e.g. /search romanee', run: function (q) {
    if (!q) return { text: 'Type what to look for, e.g. /search romanee' };
    return { text: listText_('Matches for “' + escH_(q) + '”', searchRecs_(cellarRecs_(), q), 'Nothing in the cellar matches “' + escH_(q) + '”.') };
  } },
  stats: { menu: true, help: 'Bottle counts and value', run: function () {
    const recs = cellarRecs_();
    const sum = function (list) { return list.reduce(function (n, w) { return n + (w.bottles || 1); }, 0); };
    const value = recs.reduce(function (n, w) { return n + (w.price || 0) * (w.bottles || 1); }, 0);
    return { text: [
      '<b>' + sum(recs.filter(function (w) { return w.status === 'In cellar'; })) + '</b> in the cellar',
      '<b>' + sum(recs.filter(function (w) { return w.status === 'To collect'; })) + '</b> to collect',
      '<b>' + readRows_(table_('Drunk')).length + '</b> drunk',
      '<b>' + escH_(BOT.currency) + money_(value) + '</b> on the shelf',
    ].join('\n') };
  } },
  drank: { menu: true, help: 'Record a bottle you drank', run: function (q) {
    return pickBottle_('drink', q, cellarRecs_(), 'Which one did you drink?');
  } },
  collected: { menu: true, help: 'Mark a bottle as collected', run: function (q) {
    return pickBottle_('coll', q, cellarRecs_().filter(function (w) { return w.status === 'To collect'; }), 'Which one did you collect?');
  } },
  add1: { menu: true, help: 'Add another bottle of a wine', run: function (q) {
    return pickBottle_('add1', q, cellarRecs_(), 'Which wine did you buy another bottle of?');
  } },
  help: { menu: true, help: 'What I can do', run: function () {
    return { text: Object.keys(TG_COMMANDS).filter(function (c) { return TG_COMMANDS[c].menu; })
      .map(function (c) { return '/' + c + ' · ' + escH_(TG_COMMANDS[c].help); }).join('\n') +
      '\n\nOr just type a name to search. Reminders arrive at ' + BOT.reminderHour + ':00 when something is due.' };
  } },
};
TG_COMMANDS.start = { help: '', run: TG_COMMANDS.help.run };

// What tapping a bottle's button does. Each returns the text that replaces the buttons.
const TG_ACTIONS = {
  drink: function (w) {
    const res = withLock_(function () { return drinkWine_(w.id, {}); });
    return '🍷 Drank ' + bottleLine_(w, true) + '\n' + (res.left ? res.left + ' left' : 'That was the last one') + '. Add a rating on the website.';
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

// Entry point for every update, from the webhook or from polling. Returns true if it was handled.
function handleTelegram_(update, secret) {
  const props = PropertiesService.getScriptProperties();
  const want = props.getProperty('TELEGRAM_SECRET');
  if (!want || secret !== want || !update || typeof update.update_id !== 'number') return false;
  const cb = update.callback_query;
  const msg = update.message || (cb && cb.message);
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!msg || !msg.chat || !chatId || String(msg.chat.id) !== chatId) return false;

  // Telegram retries when it doesn't like the response, so each update is handled once only.
  const fresh = withLock_(function () {
    if (update.update_id <= Number(props.getProperty('TG_LAST_UPDATE') || 0)) return false;
    props.setProperties({ TG_LAST_UPDATE: String(update.update_id) });
    return true;
  });
  if (!fresh) return false;

  if (cb) {
    // Acknowledge first: if this fails (e.g. a stale tap), the buttons must still be replaced below,
    // or a second tap could drink another bottle.
    try { telegramApi_('answerCallbackQuery', { callback_query_id: cb.id }); } catch (err) { Logger.log(String(err.message)); }
    let text;
    try {
      const m = /^(drink|coll|add1):(\w+)$/.exec(cb.data || '');
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

  const m = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(String(msg.text || '').trim());
  const name = m ? m[1].toLowerCase() : 'search';
  const arg = m ? m[2].trim() : String(msg.text || '').trim();
  const cmd = TG_COMMANDS[name];
  try {
    if (!cmd) throw new Error('I don\'t know /' + name + '. Try /help.');
    const reply = cmd.run(arg);
    telegramSendLong_(reply.text, reply.buttons);
  } catch (err) {
    telegramSend_('⚠️ ' + escH_(botError_(err)));
  }
  return true;
}

// Buttons for the bottles matching `q`, so you tap the one you mean.
function pickBottle_(act, q, recs, question) {
  const matches = q ? searchRecs_(recs, q) : sortCellar_(recs);
  if (!matches.length) return { text: q ? 'Nothing matches “' + escH_(q) + '”.' : 'No bottles to choose from.' };
  if (matches.length > BOT.maxButtons) {
    return { text: matches.length + ' bottles match. Add a word or two, e.g. /' + ({ drink: 'drank', coll: 'collected', add1: 'add1' })[act] + ' duroche 2018' };
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

function cellarRecs_() {
  return sortCellar_(readRows_(table_('Cellar')).map(function (r) { return r.rec; }));
}

// Every word must appear somewhere, ignoring case and accents: "duroche 2018" finds "Duroché … 2018".
function searchRecs_(recs, q) {
  const words = fold_(q).split(/\s+/).filter(Boolean);
  return sortCellar_(recs.filter(function (w) {
    const hay = fold_([w.producer, w.wine, w.grape, w.vintage, w.colour, w.notes].join(' '));
    return words.every(function (word) { return hay.indexOf(word) >= 0; });
  }));
}

// Same order as the website: by colour, then producer, then vintage.
function sortCellar_(recs) {
  const order = { Sparkling: 0, White: 1, 'Rosé': 2, Red: 3, Sweet: 4, Fortified: 5 };
  const rank = function (w) { return w.colour in order ? order[w.colour] : 9; };
  return recs.slice().sort(function (a, b) {
    return rank(a) - rank(b) || String(a.producer).localeCompare(String(b.producer)) || (a.vintage || 0) - (b.vintage || 0);
  });
}

/* ---------- Talking to Telegram ---------- */

function telegramConfig_() {
  const p = PropertiesService.getScriptProperties();
  const cfg = { token: p.getProperty('TELEGRAM_TOKEN'), url: p.getProperty('TELEGRAM_URL'), secret: p.getProperty('TELEGRAM_SECRET'), chatId: p.getProperty('TELEGRAM_CHAT_ID') };
  if (!cfg.token || !cfg.url || !cfg.secret) throw new Error('Run setTelegram() first.');
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

function telegramSend_(text, buttons) {
  const chatId = PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_ID');
  if (!chatId) throw new Error('No Telegram chat yet. Run findTelegramChatId().');
  const payload = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };
  return telegramApi_('sendMessage', payload);
}

// Telegram caps a message at 4096 characters, so long lists go out in parts, split between lines.
function telegramSendLong_(text, buttons) {
  const parts = [];
  let cur = '';
  String(text).split('\n').forEach(function (line) {
    if (cur && cur.length + line.length + 1 > 3800) { parts.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + line : line;
  });
  parts.push(cur);
  parts.forEach(function (p, i) { telegramSend_(p, i === parts.length - 1 ? buttons : null); });
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
