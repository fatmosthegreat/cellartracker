/**
 * Fake Google Apps Script services backed by an in-memory spreadsheet.
 *
 * Used in two places, so both run the real apps-script/Code.gs:
 *   - the tests (Node):          test/backend.test.js
 *   - local demo mode (browser): js/demo-backend.js, when config.apiUrl is empty
 *
 * It only implements what Code.gs calls. If Code.gs starts using another Apps Script
 * method, add it here and the tests will tell you if it's missing.
 *
 * Plain script (no import/export) so the browser can load it with new Function().
 */

function createFakeGas() {
  class Sheet {
    constructor(name) { this.name = name; this.rows = []; }
    getName() { return this.name; }
    getLastRow() {
      for (let r = this.rows.length; r > 0; r--) if (this.rows[r - 1].some(v => v !== '')) return r;
      return 0;
    }
    getLastColumn() {
      let max = 0;
      this.rows.forEach(row => {
        for (let c = row.length; c > 0; c--) if (row[c - 1] !== '') { max = Math.max(max, c); break; }
      });
      return max;
    }
    getMaxRows() { return Math.max(1000, this.rows.length); }
    getRange(row, col, numRows, numCols) { return new Range(this, row, col, numRows || 1, numCols || 1); }
    deleteRow(row) { this.rows.splice(row - 1, 1); }
    setFrozenRows() { return this; }
  }

  class Range {
    constructor(sheet, row, col, numRows, numCols) { Object.assign(this, { sheet, row, col, numRows, numCols }); }
    getDisplayValues() {
      const out = [];
      for (let i = 0; i < this.numRows; i++) {
        const src = this.sheet.rows[this.row - 1 + i] || [];
        const line = [];
        for (let j = 0; j < this.numCols; j++) {
          const v = src[this.col - 1 + j];
          line.push(v === undefined || v === null ? '' : String(v));
        }
        out.push(line);
      }
      return out;
    }
    setValues(values) {
      if (values.length !== this.numRows || values.some(r => r.length !== this.numCols)) {
        throw new Error('setValues: the data does not match the range size');
      }
      values.forEach((line, i) => {
        const idx = this.row - 1 + i;
        while (this.sheet.rows.length <= idx) this.sheet.rows.push([]);
        const target = this.sheet.rows[idx];
        line.forEach((v, j) => {
          const c = this.col - 1 + j;
          while (target.length < c) target.push('');
          let s = v === undefined || v === null ? '' : String(v);
          // Real Sheets would turn this into a formula. Fail loudly so the tests catch it.
          if (s.startsWith('=')) throw new Error('Fake sheet: "' + s + '" would be written as a formula');
          if (s.startsWith("'")) s = s.slice(1);  // Sheets hides the leading apostrophe
          target[c] = s;
        });
      });
      return this;
    }
    setNumberFormat() { return this; }
    setFontWeight() { return this; }
  }

  const sheets = [];
  const spreadsheet = {
    getSheetByName: name => sheets.find(s => s.name === name) || null,
    insertSheet: name => { const s = new Sheet(name); sheets.push(s); return s; },
    getSheets: () => sheets.slice(),
    deleteSheet: s => { sheets.splice(sheets.indexOf(s), 1); },
  };
  spreadsheet.insertSheet('Sheet1');  // a new Google Sheet starts with one blank tab

  const props = {};
  const cache = {};
  const pad = n => String(n).padStart(2, '0');

  return {
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() {} },
    Utilities: {
      getUuid: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      }),
      // Apps Script returns signed bytes (-128..127); match that.
      computeDigest: (_alg, text) => sha256Bytes(text).map(b => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      formatDate: d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperties: o => { Object.assign(props, o); },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => (k in cache ? cache[k] : null),
        put: (k, v) => { cache[k] = String(v); },
        remove: k => { delete cache[k]; },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: text => ({ setMimeType() { return this; }, getContent: () => text }),
    },
    Session: { getScriptTimeZone: () => 'Asia/Singapore' },
    Logger: { log() {} },
    _spreadsheet: spreadsheet,  // for tests: poke at the sheet directly
  };
}

// Runs Code.gs with the fake services as its globals and returns the functions the callers need.
function loadBackend(gas, codeSource) {
  const names = Object.keys(gas).filter(k => !k.startsWith('_'));
  const factory = new Function(...names,
    codeSource + '\n;return { handle_, doGet, doPost, setup, migrate, sha256_, SCHEMA };');
  return factory(...names.map(n => gas[n]));
}

// Small synchronous SHA-256 (UTF-8 input, byte array output). The browser's crypto.subtle is
// async, and Code.gs needs a synchronous digest, so the fake carries its own.
function sha256Bytes(text) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bitLen / 2 ** (8 * i)) & 0xff);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const w = new Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
  }
  const out = [];
  H.forEach(v => { for (let i = 3; i >= 0; i--) out.push((v >>> (8 * i)) & 0xff); });
  return out;
}

if (typeof module !== 'undefined') module.exports = { createFakeGas, loadBackend, sha256Bytes };
