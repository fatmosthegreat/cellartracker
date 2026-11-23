// The settings you're likely to change. Nothing else in the front end needs editing.
export const config = {
  // Your Apps Script web app URL (Deploy → Manage deployments → Web app, ends in /exec).
  // Safe to publish: without the passkey it only returns bottles that aren't hidden.
  // Leave it empty to run a local demo against an in-browser copy of the backend.
  apiUrl: "https://script.google.com/macros/s/AKfycbycMQbR1ULvpJw683lY3QYqfbcNe-IUzOMtfrOfBNtDtmONT8o1UQKHAnmeUkRCdVbG/exec",

  cellarName: "The Cellar",  // the last word is set in italics
  currency: "S$",
  locale: "en-SG",

  // Passkey for demo mode only. Your real passkey lives in Apps Script, never in this repo.
  demoPasskey: "cellar",
};
