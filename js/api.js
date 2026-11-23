// The only file that talks to the backend. Swap the backend (Supabase, your own server…)
// by changing this file; every response has the shape { ok, owner, result, cellar, drunk }.
import { config } from "./config.js";

export const isDemo = !config.apiUrl;

/**
 * Calls a backend action. Throws an Error with a readable message on failure;
 * `error.auth` is true when the passkey was missing or wrong.
 * @param {"list"|"login"|"create"|"update"|"remove"|"adjust"|"drink"} action
 * @param {object} [payload]  e.g. { id, wine } or { id, drink }
 * @param {string|null} [key] the passkey, if logged in
 */
export async function call(action, payload = {}, key = null) {
  const body = { action, ...payload };
  if (key) body.key = key;
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
