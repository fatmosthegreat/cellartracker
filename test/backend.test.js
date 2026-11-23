// Runs the real apps-script/Code.gs against an in-memory sheet. Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFakeGas, loadBackend, sha256Bytes } = require('../dev/fake-gas.js');

const CODE = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');
const PASSKEY = 'test-passkey';

function freshCellar() {
  const gas = createFakeGas();
  const backend = loadBackend(gas, CODE);
  backend.setup();
  const salt = 'salt';
  gas.PropertiesService.getScriptProperties().setProperties({ PASS_SALT: salt, PASS_HASH: backend.sha256_(salt + PASSKEY) });
  const as = key => (action, extra) => backend.handle_(Object.assign({ action, key }, extra));
  const owner = as(PASSKEY);
  const ok = (action, extra) => {
    const res = owner(action, extra);
    assert.equal(res.ok, true, `${action} failed: ${res.error}`);
    return res;
  };
  const tab = name => gas._spreadsheet.getSheetByName(name);
  const byName = (list, producer) => list.filter(w => w.producer === producer);
  return { gas, backend, owner, friend: as(null), ok, tab, byName };
}

test('the fake SHA-256 matches Node crypto', () => {
  for (const s of ['', 'abc', 'Vosne-Romanée', 'x'.repeat(200)]) {
    const want = crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    const got = sha256Bytes(s).map(b => b.toString(16).padStart(2, '0')).join('');
    assert.equal(got, want, s);
  }
});

test('setup creates Cellar and Drunk with your bottles, and refuses to run twice', () => {
  const { ok, backend, gas } = freshCellar();
  const res = ok('list');
  assert.equal(res.cellar.length, 5);
  assert.equal(res.drunk.length, 1);
  assert.equal(res.drunk[0].producer, 'Penfolds');
  assert.equal(gas._spreadsheet.getSheetByName('Sheet1'), null, 'blank Sheet1 is removed');
  assert.throws(() => backend.setup(), /already have bottles/);
});

test('numbers, flags and accents survive the round trip', () => {
  const { ok } = freshCellar();
  const duroche = ok('list').cellar.find(w => w.producer === 'Duroche');
  assert.equal(duroche.wine, 'Vosne-Romanée');
  assert.equal(duroche.vintage, 2018);
  assert.equal(duroche.price, 152);
  assert.equal(duroche.bottles, 1);
  assert.equal(duroche.hidden, false);
  assert.equal(duroche.window, '2024–2035');
});

test('friends only see bottles that are not hidden, in both tabs', () => {
  const { ok, friend } = freshCellar();
  const before = ok('list');
  ok('update', { id: before.cellar[0].id, wine: { hidden: true } });
  ok('update', { id: before.drunk[0].id, wine: { hidden: true } });
  const pub = friend('list');
  assert.equal(pub.ok, true);
  assert.equal(pub.owner, false);
  assert.equal(pub.cellar.length, 4);
  assert.equal(pub.drunk.length, 0);
  assert.ok(pub.cellar.every(w => !w.hidden));
  assert.equal(ok('list').cellar.length, 5, 'the owner still sees everything');
});

test('changes need the right passkey', () => {
  const { friend, backend } = freshCellar();
  const anon = friend('create', { wine: { producer: 'X', wine: 'Y' } });
  assert.equal(anon.ok, false);
  assert.equal(anon.auth, false);
  const wrong = backend.handle_({ action: 'login', key: 'nope' });
  assert.equal(wrong.auth, false);
  assert.equal(backend.handle_({ action: 'list', key: 'nope' }).auth, false, 'a wrong key never falls back to the public list');
});

test('logins pause after too many wrong passkeys', () => {
  const { backend, owner } = freshCellar();
  for (let i = 0; i < 8; i++) backend.handle_({ action: 'login', key: 'guess' + i });
  const res = owner('login');
  assert.equal(res.ok, false);
  assert.match(res.error, /Too many wrong passkeys/);
});

test('adding a wine you already have adds a bottle instead of a duplicate row', () => {
  const { ok, byName } = freshCellar();
  // Different case, no hyphen, no price: still the same wine.
  const res = ok('create', { wine: { producer: 'jadot', wine: 'Gevrey Chambertin', vintage: 2018 } });
  assert.equal(res.result.merged, true);
  assert.equal(res.result.bottles, 2);
  assert.equal(res.cellar.length, 5);
  assert.equal(byName(res.cellar, 'Jadot')[0].bottles, 2);
});

