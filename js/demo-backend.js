// Demo mode: runs the real apps-script/Code.gs in the browser against an in-memory sheet,
// so the page behaves exactly like it will with Google Sheets. Changes vanish on reload.
import { config } from "./config.js";

export async function createDemoBackend() {
  const [fakeSource, codeSource] = await Promise.all([load("dev/fake-gas.js"), load("apps-script/Code.gs")]);
  const { createFakeGas, loadBackend } = new Function(`${fakeSource}\nreturn { createFakeGas, loadBackend };`)();
  const gas = createFakeGas();
  const backend = loadBackend(gas, codeSource);
  backend.setup();
  const salt = "demo";
  gas.PropertiesService.getScriptProperties().setProperties({
    PASS_SALT: salt,
    PASS_HASH: backend.sha256_(salt + config.demoPasskey),
  });
  return req => backend.handle_(req);
}

async function load(path) {
  const res = await fetch(new URL(`../${path}`, import.meta.url));
  if (!res.ok) throw new Error(`Demo mode couldn't load ${path}. Serve the folder over http (see README).`);
  return res.text();
}
