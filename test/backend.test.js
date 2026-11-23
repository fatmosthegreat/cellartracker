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
  const res = ok('create', { wine: { producer: 'Jadot', wine: 'Gevrey-Chambertin', vintage: 2018, status: 'On order' } });
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

test('guests: let in by addTelegramGuest, look-ups only, hidden bottles stay hidden', () => {
  const { say, sent, ok, backend, gas } = freshBot();
  const GUEST = '777';
  assert.throws(() => backend.addTelegramGuest(), /Nobody new/);
  const hiddenOne = ok('list').cellar.find(w => w.status === 'In cellar');
  ok('update', { id: hiddenOne.id, wine: { hidden: true } });

  // A stranger is ignored but noted, then let in.
  gas._fetches.length = 0;
  const knock = { update_id: 900, message: { message_id: 1, chat: { id: Number(GUEST), first_name: 'Sam' }, text: 'hi' } };
  assert.equal(backend.handleTelegram_(knock), false);
  assert.equal(gas._fetches.length, 0, 'strangers get no answer');
  backend.addTelegramGuest();
  const welcome = gas._fetches.find(f => f.method === 'sendMessage');
  assert.equal(String(welcome.payload.chat_id), GUEST);
  const menus = gas._fetches.filter(f => f.method === 'setMyCommands');
  assert.ok(!menus[0].payload.commands.some(c => c.command === 'opened'), 'the default menu has no change commands');
  assert.equal(String(menus[1].payload.scope.chat_id), CHAT);
  assert.ok(menus[1].payload.commands.some(c => c.command === 'opened'), 'your menu has them');

  // Replies go to the guest's chat, without the hidden bottle.
  const calls = say('/cellar', GUEST);
  assert.ok(calls.every(f => String(f.payload.chat_id) === GUEST));
  const guestList = sent(calls);
  assert.ok(!guestList.includes(hiddenOne.wine), 'hidden bottle not listed for a guest');
  assert.ok(sent(say('/cellar')).includes(hiddenOne.wine), 'you still see it');
  assert.match(sent(say(hiddenOne.producer + ' ' + hiddenOne.wine, GUEST)), /^Nothing in the cellar matches/, 'or found by search');
  assert.doesNotMatch(sent(say('/stats', GUEST)), /S\$809/, 'its price is left out of the value');
  assert.match(sent(say('/stats')), /S\$809/);

  // No changes, no buttons.
  for (const cmd of ['/opened', '/arrived', '/add1']) {
    assert.match(sent(say(cmd, GUEST)), /Only the owner/);
  }
  const help = sent(say('/help', GUEST));
  assert.doesNotMatch(help, /\/opened|Reminders/);
  assert.match(help, /\/cellar/);
  const before = ok('list').cellar.length;
  const tapped = backend.handleTelegram_({ update_id: 950, callback_query: { id: 'cb', data: 'drink:' + hiddenOne.id, message: { message_id: 3, chat: { id: Number(GUEST) } } } });
  assert.equal(tapped, true);
  assert.equal(ok('list').cellar.length, before, 'a forged button tap changes nothing');

  // A one-off message reaches the guest, with a copy to you.
  assert.throws(() => backend.messageGuests(), /Type your message/);
  gas._fetches.length = 0;
  assert.deepEqual(backend.messageGuests_('Dinner on <b>Friday</b>?'), ['Sam']);
  const out = gas._fetches.filter(f => f.method === 'sendMessage');
  assert.deepEqual(out.map(f => String(f.payload.chat_id)), [GUEST, CHAT]);
  assert.equal(out[0].payload.text, 'Dinner on <b>Friday</b>?');
  assert.match(out[1].payload.text, /Sent to Sam/);

  backend.removeTelegramGuests();
  assert.equal(say('/cellar', GUEST).length, 0, 'removed guests are ignored again');
  assert.throws(() => backend.messageGuests_('hi'), /no guests/);
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
  assert.match(text, /On order<\/b> · 1 bottle/);
  for (const w of ok('list').cellar) assert.ok(text.includes(w.producer), w.producer);

  const found = sent(say('romanee duroche'));
  assert.match(found, /Duroche/);
  assert.doesNotMatch(found, /Coudray/);
  assert.match(sent(say('/search@TheCellar_bot ROMANÉE')), /Coudray-Bizot/);
  assert.match(sent(say('/search nothing-like-this')), /Nothing in the cellar matches/);
  assert.match(sent(say('/explode')), /I don't know \/explode/);
});

test('/stats, /onorder and /help answer', () => {
  const { say, sent } = freshBot();
  assert.match(sent(say('/stats')), /<b>4<\/b> in the cellar\n<b>1<\/b> on order\n<b>1<\/b> consumed\n<b>S\$809<\/b> on the shelf/);
  assert.match(sent(say('/onorder')), /A F Gros[\s\S]*Grand Cru, collect Fri 27 Nov/);
  assert.match(sent(say('/help')), /\/opened[\s\S]*Tips[\s\S]*price 150/);
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

test('/opened shows buttons, asks before opening, and Yes drinks it exactly like the website', () => {
  const { say, tap, sent, buttons, ok, byName } = freshBot();
  const btns = buttons(say('/opened duroche'));
  assert.equal(btns.length, 1);
  assert.match(btns[0].text, /2018 Duroche Vosne-Romanée/);

  // The first tap only asks; Cancel changes nothing.
  const asked = tap(btns[0].callback_data);
  assert.ok(asked.some(f => f.method === 'answerCallbackQuery'));
  assert.match(sent(asked), /Open .*Duroche.*\?/);
  const [yes, cancel] = buttons(asked);
  assert.equal(ok('list').cellar.length, 5, 'nothing opened yet');
  assert.match(sent(tap(cancel.callback_data)), /Nothing changed/);
  assert.equal(byName(ok('list').cellar, 'Duroche').length, 1);

  const done = tap(yes.callback_data);
  assert.match(sent(done), /Opened .*Duroche[\s\S]*That was the last one/);
  const res = ok('list');
  assert.equal(byName(res.cellar, 'Duroche').length, 0);
  assert.equal(byName(res.consumed, 'Duroche').length, 1);
  assert.match(sent(tap(yes.callback_data)), /no longer in the cellar/, 'a second tap is refused');
  assert.match(sent(say('/opened nothing-like-this')), /Nothing matches/);
});

test('a failed tap acknowledgement still replaces the buttons, so a bottle is never drunk twice', () => {
  const { say, tap, sent, buttons, gas } = freshBot();
  const btn = buttons(say('/opened jadot'))[0];
  gas._replies.answerCallbackQuery = () => ({ ok: false, description: 'query is too old' });
  const yes = buttons(tap(btn.callback_data))[0];
  assert.match(sent(tap(yes.callback_data)), /Opened .*Jadot/);
});

test('/arrived and /add1 change status and count', () => {
  const { say, tap, buttons, ok, byName } = freshBot();
  const coll = buttons(say('/arrived'));
  assert.equal(coll.length, 1, 'only bottles on order');
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
  gas.PropertiesService.getScriptProperties().setProperties({ TG_LAST_UPDATE: '5' });
  gas._fetches.length = 0;
  backend.installTelegramRelay_('https://cellar-relay.me.workers.dev');
  const hook = gas._fetches.find(f => f.method === 'setWebhook').payload;
  assert.equal(hook.url, 'https://cellar-relay.me.workers.dev');
  assert.equal(hook.secret_token, secret);
  assert.ok(/^[A-Za-z0-9_-]{1,256}$/.test(secret), 'Telegram accepts the secret format');
  assert.deepEqual(gas._triggers.map(t => [t.fn, t.schedule]), [['sendReminders', { everyHours: 1 }]]);
  const left = gas.PropertiesService.getScriptProperties().getKeys();
  assert.ok(!left.includes('TG_LAST_UPDATE'), 'polling\'s bookmark is cleaned up');
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

/* ---------- Label photos ---------- */

// A bot that reads labels, with canned answers from Claude and Telegram.
// `label` and `fixed` are what Claude answers to a label and to a fix.
function labelBot({ keys = true } = {}) {
  const c = freshBot();
  if (keys) c.gas.PropertiesService.getScriptProperties().setProperties({ ANTHROPIC_API_KEY: 'sk-ant-test' });
  let messageId = 50;
  let updateId = 1000;
  c.gas._replies.sendMessage = () => ({ ok: true, result: { message_id: ++messageId } });
  c.gas._replies.getFile = () => ({ ok: true, result: { file_path: 'photos/file_1.jpg' } });
  c.answers = {
    label: { readable: true, producer: 'Domaine Duroché', wine: 'Gevrey-Chambertin 1er Cru', cuvee: 'Lavaut St-Jacques',
      vintage: '2019', colour: 'Red', grape: 'Pinot Noir' },
  };
  c.gas._replies.anthropic = p => {
    const reply = Array.isArray(p.messages[0].content) ? c.answers.label : c.answers.fixed;
    return { content: [{ type: 'text', text: JSON.stringify(reply) }], stop_reason: 'end_turn', usage: { input_tokens: 1 } };
  };
  const from = chat => ({ message_id: ++messageId, chat: { id: Number(chat || CHAT) } });
  c.photo = (caption, chat) => c.post({ update_id: ++updateId, message: { ...from(chat), caption,
    photo: [{ file_id: 'small', width: 90, height: 120 }, { file_id: 'big', width: 960, height: 1280 }] } });
  c.reply = (to, text) => c.post({ update_id: ++updateId, message: { ...from(), text, reply_to_message: { message_id: to } } });
  c.press = (data, onMessage, chat) => c.post({ update_id: ++updateId,
    callback_query: { id: 'cb', data, message: { message_id: onMessage, chat: { id: Number(chat || CHAT) } } } });
  c.calls = (calls, method) => calls.filter(f => f.method === method);
  c.lastMessageId = () => messageId;
  // The draft's buttons by action, as { Add: 'lbl:ok:…', … }, their labels, and the id of the
  // message they sit on.
  const ACTION = { ok: 'Add', fix: 'Fix', retry: 'Retry', no: 'Cancel', collect: 'Collect', deliver: 'Delivery' };
  c.draft = calls => {
    const shown = calls.filter(f => f.payload.reply_markup && f.payload.reply_markup.inline_keyboard).at(-1);
    const map = {};
    const labels = {};
    shown.payload.reply_markup.inline_keyboard.flat().forEach(b => {
      const name = ACTION[b.callback_data.split(':')[1]];
      map[name] = b.callback_data;
      labels[name] = b.text;
    });
    return { buttons: map, labels, text: shown.payload.text, messageId: shown.payload.message_id || messageId };
  };
  return c;
}

test('a label photo becomes a draft with one Claude call, and ✅ Add puts it in the cellar', () => {
  const c = labelBot();
  const calls = c.photo('Bought at Wine Co');
  assert.match(c.sent(calls), /Reading the label/);

  const reads = c.calls(calls, 'anthropic');
  assert.equal(reads.length, 1, 'only the label is read: no web search');
  const read = reads[0];
  assert.equal(read.payload.model, 'claude-haiku-5-5', 'Haiku reads labels first');
  assert.equal(read.payload.fallbacks, undefined, 'Haiku has no refusal fallback');
  assert.equal(read.headers['anthropic-beta'], undefined);
  assert.equal(read.payload.tools, undefined);
  assert.equal(read.headers['x-api-key'], 'sk-ant-test');
  assert.equal(read.payload.messages[0].content[0].type, 'image');
  assert.equal(read.payload.messages[0].content[0].source.data, '/9j/4A==', 'the photo is sent as base64');
  assert.match(read.payload.messages[0].content[1].text, /Bought at Wine Co/);
  assert.deepEqual(read.payload.output_config.format.schema.properties.colour.enum.slice(0, 2), ['Sparkling', 'White'], 'colours come from the Lists tab');
  assert.equal(c.calls(calls, 'getFile')[0].payload.file_id, 'big');

  const draft = c.draft(calls);
  assert.match(draft.text, /2019<\/b> Domaine Duroché · <i>Gevrey-Chambertin 1er Cru · Lavaut St-Jacques/);
  assert.match(draft.text, /No drinking window yet[\s\S]*Reply to this message with the drinking window/);
  assert.deepEqual(Object.keys(draft.buttons), ['Add', 'Fix', 'Collect', 'Delivery', 'Retry', 'Cancel']);
  assert.equal(draft.labels.Retry, '🔁 Retry with Sonnet');
  assert.equal(c.ok('list').cellar.length, 5, 'nothing is added before you tap');

  // Typing the window is free: no Claude call.
  const typed = c.reply(draft.messageId, '2027-2040');
  assert.equal(c.calls(typed, 'anthropic').length, 0);
  const withWindow = c.draft(typed);
  assert.match(withWindow.text, /Drink 2027–2040/);

  assert.match(c.sent(c.press(withWindow.buttons.Add, withWindow.messageId)), /Added .*Duroché/);
  const added = c.byName(c.ok('list').cellar, 'Domaine Duroché')[0];
  assert.equal(added.wine, 'Gevrey-Chambertin 1er Cru · Lavaut St-Jacques');
  assert.equal(added.vintage, 2019);
  assert.equal(added.window, '2027–2040');
  assert.equal(added.colour, 'Red');
  assert.equal(added.notes, 'Bought at Wine Co');
  assert.match(c.sent(c.press(withWindow.buttons.Add, withWindow.messageId)), /expired/, 'a draft is added once only');

  // The same wine again, added without a window, adds a bottle to the row you have.
  const again = c.draft(c.photo('Bought at Wine Co'));
  assert.match(c.sent(c.press(again.buttons.Add, again.messageId)), /now ×2/);
  assert.equal(c.byName(c.ok('list').cellar, 'Domaine Duroché').length, 1);
});

test('changes to a draft are parsed in code, never sent to Claude; Retry keeps the window', () => {
  const c = labelBot();
  const first = c.draft(c.photo());

  // "field value" with a space works, and the old draft message is deleted, not left behind.
  const calls = c.reply(first.messageId, 'vintage 2018');
  assert.equal(c.calls(calls, 'anthropic').length, 0);
  assert.equal(c.calls(calls, 'deleteMessage')[0].payload.message_id, first.messageId);
  const fixed = c.draft(calls);
  assert.match(fixed.text, /<b>2018<\/b>/);

  // Several fields in one message, separated by commas or " / ", with friendly names.
  const many = c.draft(c.reply(fixed.messageId, 'price 150, drinking window 2026-2034 / color white'));
  assert.match(many.text, /<b>2018<\/b>[\s\S]*White · Pinot Noir\nDrink 2026–2034\nPrice S\$150/);
  // A comma that isn't followed by a field stays in the value.
  const noted = c.draft(c.reply(many.messageId, 'note: magnum, from the auction'));
  assert.match(noted.text, /Note: magnum, from the auction/);

  // ✏️ asks what to change; answering that question works too.
  c.press(noted.buttons.Fix, noted.messageId);
  const windowed = c.draft(c.reply(c.lastMessageId(), 'drink 2030 to 2045'));
  assert.match(windowed.text, /Drink 2030–2045\n/);

  // Something it can't parse changes nothing, says so, and costs nothing.
  const vague = c.reply(windowed.messageId, 'it is actually the 2017');
  assert.equal(c.calls(vague, 'anthropic').length, 0);
  assert.match(c.sent(vague), /didn't understand that/);
  assert.doesNotMatch(c.sent(vague), /Changed/);

  // Retry reads the label again with Sonnet, with its refusal fallback, and keeps the window you typed.
  const retried = c.press(windowed.buttons.Retry, windowed.messageId);
  assert.match(c.sent(retried), /again with Sonnet/);
  const [again] = c.calls(retried, 'anthropic');
  assert.equal(again.payload.model, 'claude-sonnet-5-5');
  assert.equal(again.payload.fallbacks, 'default');
  assert.equal(again.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  const afterRetry = c.draft(retried);
  assert.match(afterRetry.text, /<b>2019<\/b>[\s\S]*Drink 2030–2045/);
  assert.equal(afterRetry.labels.Retry, '🔁 Retry', 'already read by Sonnet');
});

test('a window, date or "field: value" typed without replying goes to the newest draft; searches stay searches', () => {
  const c = labelBot();
  const first = c.draft(c.photo());
  const loose = c.post({ update_id: 5000, message: { message_id: 4999, chat: { id: Number(CHAT) }, text: '2027-2040' } });
  assert.match(c.draft(loose).text, /Drink 2027–2040/);
  const priced = c.post({ update_id: 5001, message: { message_id: 5002, chat: { id: Number(CHAT) }, text: 'price: 80' } });
  assert.match(c.draft(priced).text, /Price S\$80/);
  const search = c.post({ update_id: 5003, message: { message_id: 5004, chat: { id: Number(CHAT) }, text: 'jadot' } });
  assert.match(c.sent(search), /Jadot/);
  assert.equal(c.calls(search, 'deleteMessage').length, 0, 'a search leaves the draft alone');
  assert.ok(first.messageId);
});

test('✏️ Fix sends the whole row; the edited row comes back with no Claude call', () => {
  const c = labelBot();
  const first = c.draft(c.photo('Bought at Wine Co'));
  const ask = c.calls(c.press(first.buttons.Fix, first.messageId), 'sendMessage')[0];
  assert.equal(ask.payload.reply_markup.force_reply, true);
  assert.match(ask.payload.text, /<pre>producer: Domaine Duroché\nwine: Gevrey-Chambertin 1er Cru\ncuvee: Lavaut St-Jacques\n/);
  assert.match(ask.payload.text, /vintage: 2019\ncolour: Red\ngrape: Pinot Noir\nwindow: \nnotes: Bought at Wine Co\nprice: <\/pre>/);
  const askId = c.lastMessageId();

  // The whole row, edited: a new vintage, a window, a cleared cuvée and a new note.
  const edited = c.reply(askId, 'producer: Domaine Duroché\nwine: Gevrey-Chambertin\nCuvée:\nvintage: 2018\n' +
    'colour: Red\ngrape: Pinot Noir\nwindow: 2027-2040\nnotes: magnum');
  assert.equal(c.calls(edited, 'anthropic').length, 0, 'no Claude call');
  const draft = c.draft(edited);
  assert.match(draft.text, /<b>2018<\/b> Domaine Duroché · <i>Gevrey-Chambertin<\/i>\nRed · Pinot Noir\nDrink 2027–2040\nNote: magnum/);

  // One line is enough; other fields stay as they are.
  const one = c.draft(c.reply(draft.messageId, 'Color: White'));
  assert.match(one.text, /<b>2018<\/b>[\s\S]*White · Pinot Noir\nDrink 2027–2040/);

  // Mistakes are explained, and the draft is unchanged.
  assert.match(c.sent(c.reply(one.messageId, 'vintage: 2018\nregion: Burgundy')), /"region: Burgundy" isn't a field/);
  assert.match(c.sent(c.reply(one.messageId, 'window: soon')), /should look like 2028-2040/);
  assert.match(c.sent(c.reply(one.messageId, 'vintage: 18')), /year like 2019/);

  assert.match(c.sent(c.press(one.buttons.Add, one.messageId)), /Added/);
  const added = c.byName(c.ok('list').cellar, 'Domaine Duroché')[0];
  assert.deepEqual([added.wine, added.vintage, added.colour, added.window, added.notes], ['Gevrey-Chambertin', 2018, 'White', '2027–2040', 'magnum']);
});

test('/add looks a wine up by name with Haiku, asks for the window, and works like a photo draft', () => {
  const c = labelBot();
  c.answers.label = { readable: true, producer: 'Domaine Leflaive', wine: 'Bourgogne Blanc', cuvee: '',
    vintage: '2022', colour: 'White', grape: 'Chardonnay' };
  const calls = c.say('/add levlaie bogogne blanc 2022');
  assert.match(c.sent(calls), /Looking up the wine/);
  assert.equal(c.calls(calls, 'getFile').length, 0, 'no photo to download');
  const [read] = c.calls(calls, 'anthropic');
  assert.equal(c.calls(calls, 'anthropic').length, 1);
  assert.equal(read.payload.model, 'claude-haiku-5-5');
  assert.deepEqual(read.payload.messages[0].content, [{ type: 'text', text: 'The owner typed: "levlaie bogogne blanc 2022"' }]);

  const draft = c.draft(calls);
  assert.match(draft.text, /<b>2022<\/b> Domaine Leflaive · <i>Bourgogne Blanc<\/i>\nWhite · Chardonnay\nNo drinking window yet/);
  assert.deepEqual(Object.keys(draft.buttons), ['Add', 'Fix', 'Collect', 'Delivery', 'Retry', 'Cancel']);
  assert.equal(draft.labels.Retry, '🔁 Retry with Sonnet');

  // Then it asks for the window; answering that question is free.
  const ask = c.calls(calls, 'sendMessage').at(-1);
  assert.match(ask.payload.text, /What's the drinking window/);
  assert.equal(ask.payload.reply_markup.force_reply, true);
  const windowed = c.reply(c.lastMessageId(), '2024-2030');
  assert.equal(c.calls(windowed, 'anthropic').length, 0);
  const withWindow = c.draft(windowed);
  assert.match(withWindow.text, /Drink 2024–2030/);

  // ✏️ Fix sends the whole row, as for a photo; an edited row is applied with no Claude call.
  const fix = c.calls(c.press(withWindow.buttons.Fix, withWindow.messageId), 'sendMessage')[0];
  assert.match(fix.payload.text, /<pre>producer: Domaine Leflaive\nwine: Bourgogne Blanc\ncuvee: \nvintage: 2022/);
  const edited = c.reply(c.lastMessageId(), 'cuvee: Les Sétilles');
  assert.equal(c.calls(edited, 'anthropic').length, 0);
  const fixed = c.draft(edited);
  assert.match(fixed.text, /Bourgogne Blanc · Les Sétilles[\s\S]*Drink 2024–2030/);

  // 🔁 Retry rereads the same typed text with Sonnet, keeps the window and doesn't ask again.
  const retried = c.press(fixed.buttons.Retry, fixed.messageId);
  const [again] = c.calls(retried, 'anthropic');
  assert.equal(again.payload.model, 'claude-sonnet-5-5');
  assert.match(again.payload.messages[0].content[0].text, /levlaie bogogne blanc 2022/);
  assert.equal(c.calls(retried, 'getFile').length, 0);
  assert.equal(c.calls(retried, 'sendMessage').length, 0, 'no second window question');
  const afterRetry = c.draft(retried);
  assert.match(afterRetry.text, /Drink 2024–2030/);

  assert.match(c.sent(c.press(afterRetry.buttons.Add, afterRetry.messageId)), /Added .*Leflaive/);
  const added = c.byName(c.ok('list').cellar, 'Domaine Leflaive').find(w => w.vintage === 2022);
  assert.deepEqual([added.wine, added.colour, added.grape, added.window], ['Bourgogne Blanc', 'White', 'Chardonnay', '2024–2030']);
});

test('/add stays in the cellar unless 🚚 Order · delivery is tapped; then the due date is asked, and it adds as on order', () => {
  const c = labelBot();
  c.answers.label = { readable: true, producer: 'Domaine Rousseau', wine: 'Gevrey-Chambertin', cuvee: '',
    vintage: '2019', colour: 'Red', grape: 'Pinot Noir' };
  const calls = c.say('/add rouseau gevrey 2019');
  assert.equal(c.calls(calls, 'anthropic').length, 1);
  const draft = c.draft(calls);
  assert.doesNotMatch(draft.text, /On order\n/);
  assert.match(draft.text, /On order\? Tap 📦 or 🚚/);
  assert.equal(draft.labels.Delivery, '🚚 Order · delivery');
  assert.match(c.calls(calls, 'sendMessage').at(-1).payload.text, /What's the drinking window/, 'the window is asked as usual');

  // One tap makes it an order, by delivery: the order buttons go, and the due date is asked for.
  const tapped = c.press(draft.buttons.Delivery, draft.messageId);
  assert.equal(c.calls(tapped, 'anthropic').length, 0);
  const shown = c.draft(tapped);
  assert.match(shown.text, /📦 On order · Delivery\n/);
  assert.deepEqual(Object.keys(shown.buttons), ['Add', 'Fix', 'Retry', 'Cancel']);
  const ask = c.calls(tapped, 'sendMessage').at(-1);
  assert.match(ask.payload.text, /When does it arrive\?/);
  assert.equal(ask.payload.reply_markup.force_reply, true);

  // The date is free; the window can still be replied to the draft.
  const dated = c.reply(c.lastMessageId(), '2026-12-05');
  assert.equal(c.calls(dated, 'anthropic').length, 0);
  const withDate = c.draft(dated);
  assert.match(withDate.text, /On order · Delivery · due 5 Dec 2026/);
  const windowed = c.draft(c.reply(withDate.messageId, '2027-2040'));
  assert.match(windowed.text, /Drink 2027–2040/);

  // ✏️ Fix includes status, arrival and due for an order, and they can be changed.
  const fix = c.calls(c.press(windowed.buttons.Fix, windowed.messageId), 'sendMessage')[0];
  assert.match(fix.payload.text, /notes: \nprice: \nstatus: On order\narrival: Delivery\ndue: 2026-12-05<\/pre>/);
  const changed = c.draft(c.reply(c.lastMessageId(), 'arrival: collect\ndue: 2026-12-09'));
  assert.match(changed.text, /On order · Collect · due 9 Dec 2026/);
  assert.match(c.sent(c.reply(changed.messageId, 'arrival: post')), /arrival should be one of: Collect, Delivery/);
  assert.match(c.sent(c.reply(changed.messageId, 'due: soon')), /due date should look like/);

  assert.match(c.sent(c.press(changed.buttons.Add, changed.messageId)), /Added .*Rousseau.* as on order/);
  const added = c.byName(c.ok('list').cellar, 'Domaine Rousseau')[0];
  assert.deepEqual([added.status, added.arrival, added.collectBy, added.window], ['On order', 'Collect', '2026-12-09', '2027–2040']);
});

test('a price after " /" in /add goes on the draft, not to Claude; photo captions stay notes', () => {
  const c = labelBot();
  c.answers.label = { readable: true, producer: 'Domaine Rousseau', wine: 'Gevrey-Chambertin', cuvee: '',
    vintage: '2019', colour: 'Red', grape: 'Pinot Noir' };
  const calls = c.say('/add 2019 rousseau gevrey / S$1,200');
  assert.deepEqual(c.calls(calls, 'anthropic')[0].payload.messages[0].content,
    [{ type: 'text', text: 'The owner typed: "2019 rousseau gevrey"' }]);
  const draft = c.draft(calls);
  assert.match(draft.text, /Price S\$1,200/);

  // ✏️ Fix shows it, and a row reply changes it with no Claude call; a bad one is refused.
  const fix = c.calls(c.press(draft.buttons.Fix, draft.messageId), 'sendMessage')[0];
  assert.match(fix.payload.text, /\nprice: 1200<\/pre>/);
  const changed = c.reply(c.lastMessageId(), 'price: 95');
  assert.equal(c.calls(changed, 'anthropic').length, 0);
  const now = c.draft(changed);
  assert.match(now.text, /Price S\$95/);
  assert.match(c.sent(c.reply(now.messageId, 'price: lots')), /Price must be a number/);

  assert.match(c.sent(c.press(now.buttons.Add, now.messageId)), /Added/);
  assert.equal(c.byName(c.ok('list').cellar, 'Domaine Rousseau')[0].price, 95);

  // A photo caption stays a plain note: no price is taken from it.
  const photo = c.draft(c.photo('Bought at Wine Co / 90'));
  assert.doesNotMatch(photo.text, /Price/);
  assert.match(photo.text, /Note: Bought at Wine Co \/ 90/);
});

test('a bad price in /add is refused before Claude, and a price alone needs a wine', () => {
  const c = labelBot();
  const bad = c.say('/add rousseau gevrey / abc');
  assert.match(c.sent(bad), /Price must be a number/);
  assert.equal(c.calls(bad, 'anthropic').length, 0);
  const alone = c.say('/add / 150');
  assert.match(c.sent(alone), /Type the wine after \/add, and the price after a \//);
  assert.equal(c.calls(alone, 'anthropic').length, 0);
  assert.match(String(c.owner('create', { wine: { producer: 'X', wine: 'Y', price: 'abc' } }).error), /Price must be a number/,
    'the website refuses it too');
});

test('due dates: ISO, day/month and month names, the next one when the year is left out', () => {
  const { backend } = freshCellar();
  const due = t => backend.dueDate_(t, '2026-11-23');
  assert.equal(due('2026-12-05'), '2026-12-05');
  assert.equal(due('5/12'), '2026-12-05');
  assert.equal(due('5 Dec'), '2026-12-05');
  assert.equal(due('5 december 2027'), '2027-12-05');
  assert.equal(due('3 Jan'), '2027-01-03', 'already past this year, so next year');
  assert.equal(due('30 Feb'), '');
  assert.equal(due('2028-2040'), '');
  assert.equal(due('vintage 2019'), '');
});

test('/add needs a name, is owner-only, and a wine it can\'t place gets Retry or Cancel only', () => {
  const c = labelBot();
  c.gas.PropertiesService.getScriptProperties().setProperties({ TELEGRAM_GUESTS: JSON.stringify([{ id: '555', name: 'Sam' }]) });
  const bare = c.say('/add');
  assert.match(c.sent(bare), /Type the wine after \/add/);
  assert.equal(c.calls(bare, 'anthropic').length, 0);
  const guest = c.say('/add rousseau gevrey 2019', '555');
  assert.match(c.sent(guest), /Only the owner/);
  assert.equal(c.calls(guest, 'anthropic').length, 0);
  assert.match(c.sent(c.say('/help')), /\/add · Add a wine, e\.g\. \/add 2019 rousseau gevrey \/ 150/);
  assert.doesNotMatch(c.sent(c.say('/help', '555')), /\/add /);

  c.answers.label = { readable: false, producer: '', wine: '', cuvee: '', vintage: '', colour: '', grape: '' };
  const unknown = c.say('/add zzqx');
  const draft = c.draft(unknown);
  assert.match(draft.text, /couldn't tell which wine that is\.\nTry 🔁 Retry, or type it differently/);
  assert.deepEqual(Object.keys(draft.buttons), ['Retry', 'Cancel']);
  assert.doesNotMatch(c.sent(unknown), /drinking window/, 'no window question for a wine it couldn\'t place');
});

test('a photo draft is followed by the window question too', () => {
  const c = labelBot();
  const calls = c.photo();
  assert.match(c.calls(calls, 'sendMessage').at(-1).payload.text, /What's the drinking window/);
  const windowed = c.draft(c.reply(c.lastMessageId(), 'drink 2027 to 2040'));
  assert.match(windowed.text, /Drink 2027–2040/);
});

test('the website\'s ✨ identify uses the same AI code, for the owner only, and checks what the browser sends', () => {
  const c = labelBot();
  const anthropic = () => c.gas._fetches.filter(f => f.method === 'anthropic');
  c.gas._fetches.length = 0;

  // Not logged in: refused before any Claude call.
  assert.equal(c.friend('identify', { identify: { text: 'rousseau gevrey 2019' } }).auth, false);
  assert.equal(anthropic().length, 0);

  // Typed: Haiku, the same prompt as the bot, and the cuvée folded into the wine for the Add form.
  const typed = c.ok('identify', { identify: { text: '  levlaie bogogne blanc 2022 ' } });
  assert.deepEqual(typed.result, { producer: 'Domaine Duroché', wine: 'Gevrey-Chambertin 1er Cru · Lavaut St-Jacques',
    vintage: '2019', colour: 'Red', grape: 'Pinot Noir' });
  const [first] = anthropic();
  assert.equal(first.payload.model, 'claude-haiku-5-5');
  assert.match(first.payload.system, /You identify one wine for a cellar list/);
  assert.deepEqual(first.payload.messages[0].content, [{ type: 'text', text: 'The owner typed: "levlaie bogogne blanc 2022"' }]);
  assert.equal(c.ok('list').cellar.length, 5, 'nothing is saved');

  // A photo, with the text as a note; "strong" uses Sonnet.
  c.gas._fetches.length = 0;
  c.ok('identify', { identify: { photo: { media_type: 'image/jpeg', data: '/9j/4A==' }, text: 'magnum', strong: true } });
  const [photo] = anthropic();
  assert.equal(photo.payload.model, 'claude-sonnet-5-5');
  assert.equal(photo.payload.messages[0].content[0].source.data, '/9j/4A==');
  assert.match(photo.payload.messages[0].content[1].text, /magnum/);
  assert.equal(c.gas._fetches.filter(f => f.method === 'getFile').length, 0, 'no Telegram download');

  // Bad input is refused before Claude is called.
  c.gas._fetches.length = 0;
  const bad = identify => c.owner('identify', { identify }).error;
  assert.match(bad({}), /Type the wine or add a photo/);
  assert.match(bad({ photo: { media_type: 'image/svg+xml', data: 'PHN2Zz4=' } }), /couldn't be used/);
  assert.match(bad({ photo: { media_type: 'image/jpeg', data: 'not base64!' } }), /couldn't be used/);
  assert.match(bad({ photo: { media_type: 'image/jpeg', data: 'A'.repeat(2000004) } }), /couldn't be used/);
  assert.equal(anthropic().length, 0);

  // A wine it can't place is an error, not an empty form.
  c.answers.label = { readable: false, producer: '', wine: '', cuvee: '', vintage: '', colour: '', grape: '' };
  assert.match(bad({ text: 'zzqx' }), /couldn't tell which wine that is/);
});

test('AI look-ups stop at the daily limit from the Settings tab, for the bot and the website together', () => {
  const c = labelBot();
  c.tab('Settings').rows.push(['aiDailyLimit', '2', '']);
  c.ok('identify', { identify: { text: 'one' } });
  c.draft(c.say('/add two'));
  assert.match(c.owner('identify', { identify: { text: 'three' } }).error, /2 AI look-ups allowed today/);
  assert.match(c.sent(c.say('/add four')), /2 AI look-ups allowed today/);
});

test('label photos: guests are refused, keys are needed, and an unreadable photo can be retried or cancelled', () => {
  const c = labelBot({ keys: false });
  assert.match(c.sent(c.photo()), /Run setLabelReader\(\)/);
  assert.throws(() => c.backend.setLabelReader(), /Paste your Anthropic API key/);

  const props = c.gas.PropertiesService.getScriptProperties();
  props.setProperties({ ANTHROPIC_API_KEY: 'sk-ant-test', TELEGRAM_GUESTS: JSON.stringify([{ id: '555', name: 'Sam' }]) });
  const guest = c.photo(undefined, '555');
  assert.match(c.sent(guest), /Only the owner/);
  assert.equal(c.calls(guest, 'anthropic').length, 0);

  c.answers.label = { readable: false, producer: '', wine: '', cuvee: '', vintage: '', colour: '', grape: '' };
  const blurry = c.draft(c.photo());
  assert.match(blurry.text, /couldn't read a wine label/);
  assert.deepEqual(Object.keys(blurry.buttons), ['Retry', 'Cancel']);
  const draftId = blurry.buttons.Retry.split(':')[2];
  assert.match(c.sent(c.press('lbl:ok:' + draftId, blurry.messageId, '555')), /Only the owner/, 'a guest can\'t tap a draft');

  c.answers.label = { readable: true, producer: 'Jadot', wine: 'Beaune', cuvee: '', vintage: '', colour: 'Red', grape: '' };
  const retried = c.draft(c.press(blurry.buttons.Retry, blurry.messageId));
  assert.match(retried.text, /<b>NV<\/b> Jadot · <i>Beaune<\/i>/);
  assert.equal(c.calls(c.press(retried.buttons.Retry, blurry.messageId), 'getFile')[0].payload.file_id, 'big', 'retry reads the same photo');

  assert.match(c.sent(c.press(retried.buttons.Cancel, blurry.messageId)), /Cancelled/);
  assert.equal(c.ok('list').cellar.length, 5);
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
  const tc = over => W({ window: '', status: 'On order', ...over });
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

test('on order by delivery: the bot and reminders say so, and arrival only takes Collect or Delivery', () => {
  const { backend, gas, ok, owner } = freshBot();
  const gros = ok('list').cellar.find(w => w.producer === 'A F Gros');
  assert.equal(gros.arrival, 'Collect');
  assert.match(owner('update', { id: gros.id, wine: { arrival: 'Post' } }).error, /Collect or delivery must be one of: Collect, Delivery/);
  ok('update', { id: gros.id, wine: { arrival: 'Delivery', collectBy: '2026-11-27' } });
  gas._fetches.length = 0;
  backend.sendReminders_('2026-11-26');
  assert.match(gas._fetches.find(f => f.method === 'sendMessage').payload.text, /Arrives tomorrow[\s\S]*A F Gros/);
  ok('update', { id: gros.id, wine: { arrival: '' } });
  gas._fetches.length = 0;
  backend.sendReminders_('2026-11-27');
  assert.match(gas._fetches.find(f => f.method === 'sendMessage').payload.text, /Due today/);
});

test('migrate() turns old "To collect" bottles into On order, by collection', () => {
  const { ok, tab, backend } = freshCellar();
  const cellar = tab('Cellar');
  const head = cellar.getRange(1, 1, 1, cellar.getLastColumn()).getDisplayValues()[0];
  const rows = cellar.getRange(2, 1, cellar.getLastRow() - 1, head.length).getDisplayValues();
  const r = rows.findIndex(x => x[head.indexOf('status')] === 'On order') + 2;
  cellar.getRange(r, head.indexOf('status') + 1).setValues([['To collect']]);
  cellar.getRange(r, head.indexOf('arrival') + 1).setValues([['']]);
  backend.migrate();
  const gros = ok('list').cellar.find(w => w.producer === 'A F Gros');
  assert.equal(gros.status, 'On order');
  assert.equal(gros.arrival, 'Collect');
});

test('Collect by is a date, and is not carried into Drunk', () => {
  const { ok, owner, tab } = freshCellar();
  const w = ok('list').cellar.find(x => x.producer === 'A F Gros');
  assert.match(owner('update', { id: w.id, wine: { collectBy: 'Friday' } }).error, /Due by must be a date/);
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
  assert.deepEqual(tab('Settings').rows.slice(1).map(r => r[0]), ['currency', 'reminderHour', 'closeReminderMonths', 'nudgeDay', 'aiDailyLimit']);
  assert.equal(tab('Reminders log').hidden, true, 'the log tab is hidden');

  tab('Lists').rows.push(['Orange', 'white', '', '']);
  setSetting(tab, 'currency', '€');
  backend.migrate();
  assert.deepEqual(tab('Lists').rows.at(-1).slice(0, 2), ['Orange', 'white'], 'your rows are kept');
  const res = ok('list');
  assert.equal(res.settings.currency, '€');
  assert.deepEqual(res.lists.colours.at(-1), { name: 'Orange', tone: 'white' });
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

test('prices accept any currency in front', () => {
  const { ok } = freshCellar();
  const price = p => ok('create', { wine: { producer: 'P' + p, wine: 'W', price: p } }).cellar.find(w => w.producer === 'P' + p).price;
  assert.equal(price('€ 1,250'), 1250);
  assert.equal(price('$45.50'), 45.5);
  assert.equal(price('USD 80'), 80);
});

test('Settings drive the currency and reminder timing; bad values fall back and status() says so', () => {
  const { backend, tab, ok, say, sent } = freshBot();
  setSetting(tab, 'currency', '€');
  setSetting(tab, 'closeReminderMonths', '3');
  setSetting(tab, 'nudgeDay', 'tuesday');
  setSetting(tab, 'reminderHour', '25');
  const s = ok('list').settings;
  assert.deepEqual(s, { currency: '€', reminderHour: 9, closeReminderMonths: 3, nudgeDay: 'Tuesday', aiDailyLimit: 100 });
  assert.match(sent(say('/stats')), /€809/);

  const keys = (recs, today) => backend.remindersDue_(recs, today, {}, s).map(r => r.key);
  assert.deepEqual(keys([W()], '2033-09-30'), []);
  assert.deepEqual(keys([W()], '2033-10-01'), ['w1|close|2033'], '3 months before the end of 2033');
  const tc = W({ window: '', status: 'On order' });
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

test('the reminder log is a sheet tab, so hundreds of bottles are fine', () => {
  const { backend, gas, ok, tab } = freshBot();
  const props = gas.PropertiesService.getScriptProperties();
  const jadot = ok('list').cellar.find(w => w.producer === 'Jadot');
  for (let i = 0; i < 300; i++) ok('create', { wine: { producer: 'Producer ' + i, wine: 'Cuvée', vintage: 2020, window: '2027–2035' } });

  const sentCount = backend.sendReminders_('2027-01-01');
  assert.ok(sentCount >= 301, 'every bottle opening in 2027 is reminded');
  const logged = tab('Reminders log').rows.slice(1).map(r => r[0]);
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