test('adding several bottles at once adds them all', () => {
  const { ok, byName } = freshCellar();
  const res = ok('create', { wine: { producer: 'Duroche', wine: 'Vosne-Romanée', vintage: 2018, bottles: 3 } });
  assert.equal(byName(res.cellar, 'Duroche')[0].bottles, 4);
});

test('same wine but a different vintage, price or status gets its own row', () => {
  const { ok, byName } = freshCellar();
  ok('create', { wine: { producer: 'Jadot', wine: 'Gevrey-Chambertin', vintage: 2019 } });
  ok('create', { wine: { producer: 'Jadot', wine: 'Gevrey-Chambertin', vintage: 2018, price: 175 } });
  const res = ok('create', { wine: { producer: 'Jadot', wine: 'Gevrey-Chambertin', vintage: 2018, status: 'To collect' } });
  assert.equal(byName(res.cellar, 'Jadot').length, 4);
});

test('a non-vintage wine is kept apart from vintage ones', () => {
  const { ok } = freshCellar();
  ok('create', { wine: { producer: 'Krug', wine: 'Grande Cuvée' } });
  const res = ok('create', { wine: { producer: 'Krug', wine: 'Grande Cuvée', vintage: 2008 } });
  const krug = res.cellar.filter(w => w.producer === 'Krug');
  assert.equal(krug.length, 2);
  assert.ok(krug.some(w => w.vintage === null));
});

test('drinking one of several bottles leaves the rest in the cellar', () => {
  const { ok, byName } = freshCellar();
  const jadot = byName(ok('create', { wine: { producer: 'Jadot', wine: 'Gevrey-Chambertin', vintage: 2018 } }).cellar, 'Jadot')[0];
  const res = ok('drink', { id: jadot.id, drink: { drunkOn: '2026-12-01', rating: 8.5, notes: 'Opened up after an hour' } });
  assert.equal(res.result.left, 1);
  assert.equal(byName(res.cellar, 'Jadot')[0].bottles, 1);
  const drunk = byName(res.drunk, 'Jadot');
  assert.equal(drunk.length, 1);
  assert.equal(drunk[0].drunkOn, '2026-12-01');
  assert.equal(drunk[0].rating, 8.5);
  assert.equal(drunk[0].notes, 'Opened up after an hour');
  assert.equal(drunk[0].price, 140, 'price paid carries over');
  assert.notEqual(drunk[0].id, jadot.id, 'each drunk bottle gets its own id');
});

test('drinking the last bottle removes the wine from the Cellar tab entirely', () => {
  const { ok, byName, tab } = freshCellar();
  const leflaive = byName(ok('list').cellar, 'Leflaive')[0];
  const res = ok('drink', { id: leflaive.id, drink: {} });
  assert.equal(res.result.left, 0);
  assert.equal(byName(res.cellar, 'Leflaive').length, 0);
  assert.equal(byName(res.drunk, 'Leflaive').length, 1);
  assert.equal(tab('Cellar').getLastRow(), 1 + 4, 'the row is gone from the sheet, not just hidden');
  assert.match(byName(res.drunk, 'Leflaive')[0].drunkOn, /^\d{4}-\d{2}-\d{2}$/, 'defaults to today');
});

test('drinking several bottles at once writes one Drunk row per bottle', () => {
  const { ok, byName } = freshCellar();
  const res1 = ok('create', { wine: { producer: 'Duroche', wine: 'Vosne-Romanée', vintage: 2018, bottles: 2 } });
  const id = byName(res1.cellar, 'Duroche')[0].id;
  const res = ok('drink', { id, drink: { count: 3 } });
  assert.equal(byName(res.drunk, 'Duroche').length, 3);
  assert.equal(byName(res.cellar, 'Duroche').length, 0);
});

test("you can't drink more bottles than you have, or drink from the Drunk tab", () => {
  const { ok, owner } = freshCellar();
  const list = ok('list');
  const tooMany = owner('drink', { id: list.cellar[0].id, drink: { count: 2 } });
  assert.match(tooMany.error, /only 1 bottle/);
  const twice = owner('drink', { id: list.drunk[0].id, drink: {} });
  assert.match(twice.error, /no longer in the cellar/);
  assert.equal(ok('list').cellar.length, 5, 'nothing moved');
});

