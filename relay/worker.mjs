// Cloudflare Worker that relays Telegram messages to the cellar's Apps Script.
//
// Why it exists: Telegram delivers bot messages to a URL (a webhook) and expects a plain
// "200 OK". Apps Script always answers with a redirect, which Telegram treats as a failure,
// so messages pile up unanswered. This Worker answers Telegram straight away and passes each
// message on to Apps Script in the background.
//
// Settings (see README.md, "Faster replies"):
//   APPS_SCRIPT_URL  your web app URL (the one in js/config.js). Set in wrangler.toml under [vars].
//   RELAY_SECRET     the value relaySecret() logs. Set with: npx wrangler secret put RELAY_SECRET
//
// Telegram sends RELAY_SECRET in a header with every message, so anything else is refused.
// The secret is passed on to Apps Script, which also refuses anything without it.

export default {
  async fetch(request, env, ctx) {
    if (!env.APPS_SCRIPT_URL) return new Response("APPS_SCRIPT_URL isn't set in wrangler.toml.", { status: 500 });
    if (request.method !== "POST") return new Response("Cellar relay is running.");
    if (!env.RELAY_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.RELAY_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    // Answer Telegram now; Apps Script takes a few seconds and keeps working after this returns.
    ctx.waitUntil(
      fetch(env.APPS_SCRIPT_URL, {
        method: "POST",
        body: JSON.stringify({ telegram: update, relayKey: env.RELAY_SECRET }),
        redirect: "follow",
      })
        .then(res => { if (!res.ok) console.log(`Apps Script answered ${res.status}`); })
        .catch(err => console.log(`Couldn't reach Apps Script: ${err}`)),
    );
    return new Response("ok");
  },
};
