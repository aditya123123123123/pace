// Tokenising + timing for RSVP (rapid serial visual presentation).

/**
 * @typedef {{w: string, sentenceStart: boolean, paraEnd: boolean, units: number, cont: boolean}} Token
 * `cont`: this token is a later piece of a word that splitLong() broke up (no space before it).
 * `pageStart` (optional): first token of a new PDF page — the text had a form feed before it.
 * `seg`: how many form feeds precede the token — its text segment, which a PDF's
 *   `segPages` maps to a page. Empty pages still count, so this survives blank leaves.
 */

const ABBREV = new Set(["mr.", "mrs.", "ms.", "dr.", "st.", "jr.", "sr.", "vs.", "etc.", "e.g.", "i.e.", "u.s.", "no.", "fig.", "p.", "pp.", "vol.", "inc.", "ltd.", "co."]);

export function tokenize(text) {
  const paras = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00ad/g, "")              // soft hyphens
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    // page break → paragraph break that remembers the page; keep every \f so blank pages still count
    .replace(/\s*\f\s*/g, (m) => "\n\n" + m.replace(/[^\f]/g, ""))
    .split(/\n[^\S\f]*\n+/)
    .map((p) => p.replace(/^[^\S\f]+|\s+$/g, ""))
    .filter(Boolean);

  /** @type {Token[]} */
  const tokens = [];
  let nextIsSentenceStart = true;
  let pageStart = false;
  let seg = 0;
  for (let p of paras) {
    if (p.includes("\f")) {
      pageStart = tokens.length > 0;
      seg += p.match(/\f/g).length;
      p = p.replace(/\f/g, "").trim();
    }
    if (!p) continue;
    const words = p.split(/\s+/).filter(Boolean);
    words.forEach((w, i) => {
      const parts = splitLong(w);
      parts.forEach((part, j) => {
        const last = i === words.length - 1 && j === parts.length - 1;
        const t = { w: part, sentenceStart: nextIsSentenceStart, paraEnd: last, units: 1, cont: j > 0, seg };
        if (pageStart) { t.pageStart = true; pageStart = false; }
        tokens.push(t);
        nextIsSentenceStart = last || endsSentence(part);
      });
    });
  }
  for (const t of tokens) t.units = unitsFor(t);
  return tokens;
}

const MAX_FLASH = 14; // longest token shown in one flash before it's split

/** Split dash-joined words and over-long tokens into readable flashes. */
function splitLong(w) {
  let parts = /\w[—–]\w/.test(w) ? w.split(/(?<=[—–])/) : [w];
  if (w.length > MAX_FLASH) parts = parts.flatMap((p) => (p.length > MAX_FLASH ? p.split(/(?<=-)(?=\w)/) : [p]));
  // re-merge tiny hyphen fragments ("e-", "x-") so we don't flash single letters
  const merged = [];
  for (const p of parts) {
    const prev = merged[merged.length - 1];
    if (prev && (prev.length + p.length <= MAX_FLASH) && (prev.length < 5 || p.length < 5)) merged[merged.length - 1] = prev + p;
    else merged.push(p);
  }
  return merged.flatMap((p) => {
    if (p.length <= MAX_FLASH + 2) return [p];
    const n = Math.ceil(p.length / 12);
    const size = Math.ceil(p.length / n);
    const out = [];
    for (let k = 0; k < p.length; k += size) out.push(p.slice(k, k + size));
    // don't strand trailing punctuation on its own
    if (out.length > 1 && !/[\p{L}\p{N}]/u.test(out[out.length - 1])) out[out.length - 2] += out.pop();
    return out.map((s, k) => (k < out.length - 1 && !/-$/.test(s) ? s + "-" : s));
  });
}

function endsSentence(w) {
  if (ABBREV.has(w.toLowerCase())) return false;
  if (/^[A-Z]\.$/.test(w)) return false; // initials
  return /[.!?…]["'”’)\]]*$/.test(w);
}

/** Relative display time for a token (1 = one beat at the chosen WPM). */
function unitsFor(t, punct = true) {
  const w = t.w;
  const letters = w.replace(/[^\p{L}\p{N}]/gu, "").length;
  let u = 1;
  if (letters > 7) u += Math.min(0.6, (letters - 7) * 0.07);
  if (letters <= 2 && !/\d/.test(w)) u -= 0.1;
  if (!punct) return u;
  if (t.paraEnd) u += 1.6;
  else if (endsSentence(w)) u += 1.1;
  else if (/[,;:—–)\]]["'”’]?$/.test(w)) u += 0.5;
  if (/\d/.test(w)) u += 0.2;
  return u;
}

export function recomputeUnits(tokens, punct) {
  let sum = 0;
  for (const t of tokens) sum += (t.units = unitsFor(t, punct));
  // Normalise so the average beat is exactly 1: the chosen WPM is the real
  // overall rate, and pauses are redistributed rather than added on top.
  const mean = tokens.length ? sum / tokens.length : 1;
  for (const t of tokens) t.units /= mean;
}

/** Optimal Recognition Point — the letter the eye should land on. */
export function orpIndex(word) {
  // skip leading punctuation so the pivot lands on a letter
  const lead = word.match(/^[^\p{L}\p{N}]*/u)[0].length;
  const core = word.slice(lead).replace(/[^\p{L}\p{N}]+$/u, "");
  const n = core.length;
  const k = n <= 1 ? 0 : n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : 4;
  return Math.min(word.length - 1, lead + k);
}

export function sentenceStarts(tokens) {
  const s = [];
  tokens.forEach((t, i) => { if (t.sentenceStart) s.push(i); });
  return s;
}

/** Running total of display time; skipped tokens (mask[i] = 1) take no time. */
export function prefixUnits(tokens, mask) {
  const p = new Float64Array(tokens.length + 1);
  for (let i = 0; i < tokens.length; i++) p[i + 1] = p[i] + (mask?.[i] ? 0 : tokens[i].units);
  return p;
}