test('the bottle count goes up and down but never below one', () => {
  const { ok, owner } = freshCellar();
  const id = ok('list').cellar[0].id;
  assert.equal(ok('adjust', { id, delta: 1 }).result.bottles, 2);
  assert.equal(ok('adjust', { id, delta: -1 }).result.bottles, 1);
  assert.match(owner('adjust', { id, delta: -1 }).error, /leave no bottles/);
  assert.match(owner('adjust', { id, delta: 0.5 }).error, /whole number/);
});

test('bad values are rejected with a readable message and change nothing', () => {
  const { ok, owner } = freshCellar();
  const id = ok('list').cellar[0].id;
  const cases = [
    [{ vintage: 'abc' }, /Vintage must be a whole number/],
    [{ vintage: 1700 }, /Vintage must be/],
    [{ bottles: 0 }, /Bottles must be/],
    [{ purchased: '27/11/2026' }, /Bought on must be a date/],
    [{ status: 'Drunk' }, /Status must be one of/],
    [{ producer: '  ' }, /Producer can't be blank/],
  ];
  for (const [wine, msg] of cases) {
    const res = owner('update', { id, wine });
    assert.equal(res.ok, false, JSON.stringify(wine));
    assert.match(res.error, msg);
  }
  assert.match(owner('create', { wine: { wine: 'No producer' } }).error, /Producer can't be blank/);
  assert.match(owner('update', { id: ok('list').drunk[0].id, wine: { rating: 11 } }).error, /Rating must be/);
  assert.equal(ok('list').cellar[0].vintage, 2022, 'nothing was written');
});

test('prices typed with a currency sign or commas are understood', () => {
  const { ok } = freshCellar();
  const res = ok('create', { wine: { producer: 'DRC', wine: 'Échezeaux', vintage: 2019, price: 'S$2,450' } });
  assert.equal(res.cellar.find(w => w.producer === 'DRC').price, 2450);
});

test('a blank value clears a field; fields that are not sent stay as they were', () => {
  const { ok } = freshCellar();
  const w = ok('list').cellar[0];
  const res = ok('update', { id: w.id, wine: { grape: '' } });
  const after = res.cellar.find(x => x.id === w.id);
  assert.equal(after.grape, null);
  assert.equal(after.price, w.price);
  assert.equal(after.window, w.window);
});

test('text that looks like a formula is stored as plain text', () => {
  const { ok } = freshCellar();
  const res = ok('create', { wine: { producer: '=IMPORTXML("http://x")', wine: '-cheeky', vintage: 2020 } });
  const w = res.cellar.find(x => x.wine === '-cheeky');
  assert.equal(w.producer, '=IMPORTXML("http://x")');
});

test('extra columns you add in the sheet are left alone', () => {
  const { ok, tab } = freshCellar();
  const cellar = tab('Cellar');
  const col = cellar.getLastColumn() + 1;
  cellar.getRange(1, col).setValues([['Supplier']]);
  cellar.getRange(2, col).setValues([['Grand Cru Wines']]);
  const id = ok('list').cellar[0].id;
  ok('update', { id, wine: { notes: 'For graduation' } });
  ok('adjust', { id, delta: 1 });
  assert.equal(cellar.getRange(2, col).getDisplayValues()[0][0], 'Grand Cru Wines');
});

test('columns are found by header name, so reordering them is fine', () => {
  const { ok, tab } = freshCellar();
  const cellar = tab('Cellar');
  cellar.rows = cellar.rows.map(r => r.slice().reverse());  // reverse every column
  const res = ok('list');
  const d = res.cellar.find(w => w.producer === 'Duroche');
  assert.equal(d.price, 152);
  ok('update', { id: d.id, wine: { price: 160 } });
  assert.equal(ok('list').cellar.find(w => w.producer === 'Duroche').price, 160);
});

test('migrate() adds missing columns without touching data', () => {
  const { ok, tab, backend } = freshCellar();
  const cellar = tab('Cellar');
  const before = ok('list').cellar;
  backend.SCHEMA.Cellar.push('region');
  backend.migrate();
  assert.ok(cellar.getRange(1, 1, 1, cellar.getLastColumn()).getDisplayValues()[0].includes('region'));
  assert.deepEqual(ok('list').cellar.map(w => w.price), before.map(w => w.price));
});

test('removing a bottle works from either tab', () => {
  const { ok } = freshCellar();
  const list = ok('list');
  ok('remove', { id: list.cellar[0].id });
  const res = ok('remove', { id: list.drunk[0].id });
  assert.equal(res.cellar.length, 4);
  assert.equal(res.drunk.length, 0);
});

test('the web endpoints return JSON', () => {
  const { backend } = freshCellar();
  const viaGet = JSON.parse(backend.doGet().getContent());
  assert.equal(viaGet.ok, true);
  assert.equal(viaGet.apiVersion, 1);
  const bad = JSON.parse(backend.doPost({ postData: { contents: 'not json' } }).getContent());
  assert.equal(bad.ok, false);
  const unknown = JSON.parse(backend.doPost({ postData: { contents: '{"action":"explode"}' } }).getContent());
  assert.match(unknown.error, /Unknown action/);
});

/* ============================== Telegram bot ============================== */

const CHAT = '4242';
const SECRET = 'webhook-secret';

// A cellar with the bot set up. `say` sends a chat message, `tap` presses a button.
function freshBot() {
  const c = freshCellar();
  c.gas.PropertiesService.getScriptProperties().setProperties({
    TELEGRAM_TOKEN: '123:abc', TELEGRAM_URL: 'https://script.google.com/macros/s/x/exec',
    TELEGRAM_SECRET: SECRET, TELEGRAM_CHAT_ID: CHAT,
  });
  let updateId = 100;
  const post = (update, secret = SECRET) => {
    c.gas._fetches.length = 0;
    c.backend.doPost({ parameter: { tg: secret }, postData: { contents: JSON.stringify(update) } });
    return c.gas._fetches.slice();
  };
  const say = (text, chat = CHAT) => post({ update_id: ++updateId, message: { message_id: 1, chat: { id: Number(chat) }, text } });
  const tap = data => post({ update_id: ++updateId, callback_query: { id: 'cb', data, message: { message_id: 7, chat: { id: Number(CHAT) } } } });
  const sent = calls => calls.filter(f => f.method === 'sendMessage' || f.method === 'editMessageText').map(f => f.payload.text).join('\n');
  const buttons = calls => calls.filter(f => f.payload.reply_markup).flatMap(f => f.payload.reply_markup.inline_keyboard.flat());
  return Object.assign(c, { post, say, tap, sent, buttons });
}

test('the bot ignores a wrong secret, another chat, and repeated updates', () => {
  const { post, say, ok } = freshBot();
  assert.equal(post({ update_id: 1, message: { chat: { id: Number(CHAT) }, text: '/cellar' } }, 'wrong').length, 0);
  assert.equal(say('/cellar', '999').length, 0);
  const update = { update_id: 500, message: { chat: { id: Number(CHAT) }, text: '/cellar' } };
  assert.ok(post(update).length > 0);
  assert.equal(post(update).length, 0, 'a Telegram retry is not answered twice');
  assert.equal(ok('list').cellar.length, 5);
});

test('the web page still works alongside the bot', () => {
  const { backend } = freshBot();
  const res = JSON.parse(backend.doPost({ parameter: {}, postData: { contents: '{"action":"list"}' } }).getContent());
  assert.equal(res.ok, true);
});

test('/cellar lists every bottle by status, and plain text searches ignoring accents', () => {
  const { say, sent, ok } = freshBot();
  const text = sent(say('/cellar'));
  assert.match(text, /In the cellar<\/b> · 4 bottles/);
  assert.match(text, /To collect<\/b> · 1 bottle/);
  for (const w of ok('list').cellar) assert.ok(text.includes(w.producer), w.producer);

  const found = sent(say('romanee duroche'));
  assert.match(found, /Duroche/);
  assert.doesNotMatch(found, /Coudray/);
  assert.match(sent(say('/search@TheCellar_bot ROMANÉE')), /Coudray-Bizot/);
  assert.match(sent(say('/search nothing-like-this')), /Nothing in the cellar matches/);
  assert.match(sent(say('/explode')), /I don't know \/explode/);
});

test('/stats, /collect and /help answer', () => {
  const { say, sent } = freshBot();
  assert.match(sent(say('/stats')), /<b>4<\/b> in the cellar\n<b>1<\/b> to collect\n<b>1<\/b> drunk\n<b>S\$809<\/b> on the shelf/);
  assert.match(sent(say('/collect')), /A F Gros[\s\S]*Grand Cru, collect Fri 27 Nov/);
  assert.match(sent(say('/help')), /\/drank/);
});

test('a long /cellar is split into messages under the Telegram limit', () => {
  const { say, ok } = freshBot();
  for (let i = 0; i < 120; i++) {
    ok('create', { wine: { producer: 'Producer ' + i, wine: 'A rather long cuvée name for testing ' + i, vintage: 2000 + (i % 20), window: '2025–2035' } });
  }
  const msgs = say('/cellar').filter(f => f.method === 'sendMessage');
  assert.ok(msgs.length > 1);
  for (const m of msgs) assert.ok(m.payload.text.length <= 4096);
  assert.ok(msgs.map(m => m.payload.text).join('\n').includes('Producer 119'));
});

test('/drank shows buttons, and tapping one drinks it exactly like the website', () => {
  const { say, tap, sent, buttons, ok, byName } = freshBot();
  const btns = buttons(say('/drank duroche'));
  assert.equal(btns.length, 1);
  assert.match(btns[0].text, /2018 Duroche Vosne-Romanée/);
  const done = tap(btns[0].callback_data);
  assert.ok(done.some(f => f.method === 'answerCallbackQuery'));
  assert.match(sent(done), /Drank .*Duroche[\s\S]*That was the last one/);
  const res = ok('list');
  assert.equal(byName(res.cellar, 'Duroche').length, 0);
  assert.equal(byName(res.drunk, 'Duroche').length, 1);
  assert.match(sent(tap(btns[0].callback_data)), /no longer in the cellar/, 'a second tap is refused');
  assert.match(sent(say('/drank nothing-like-this')), /Nothing matches/);
});

test('a failed tap acknowledgement still replaces the buttons, so a bottle is never drunk twice', () => {
  const { say, tap, sent, buttons, gas } = freshBot();
  const btn = buttons(say('/drank jadot'))[0];
  gas._replies.answerCallbackQuery = () => ({ ok: false, description: 'query is too old' });
  assert.match(sent(tap(btn.callback_data)), /Drank .*Jadot/);
});

test('/collected and /add1 change status and count', () => {
  const { say, tap, buttons, ok, byName } = freshBot();
  const coll = buttons(say('/collected'));
  assert.equal(coll.length, 1, 'only bottles still to collect');
  tap(coll[0].callback_data);
  assert.equal(byName(ok('list').cellar, 'A F Gros')[0].status, 'In cellar');
  tap(buttons(say('/add1 jadot'))[0].callback_data);
  assert.equal(byName(ok('list').cellar, 'Jadot')[0].bottles, 2);
});

test('installTelegram sets the webhook with the secret and one daily reminder timer', () => {
  const { backend, gas } = freshBot();
  backend.installTelegram();
  backend.installTelegram();  // running it twice doesn't double the timers
  const hook = gas._fetches.find(f => f.method === 'setWebhook');
  assert.equal(hook.payload.url, 'https://script.google.com/macros/s/x/exec?tg=' + SECRET);
  assert.deepEqual(gas._triggers.map(t => [t.fn, t.schedule.atHour]), [['sendReminders', 9]]);
  backend.uninstallTelegram();
  assert.equal(gas._triggers.length, 0);
});

test('polling answers new messages once and moves past ones from other chats', () => {
  const { backend, gas, sent } = freshBot();
  const queue = [
    { update_id: 900, message: { message_id: 1, chat: { id: 999 }, text: '/cellar' } },
    { update_id: 901, message: { message_id: 2, chat: { id: Number(CHAT) }, text: '/help' } },
  ];
  const offsets = [];
  gas._replies.getUpdates = p => { offsets.push(p.offset); return { ok: true, result: queue.filter(u => u.update_id >= p.offset) }; };
  backend.pollTelegram();
  assert.match(sent(gas._fetches), /\/drank/);
  gas._fetches.length = 0;
  backend.pollTelegram();
  assert.deepEqual(offsets.slice(-1), [902], 'both updates are marked done');
  assert.equal(sent(gas._fetches), '', 'nothing is answered twice');
});

test('findTelegramChatId saves the chat of the last message', () => {
  const { backend, gas } = freshBot();
  gas._replies.getUpdates = () => ({ ok: true, result: [{ update_id: 1, message: { chat: { id: 777, first_name: 'Me' }, text: 'hi' } }] });
  backend.findTelegramChatId();
  assert.equal(gas.PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_ID'), '777');
  assert.equal(gas._fetches.at(-1).payload.chat_id, '777');
});

/* ---------- Reminders ---------- */

const W = (over = {}) => ({ id: 'w1', producer: 'Jadot', wine: 'Gevrey', vintage: 2018, window: '2027–2033', status: 'In cellar', ...over });
const due = (recs, today, sent = {}) => loadBackend(createFakeGas(), CODE).remindersDue_(recs, today, sent).map(r => r.key);

test('window reminders: opens in its first year, closing from 1 July of its last year', () => {
  assert.deepEqual(due([W()], '2026-12-31'), []);
  assert.deepEqual(due([W()], '2027-01-01'), ['w1|open|2027']);
  assert.deepEqual(due([W()], '2027-01-01', { 'w1|open|2027': '2027-01-01' }), [], 'not twice');
  assert.deepEqual(due([W()], '2028-01-01'), []);
  assert.deepEqual(due([W()], '2033-06-30'), []);
  assert.deepEqual(due([W()], '2033-07-01'), ['w1|close|2033']);
  assert.deepEqual(due([W()], '2034-07-01'), []);
  assert.deepEqual(due([W({ window: 'someday' })], '2027-01-01'), []);
});

test('collect reminders: day before, on the day, and a Monday nudge when undated or overdue', () => {
  const tc = over => W({ window: '', status: 'To collect', ...over });
  assert.deepEqual(due([tc({ collectBy: '2026-11-27' })], '2026-11-26'), ['w1|collect|2026-11-27|before']);
  assert.deepEqual(due([tc({ collectBy: '2026-11-27' })], '2026-11-27'), ['w1|collect|2026-11-27|day']);
  assert.deepEqual(due([tc({ collectBy: '2026-11-27' })], '2026-11-25'), []);
  assert.deepEqual(due([tc()], '2026-11-23'), ['w1|nudge|2026-11-23'], '23 Nov 2026 is a Monday');
  assert.deepEqual(due([tc()], '2026-11-24'), [], 'not on Tuesday');
  assert.deepEqual(due([tc({ collectBy: '2026-11-20' })], '2026-11-23'), ['w1|nudge|2026-11-23'], 'overdue');
  assert.deepEqual(due([tc({ collectBy: '2026-12-20' })], '2026-11-23'), [], 'not due yet');
  assert.deepEqual(due([W({ window: '', collectBy: '2026-11-27' })], '2026-11-27'), [], 'already collected');
});

test('sendReminders sends one message, then nothing more that day', () => {
  const { backend, gas, ok } = freshBot();
  const gros = ok('list').cellar.find(w => w.producer === 'A F Gros');
  ok('update', { id: gros.id, wine: { collectBy: '2026-11-27' } });
  gas._fetches.length = 0;
  assert.equal(backend.sendReminders_('2026-11-26'), 1);
  const msgs = gas._fetches.filter(f => f.method === 'sendMessage');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].payload.text, /Collect tomorrow[\s\S]*A F Gros/);
  gas._fetches.length = 0;
  assert.equal(backend.sendReminders_('2026-11-26'), 0);
  assert.equal(gas._fetches.length, 0);
});

test('Collect by is a date, and is not carried into Drunk', () => {
  const { ok, owner, tab } = freshCellar();
  const w = ok('list').cellar.find(x => x.producer === 'A F Gros');
  assert.match(owner('update', { id: w.id, wine: { collectBy: 'Friday' } }).error, /Collect by must be a date/);
  ok('update', { id: w.id, wine: { collectBy: '2026-11-27' } });
  assert.equal(ok('list').cellar.find(x => x.id === w.id).collectBy, '2026-11-27');
  const res = ok('drink', { id: w.id });
  assert.equal('collectBy' in res.drunk.at(-1), false);
  const drunk = tab('Drunk');
  assert.ok(!drunk.getRange(1, 1, 1, drunk.getLastColumn()).getDisplayValues()[0].includes('collectBy'));
});
