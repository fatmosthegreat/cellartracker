// The only file that talks to the backend. Swap the backend (Supabase, your own server…)
// by changing this file; every response has the shape { ok, owner, result, cellar, consumed, lists, settings }.
import { config } from "./config.js";

export const isDemo = !config.apiUrl;

// A random id for this browser, sent with the passkey. Wrong passkeys then lock out only the
// device they came from, not the owner everywhere. Not secret, and not used for anything else.
const DEVICE = (() => {
  const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("");
  try {
    let id = localStorage.getItem("cellar.device");
    if (!/^[a-f0-9]{24}$/.test(id || "")) { id = fresh(); localStorage.setItem("cellar.device", id); }
    return id;
  } catch {
    return fresh();  // private mode: a new id per visit is fine
  }
})();

/**
 * Calls a backend action. Throws an Error with a readable message on failure;
 * `error.auth` is true when the passkey was missing or wrong.
 * @param {"list"|"login"|"create"|"update"|"remove"|"adjust"|"drink"|"identify"} action
 * @param {object} [payload]  e.g. { id, wine }, { id, drink } or { identify: { text, photo, strong } }
 * @param {string|null} [key] the passkey, if logged in
 */
export async function call(action, payload = {}, key = null) {
  const body = { action, ...payload };
  if (key) Object.assign(body, { key, device: DEVICE });
  const data = isDemo ? await callDemo(body) : await callRemote(body);
  if (data.auth === false) {
    const err = new Error(data.error || "Wrong passkey.");
    err.auth = true;
    throw err;
  }
  if (!data.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

async function callRemote(body) {
  let res;
  try {
    // No Content-Type header: a text/plain POST skips the CORS preflight that Apps Script can't answer.
    res = await fetch(config.apiUrl, { method: "POST", body: JSON.stringify(body) });
  } catch {
    throw new Error("Couldn't reach the cellar. Check your connection and try again.");
  }
  if (!res.ok) throw new Error(`The cellar didn't respond (${res.status}). Try again in a moment.`);
  try {
    return await res.json();
  } catch {
    throw new Error("The cellar sent back something unexpected. Check the Apps Script deployment.");
  }
}

let demo;
async function callDemo(body) {
  demo ??= import("./demo-backend.js").then(m => m.createDemoBackend());
  const handle = await demo;
  await new Promise(r => setTimeout(r, 200));  // feel like a network call
  return structuredClone(handle(body));
}
