// Runs the real apps-script/Code.gs against an in-memory sheet. Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFakeGas, loadBackend, sha256Bytes, SAMPLE_BOTTLES } = require('../dev/fake-gas.js');

const CODE = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');
const PASSKEY = 'test-passkey';

function freshCellar() {
  const gas = createFakeGas();
  const backend = loadBackend(gas, CODE);
  backend.setup(SAMPLE_BOTTLES);
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
  assert.equal(res.consumed.length, 1);
  assert.equal(res.consumed[0].producer, 'Penfolds');
  assert.equal(gas._spreadsheet.getSheetByName('Sheet1'), null, 'blank Sheet1 is removed');
  assert.throws(() => backend.setup(SAMPLE_BOTTLES), /already have bottles/);
  backend.setup();  // as run from the editor: safe again, adds nothing
  assert.equal(ok('list').cellar.length, 5);
});

test('setup on a new sheet creates empty tabs, with no sample bottles', () => {
  const gas = createFakeGas();
  const backend = loadBackend(gas, CODE);
  backend.setup();
  const res = backend.handle_({ action: 'list' });
  assert.equal(res.ok, true);
  assert.deepEqual([res.cellar.length, res.consumed.length], [0, 0]);
  assert.ok(gas._spreadsheet.getSheetByName('Lists') && gas._spreadsheet.getSheetByName('Settings'));
  assert.doesNotMatch(CODE, /Leflaive|Coudray-Bizot|A F Gros|STARTER_BOTTLES/, 'no sample bottles left in Code.gs');
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
  ok('update', { id: before.consumed[0].id, wine: { hidden: true } });
  const pub = friend('list');
  assert.equal(pub.ok, true);
  assert.equal(pub.owner, false);
  assert.equal(pub.cellar.length, 4);
  assert.equal(pub.consumed.length, 0);
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
  const res = ok('drink', { id: jadot.id, drink: { consumedOn: '2026-12-01', rating: 8.5, notes: 'Opened up after an hour' } });
  assert.equal(res.result.left, 1);
  assert.equal(byName(res.cellar, 'Jadot')[0].bottles, 1);
  const drunk = byName(res.consumed, 'Jadot');
  assert.equal(drunk.length, 1);
  assert.equal(drunk[0].consumedOn, '2026-12-01');
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
  assert.equal(byName(res.consumed, 'Leflaive').length, 1);
  assert.equal(tab('Cellar').getLastRow(), 1 + 4, 'the row is gone from the sheet, not just hidden');
  assert.match(byName(res.consumed, 'Leflaive')[0].consumedOn, /^\d{4}-\d{2}-\d{2}$/, 'defaults to today');
});

test('drinking several bottles at once writes one Drunk row per bottle', () => {
  const { ok, byName } = freshCellar();
  const res1 = ok('create', { wine: { producer: 'Duroche', wine: 'Vosne-Romanée', vintage: 2018, bottles: 2 } });
  const id = byName(res1.cellar, 'Duroche')[0].id;
  const res = ok('drink', { id, drink: { count: 3 } });
  assert.equal(byName(res.consumed, 'Duroche').length, 3);
  assert.equal(byName(res.cellar, 'Duroche').length, 0);
});

