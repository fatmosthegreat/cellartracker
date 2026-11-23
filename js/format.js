// Small pure helpers: formatting and parsing. No DOM, no state.
import { config } from "./config.js";

export const esc = v => String(v ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const bottleCount = w => w.bottles || 1;

export function money(n) {
  if (n === null || n === undefined || n === "") return "";
  const whole = Number.isInteger(Number(n));
  return Number(n).toLocaleString(config.locale, { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
}

export function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return isNaN(d) ? iso : d.toLocaleDateString(config.locale, { day: "numeric", month: "short", year: "numeric" });
}

export function todayISO(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "2024–2030", "2024-2030" or "2024 to 2030" → { from: 2024, to: 2030 }; anything else → null */
export function parseWindow(text) {
  const m = String(text || "").match(/(\d{4})\D+(\d{4})/);
  if (!m) return null;
  const from = Number(m[1]), to = Number(m[2]);
  return from <= to ? { from, to } : null;
}

/** Where a bottle is in its drinking window this year. */
export function windowState(text, year = new Date().getFullYear()) {
  const w = parseWindow(text);
  if (!w) return null;
  if (year < w.from) return { key: "hold", label: `Hold till ${w.from}` };
  if (year > w.to) return { key: "late", label: "Past its window" };
  return { key: "now", label: "Drink now" };
}
