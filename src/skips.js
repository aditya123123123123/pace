// Skipped parts of a document. In memory: one byte per token (1 = skip).
// On disk: compact [start, end) ranges plus the token count they were made for, so a
// future change to tokenising can never apply old ranges to the wrong words.

/** Token ranges [a, b) of each paragraph. */
export function paragraphs(tokens) {
  const out = [];
  let a = 0;
  tokens.forEach((t, i) => {
    if (t.paraEnd || i === tokens.length - 1) { out.push([a, i + 1]); a = i + 1; }
  });
  return out;
}

export function maskFrom(saved, n) {
  const m = new Uint8Array(n);
  if (saved?.n === n) for (const [a, b] of saved.ranges || []) m.fill(1, Math.max(0, a), Math.min(b, n));
  return m;
}

export function rangesOf(mask) {
  const out = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const a = i;
    while (i < mask.length && mask[i]) i++;
    out.push([a, i]);
  }
  return out;
}

export function countSkipped(mask, a = 0, b = mask.length) {
  let k = 0;
  for (let i = a; i < b; i++) k += mask[i];
  return k;
}

/** First index ≥ i that is not skipped (mask.length if none). */
export function nextReadable(mask, i) {
  while (i < mask.length && mask[i]) i++;
  return i;
}

// ------------------------------------------------------------ headers & page numbers
// Book scans repeat a running head on every page ("INTRODUCTION > XV",
// "The Revolutionary World of Matthew Patten 13") and OCR reads it as its own short
// paragraph. A short paragraph counts as one when it is
//   · only a page number / roman numeral / OCR crumbs, or
//   · a page number plus mostly capital letters, or
//   · page-number-ish or all-caps text that repeats elsewhere in the document.
// Suggestions only: the reader sees and confirms them before anything is skipped.

const ROMANISH = /^[ivxlcdm]{1,5}[a-z]?$/i; // "XV", "xiv", and OCR'd "XVIn" / "Io" (=10)

// Edge words that can be stripped: "num" = a page number, "crumb" = OCR noise or a list
// marker. "(a)", "(3)", "3." and "a)" label form fields and lists, so they never count as
// page numbers — otherwise every "(a) Yes" on a tax form looked like a running head.
function edgeKind(w) {
  const c = w.replace(/[^\p{L}\p{N}]/gu, "");
  if (!c) return "crumb";
  const marker = /^\(.*\)$|^[\p{L}\p{N}]{1,3}[.)]$/u.test(w);
  if (/^\d{1,4}$/.test(c) || (c.length > 1 && ROMANISH.test(c))) return marker ? "crumb" : "num";
  if (c.length === 1 || /\d/.test(c)) return "crumb";
  return null;
}

// When the text knows its PDF pages (tokens carry pageStart), only the first two or last
// two paragraphs of a page can be a running head or folio. Mid-page, a short capitalised
// line is a real heading ("ARTICLE IV", "Exercise 1.2") and skipping it loses content.
const EDGE_PARAS = 2;

function pageEdges(paras, tokens) {
  if (!tokens.some((t) => t.pageStart)) return null;
  const edge = new Uint8Array(paras.length);
  let first = 0;
  const mark = (s, e) => { for (let k = s; k < e; k++) if (k - s < EDGE_PARAS || e - k <= EDGE_PARAS) edge[k] = 1; };
  paras.forEach(([a], i) => { if (i && tokens[a].pageStart) { mark(first, i); first = i; } });
  mark(first, paras.length);
  return edge;
}

export function suggestHeaders(tokens) {
  const paras = paragraphs(tokens);
  const edge = pageEdges(paras, tokens);
  const info = paras.map(([a, b], i) => {
    if (b - a > 10 || (edge && !edge[i])) return null;
    const words = tokens.slice(a, b).map((t) => t.w);
    let s = 0, e = words.length, numbered = false;
    for (let k; s < e && (k = edgeKind(words[s])); s++) if (k === "num") numbered = true;
    for (let k; e > s && (k = edgeKind(words[e - 1])); e--) if (k === "num") numbered = true;
    const core = words.slice(s, e);
    const letters = core.join("").replace(/[^\p{L}]/gu, "");
    return {
      a, b,
      core: core.length,
      numbered,
      caps: letters ? letters.replace(/[^\p{Lu}]/gu, "").length / letters.length : 0,
      key: core.join(" ").toLowerCase().replace(/[^\p{L}\s]/gu, "").replace(/\s+/g, " ").trim(),
    };
  });
  const seen = new Map();
  for (const x of info) if (x?.key) seen.set(x.key, (seen.get(x.key) || 0) + 1);
  return info
    .filter((x) => x && (
      x.core === 0 ||
      (x.numbered && x.caps > 0.7 && x.core <= 6) ||
      (seen.get(x.key) >= 2 && x.core <= 8 && (x.numbered || x.caps > 0.7))
    ))
    .map((x) => [x.a, x.b]);
}