test("you can't drink more bottles than you have, or drink from the Drunk tab", () => {
  const { ok, owner } = freshCellar();
  const list = ok('list');
  const tooMany = owner('drink', { id: list.cellar[0].id, drink: { count: 2 } });
  assert.match(tooMany.error, /only 1 bottle/);
  const twice = owner('drink', { id: list.consumed[0].id, drink: {} });
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
  assert.match(owner('update', { id: ok('list').consumed[0].id, wine: { rating: 11 } }).error, /Rating must be/);
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
  const res = ok('remove', { id: list.consumed[0].id });
  assert.equal(res.cellar.length, 4);
  assert.equal(res.consumed.length, 0);
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

// A cellar with the bot set up. `say` sends a chat message, `tap` presses a button.
// Each goes through pollTelegram, the way real messages arrive.
function freshBot() {
  const c = freshCellar();
  c.gas.PropertiesService.getScriptProperties().setProperties({ TELEGRAM_TOKEN: '123:abc', TELEGRAM_CHAT_ID: CHAT });
  let updateId = 100;
  const post = update => {
    c.gas._replies.getUpdates = p => ({ ok: true, result: update.update_id >= p.offset ? [update] : [] });
    c.gas._fetches.length = 0;
    c.backend.pollTelegram();
    return c.gas._fetches.filter(f => f.method !== 'getUpdates');
  };
  const say = (text, chat = CHAT) => post({ update_id: ++updateId, message: { message_id: 1, chat: { id: Number(chat) }, text } });
  const tap = data => post({ update_id: ++updateId, callback_query: { id: 'cb', data, message: { message_id: 7, chat: { id: Number(CHAT) } } } });
  const sent = calls => calls.filter(f => f.method === 'sendMessage' || f.method === 'editMessageText').map(f => f.payload.text).join('\n');
  const buttons = calls => calls.filter(f => f.payload.reply_markup).flatMap(f => f.payload.reply_markup.inline_keyboard.flat());
  return Object.assign(c, { post, say, tap, sent, buttons });
}

test('the bot ignores other chats and never answers an update twice', () => {
  const { post, say, ok, backend } = freshBot();
  assert.equal(say('/cellar', '999').length, 0);
  const update = { update_id: 500, message: { chat: { id: Number(CHAT) }, text: '/cellar' } };
  assert.ok(post(update).length > 0);
  assert.equal(backend.handleTelegram_(update), false, 'the same update again is ignored');
  assert.equal(ok('list').cellar.length, 5);
});

test('page requests get the lists, settings and build with every response', () => {
  const { backend, gas } = freshBot();
  const res = JSON.parse(backend.doPost({ postData: { contents: '{"action":"list"}' } }).getContent());
  assert.equal(res.ok, true);
  assert.equal(res.build, backend.BUILD);
  assert.deepEqual(res.lists.colours[0], { name: 'Sparkling', tone: 'white' });
  assert.equal(res.settings.currency, 'S$');
  assert.equal(gas._fetches.length, 0, 'no Telegram calls');
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
  assert.match(sent(say('/stats')), /<b>4<\/b> in the cellar\n<b>1<\/b> to collect\n<b>1<\/b> consumed\n<b>S\$809<\/b> on the shelf/);
  assert.match(sent(say('/collect')), /A F Gros[\s\S]*Grand Cru, collect Fri 27 Nov/);
  assert.match(sent(say('/help')), /\/opened/);
  assert.doesNotMatch(sent(say('/help')), /\/drank/, 'the old name works but is not advertised');
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
  assert.match(sent(done), /Opened .*Duroche[\s\S]*That was the last one/);
  const res = ok('list');
  assert.equal(byName(res.cellar, 'Duroche').length, 0);
  assert.equal(byName(res.consumed, 'Duroche').length, 1);
  assert.match(sent(tap(btns[0].callback_data)), /no longer in the cellar/, 'a second tap is refused');
  assert.match(sent(say('/drank nothing-like-this')), /Nothing matches/);
});

test('a failed tap acknowledgement still replaces the buttons, so a bottle is never drunk twice', () => {
  const { say, tap, sent, buttons, gas } = freshBot();
  const btn = buttons(say('/drank jadot'))[0];
  gas._replies.answerCallbackQuery = () => ({ ok: false, description: 'query is too old' });
  assert.match(sent(tap(btn.callback_data)), /Opened .*Jadot/);
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

test('installTelegram turns off any webhook and sets one poll timer and one daily reminder timer', () => {
  const { backend, gas } = freshBot();
  backend.installTelegram();
  backend.installTelegram();  // running it twice doesn't double the timers
  assert.deepEqual(gas._fetches.find(f => f.method === 'deleteWebhook').payload, { drop_pending_updates: true });
  assert.ok(!gas._fetches.some(f => f.method === 'setWebhook'));
  assert.deepEqual(gas._triggers.map(t => [t.fn, t.schedule]),
    [['pollTelegram', { everyMinutes: 1 }], ['sendReminders', { everyHours: 1 }]]);
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
  assert.match(sent(gas._fetches), /\/opened/);
  gas._fetches.length = 0;
  backend.pollTelegram();
  assert.deepEqual(offsets.slice(-1), [902], 'both updates are marked done');
  assert.equal(sent(gas._fetches), '', 'nothing is answered twice');
});

test('relayed updates are answered only with the relay secret', () => {
  const { backend, gas, sent } = freshBot();
  const relay = (update, relayKey) => {
    gas._fetches.length = 0;
    const res = JSON.parse(backend.doPost({ postData: { contents: JSON.stringify({ telegram: update, relayKey }) } }).getContent());
    return { ok: res.ok, calls: gas._fetches.slice() };
  };
  const msg = id => ({ update_id: id, message: { message_id: 1, chat: { id: Number(CHAT) }, text: '/help' } });
  assert.equal(relay(msg(1), 'anything').calls.length, 0, 'no relay secret set yet');
  const secret = backend.relaySecret();
  assert.equal(backend.relaySecret(), secret, 'running it again shows the same secret');
  assert.equal(relay(msg(2), 'wrong').calls.length, 0);
  const good = relay(msg(3), secret);
  assert.equal(good.ok, true);
  assert.match(sent(good.calls), /\/opened/);
  assert.equal(relay(msg(3), secret).calls.length, 0, 'a repeat is ignored');
});

test('relayed updates that arrive out of order are both answered', () => {
  const { backend, gas } = freshBot();
  const secret = backend.relaySecret();
  const relay = id => backend.doPost({ postData: { contents: JSON.stringify({ relayKey: secret,
    telegram: { update_id: id, message: { message_id: id, chat: { id: Number(CHAT) }, text: '/stats' } } }) } });
  relay(202);
  relay(201);
  assert.equal(gas._fetches.filter(f => f.method === 'sendMessage').length, 2);
});

test('installTelegramRelay points Telegram at the Worker with the secret and stops polling', () => {
  const { backend, gas } = freshBot();
  backend.installTelegram();
  assert.throws(() => backend.installTelegramRelay_('https://cellar-relay.me.workers.dev'), /relaySecret\(\) first/);
  const secret = backend.relaySecret();
  assert.throws(() => backend.installTelegramRelay_('http://cellar-relay.me.workers.dev'), /https/);
  gas.PropertiesService.getScriptProperties().setProperties({ TELEGRAM_URL: 'old', TELEGRAM_SECRET: 'old', TG_LAST_UPDATE: '5' });
  gas._fetches.length = 0;
  backend.installTelegramRelay_('https://cellar-relay.me.workers.dev');
  const hook = gas._fetches.find(f => f.method === 'setWebhook').payload;
  assert.equal(hook.url, 'https://cellar-relay.me.workers.dev');
  assert.equal(hook.secret_token, secret);
  assert.ok(/^[A-Za-z0-9_-]{1,256}$/.test(secret), 'Telegram accepts the secret format');
  assert.deepEqual(gas._triggers.map(t => [t.fn, t.schedule]), [['sendReminders', { everyHours: 1 }]]);
  const left = gas.PropertiesService.getScriptProperties().getKeys();
  for (const k of ['TELEGRAM_URL', 'TELEGRAM_SECRET', 'TG_LAST_UPDATE']) assert.ok(!left.includes(k), k + ' is cleaned up');
  backend.installTelegramRelay_('https://relay.example.com/telegram');  // any https address, e.g. a custom domain
});

test('the Cloudflare Worker checks the secret, answers at once, and passes the update on', async () => {
  const { default: worker } = await import('../relay/worker.mjs');
  const env = { RELAY_SECRET: 's3cret', APPS_SCRIPT_URL: 'https://script.google.com/macros/s/abc/exec' };
  assert.equal((await worker.fetch(new Request('https://relay.test/'), { RELAY_SECRET: 's3cret' }, {})).status, 500,
    'a missing APPS_SCRIPT_URL is reported, not silently ignored');
  const forwarded = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { forwarded.push({ url, body: JSON.parse(init.body) }); return new Response('{}'); };
  try {
    const waits = [];
    const ctx = { waitUntil: p => waits.push(p) };
    const post = (secret, body = '{"update_id":5}') => worker.fetch(new Request('https://relay.test/', {
      method: 'POST', body, headers: secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {},
    }), env, ctx);

    assert.equal((await worker.fetch(new Request('https://relay.test/'), env, ctx)).status, 200, 'a browser visit just says it is running');
    assert.equal((await post(null)).status, 403);
    assert.equal((await post('wrong')).status, 403);
    assert.equal((await post('s3cret', 'not json')).status, 400);
    assert.equal(forwarded.length, 0);

    const res = await post('s3cret');
    assert.equal(res.status, 200);
    await Promise.all(waits);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].url, env.APPS_SCRIPT_URL);
    assert.deepEqual(forwarded[0].body, { telegram: { update_id: 5 }, relayKey: 's3cret' });
  } finally {
    globalThis.fetch = realFetch;
  }
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
  assert.equal('collectBy' in res.consumed.at(-1), false);
  const drunk = tab('Consumed');
  assert.ok(!drunk.getRange(1, 1, 1, drunk.getLastColumn()).getDisplayValues()[0].includes('collectBy'));
});

/* ============================== Lists and Settings tabs ============================== */

const setSetting = (tab, key, value) => { tab('Settings').rows.find(r => r[0] === key)[1] = value; };

test('migrate creates the Lists, Settings and Reminders log tabs, and never overwrites them', () => {
  const { backend, tab, ok } = freshCellar();
  assert.deepEqual(tab('Lists').rows[0], ['colour', 'colourTone', 'grape', 'storage']);
  assert.deepEqual(tab('Lists').rows[1].slice(0, 3), ['Sparkling', 'white', 'Pinot Noir']);
  assert.deepEqual(tab('Settings').rows.slice(1).map(r => r[0]), ['currency', 'reminderHour', 'closeReminderMonths', 'nudgeDay']);
  assert.equal(tab('Reminders log').hidden, true, 'the log tab is hidden');

  tab('Lists').rows.push(['Orange', 'white', '', '']);
  setSetting(tab, 'currency', '€');
  backend.migrate();
  assert.deepEqual(tab('Lists').rows.at(-1).slice(0, 2), ['Orange', 'white'], 'your rows are kept');
  const res = ok('list');
  assert.equal(res.settings.currency, '€');
  assert.deepEqual(res.lists.colours.at(-1), { name: 'Orange', tone: 'white' });
});

test('migrate renames an old "Drunk" tab and its drunkOn column to Consumed, keeping every row', () => {
  const { backend, gas, ok } = freshCellar();
  const jadot = ok('list').cellar.find(w => w.producer === 'Jadot');
  ok('drink', { id: jadot.id, drink: { consumedOn: '2026-10-01', rating: 9 } });
  const sheet = gas._spreadsheet.getSheetByName('Consumed');
  sheet.setName('Drunk');  // make it look like an older sheet
  const at = sheet.rows[0].indexOf('consumedOn');
  sheet.rows[0][at] = 'drunkOn';
  assert.match(backend.handle_({ action: 'list' }).error, /No "Consumed" tab/, 'new code on an old sheet needs migrate()');

  backend.migrate();
  assert.equal(gas._spreadsheet.getSheetByName('Drunk'), null);
  assert.equal(gas._spreadsheet.getSheetByName('Consumed'), sheet, 'same tab, renamed');
  assert.equal(sheet.rows[0][at], 'consumedOn', 'same column, renamed');
  assert.equal(sheet.rows[0].filter(h => /On$/.test(h) && h !== 'consumedOn').length, 0, 'no extra column added');
  const res = ok('list');
  assert.equal(res.consumed.length, 2);
  const opened = res.consumed.find(w => w.producer === 'Jadot');
  assert.deepEqual([opened.consumedOn, opened.rating], ['2026-10-01', 9]);
  backend.migrate();  // running it again changes nothing
  assert.equal(ok('list').consumed.length, 2);
});

test('colour, grape and storage are saved in the Lists spelling; values not in a list are kept', () => {
  const { ok, tab } = freshCellar();
  tab('Lists').rows.push(['Orange', 'Rosé', '', "Friend's fridge"]);
  const res = ok('create', { wine: { producer: 'Gravner', wine: 'Ribolla', colour: ' orange', grape: 'pinot  noir', storage: "FRIEND'S FRIDGE" } });
  const w = res.cellar.find(x => x.producer === 'Gravner');
  assert.deepEqual([w.colour, w.grape, w.storage], ['Orange', 'Pinot Noir', "Friend's fridge"]);
  assert.equal(res.lists.colours.at(-1).tone, 'rose', '"Rosé" in the tone column means rose');
  assert.deepEqual(res.lists.storage, ["Friend's fridge"]);
  const other = ok('create', { wine: { producer: 'Radikon', wine: 'Jakot', colour: 'Amber', grape: 'Tocai Friulano' } })
    .cellar.find(x => x.producer === 'Radikon');
  assert.deepEqual([other.colour, other.grape], ['Amber', 'Tocai Friulano']);
});

test('prices accept any currency in front, and "-" storage reads as blank', () => {
  const { ok } = freshCellar();
  const price = p => ok('create', { wine: { producer: 'P' + p, wine: 'W', price: p } }).cellar.find(w => w.producer === 'P' + p).price;
  assert.equal(price('€ 1,250'), 1250);
  assert.equal(price('$45.50'), 45.5);
  assert.equal(price('USD 80'), 80);
  assert.equal(ok('list').cellar.find(w => w.producer === 'Jadot').storage, null, 'the sample bottles use "-"');
});

test('Settings drive the currency and reminder timing; bad values fall back and status() says so', () => {
  const { backend, tab, ok, say, sent } = freshBot();
  setSetting(tab, 'currency', '€');
  setSetting(tab, 'closeReminderMonths', '3');
  setSetting(tab, 'nudgeDay', 'tuesday');
  setSetting(tab, 'reminderHour', '25');
  const s = ok('list').settings;
  assert.deepEqual(s, { currency: '€', reminderHour: 9, closeReminderMonths: 3, nudgeDay: 'Tuesday' });
  assert.match(sent(say('/stats')), /€809/);

  const keys = (recs, today) => backend.remindersDue_(recs, today, {}, s).map(r => r.key);
  assert.deepEqual(keys([W()], '2033-09-30'), []);
  assert.deepEqual(keys([W()], '2033-10-01'), ['w1|close|2033'], '3 months before the end of 2033');
  const tc = W({ window: '', status: 'To collect' });
  assert.deepEqual(keys([tc], '2026-11-23'), [], 'not Monday any more');
  assert.deepEqual(keys([tc], '2026-11-24'), ['w1|nudge|2026-11-24'], 'Tuesday');
  assert.deepEqual(backend.remindersDue_([W()], '2033-12-01', {}, { ...s, closeReminderMonths: 0 }).length, 0, '0 turns it off');
  assert.match(backend.status().join('\n'), /reminderHour "25" isn't valid, so 9 is used/);
});

test('the hourly timer sends once a day, from the reminder hour', () => {
  const { backend, gas, ok } = freshBot();
  const gros = ok('list').cellar.find(w => w.producer === 'A F Gros');
  ok('update', { id: gros.id, wine: { collectBy: '2026-11-27' } });
  gas._fetches.length = 0;
  assert.equal(backend.sendReminders_('2026-11-26', 8), 0, 'before 9am');
  assert.equal(gas._fetches.length, 0);
  assert.equal(backend.sendReminders_('2026-11-26', 9), 1);
  assert.equal(backend.sendReminders_('2026-11-26', 10), 0, 'not again that day');
  assert.equal(gas._fetches.filter(f => f.method === 'sendMessage').length, 1);
});

test('the reminder log is a sheet tab, so hundreds of bottles are fine; an old property is moved across', () => {
  const { backend, gas, ok, tab } = freshBot();
  const props = gas.PropertiesService.getScriptProperties();
  const jadot = ok('list').cellar.find(w => w.producer === 'Jadot');
  props.setProperties({ REMINDERS_SENT: JSON.stringify({ [jadot.id + '|open|2023']: '2026-12-31' }) });
  for (let i = 0; i < 300; i++) ok('create', { wine: { producer: 'Producer ' + i, wine: 'Cuvée', vintage: 2020, window: '2027–2035' } });

  const sentCount = backend.sendReminders_('2027-01-01');
  assert.ok(sentCount >= 301, 'every bottle opening in 2027 is reminded');
  assert.equal(props.getProperty('REMINDERS_SENT'), null, 'the old property is gone');
  const logged = tab('Reminders log').rows.slice(1).map(r => r[0]);
  assert.ok(logged.includes(jadot.id + '|open|2023'), 'and its contents were kept');
  assert.ok(logged.length > 300);
  gas._fetches.length = 0;
  assert.equal(backend.sendReminders_('2027-01-01'), 0, 'nothing repeats');
});

/* ============================== Reads, rows and locks ============================== */

test('a request reads each tab once, and again only after writing to it', () => {
  const { ok, gas } = freshCellar();
  const reads = () => { const r = { ...gas._reads }; for (const k of Object.keys(gas._reads)) delete gas._reads[k]; return r; };
  reads();
  ok('list');
  assert.deepEqual(reads(), { Cellar: 1, Consumed: 1, Lists: 1, Settings: 1 });
  const drunkId = ok('list').consumed[0].id;
  reads();
  ok('update', { id: drunkId, wine: { rating: 9 } });
  const r = reads();
  assert.equal(r.Cellar, 1, 'Cellar is read once, though it is searched and then sent back');
  assert.equal(r.Consumed, 3, 'Consumed: the read, the row check before writing, and the fresh copy sent back');
});

test('locked writes never use a copy of the sheet read before the lock', () => {
  const { backend, tab, ok } = freshCellar();
  const jadot = ok('list').cellar.find(w => w.producer === 'Jadot');
  const t = backend.table_('Cellar');  // read and cached, as a Telegram button lookup does
  backend.readRows_(t);
  const sheet = tab('Cellar');
  const row = sheet.rows.find(r => r[t.col.id] === jadot.id);
  row[t.col.bottles] = '5';  // meanwhile another request (or a hand edit) changes the count
  const res = backend.withLock_(() => backend.adjustBottles_(jadot.id, 1));
  assert.equal(res.bottles, 6, 'builds on the sheet as it is now, not the cached 1');
});

test('a save lands on the right bottle even if the sheet is sorted by hand meanwhile', () => {
  const { backend, tab, ok } = freshCellar();
  const t = backend.table_('Cellar');
  const jadot = backend.readRows_(t).find(r => r.rec.producer === 'Jadot');
  const sheet = tab('Cellar');
  sheet.rows = [sheet.rows[0], ...sheet.rows.slice(1).reverse()];  // someone sorts the tab
  backend.writeRow_(t, jadot.row, backend.encode_(t, { ...jadot.rec, price: 999 }, jadot.cells));
  const list = ok('list').cellar;
  assert.equal(list.find(w => w.producer === 'Jadot').price, 999);
  assert.equal(list.filter(w => w.price === 999).length, 1, 'no other bottle was overwritten');

  const t2 = backend.table_('Cellar');
  const duroche = backend.readRows_(t2).find(r => r.rec.producer === 'Duroche');
  sheet.rows = sheet.rows.filter(r => r[t2.col.producer] !== 'Duroche');  // someone deletes the row
  assert.throws(() => backend.writeRow_(t2, duroche.row, duroche.cells), /sheet changed while saving/);
});

test('wrong passkeys lock out only that device, with a backstop across all devices', () => {
  const { backend } = freshCellar();
  const login = (key, device) => backend.handle_({ action: 'login', key, device });
  for (let i = 0; i < 8; i++) assert.equal(login('wrong', 'attacker-device-1').auth, false);
  assert.match(login(PASSKEY, 'attacker-device-1').error, /Too many wrong passkeys/);
  assert.equal(login(PASSKEY, 'owner-phone-0001').ok, true, 'the owner is not locked out');
  for (let d = 0; d < 40; d++) login('wrong', 'random-device-' + d);
  assert.match(login(PASSKEY, 'owner-phone-0001').error, /Too many/, 'many devices at once still trip the backstop');
});

test('status() checks the deployed build, hides secrets and lists timers', () => {
  const { backend, gas } = freshBot();
  backend.installTelegram();
  gas._replies.exec = () => ({ ok: true, build: 'older-build' });
  const out = backend.status().join('\n');
  assert.match(out, /Web app: running build older-build\. Deploy → Manage deployments/);
  assert.match(out, /TELEGRAM_TOKEN = \(set, hidden\)/);
  assert.match(out, /PASS_HASH = \(set, hidden\)/);
  assert.doesNotMatch(out, /123:abc/, 'the token never appears');
  assert.match(out, /Timers: pollTelegram, sendReminders/);
  assert.match(out, /Time zone: Asia\/Singapore/);
  gas._replies.exec = () => ({ ok: true, build: backend.BUILD });
  assert.match(backend.status().join('\n'), /Web app: running this build/);
  gas._replies.exec = () => ({ ok: true });
  assert.match(backend.status().join('\n'), /Web app: running an older version/, 'the cellar\'s data without a build');
  gas._replies.exec = () => 'not json';
  assert.match(backend.status().join('\n'), /Web app: couldn't check/, 'no false "redeploy" when the answer isn\'t the cellar');
  gas._service.url = 'https://script.google.com/macros/s/x/dev';
  gas._replies.exec = undefined;
  gas._replies.dev = () => ({ ok: true, build: 'whatever' });
  assert.match(backend.status().join('\n'), /Web app: couldn't check/, 'a /dev URL is the test version, not the deployment');
});
