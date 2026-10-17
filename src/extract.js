// Text extraction for every supported input. Everything runs in the browser;
// files never leave the device (OCR language data is fetched from a CDN once).
// Legacy build: it bundles polyfills (Map/WeakMap.getOrInsertComputed, Promise.withResolvers,
// Uint8Array base64, …) that the modern build assumes. Without it Safari and older
// Chrome/Firefox throw "getOrInsertComputed is not a function" on the first PDF.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;
const MIN_CHARS_PER_PAGE = 24; // below this a PDF page is treated as scanned → OCR
const SPARSE_SCAN_CHARS = 600; // an image page with less text than this may be a scan with a bad text layer
const LOW_CONFIDENCE = 55; // Tesseract mean confidence below this on a whole page → try it rotated
const OCR_WEIGHT = 25; // one OCR page takes about as long as 25 text-layer pages (progress bar weighting)
// Page boundaries stay in the text as a form feed so skip suggestions can tell a running
// head (first/last lines of a page) from a heading mid-page. tokenize() reads it as a
// paragraph break, so it never shows up as a word.
export const PAGE_BREAK = "\n\n\f\n\n";

export class Cancelled extends Error {}

/**
 * @param {File} file
 * @param {{onProgress?: (msg: string, frac: number|null) => void, signal?: {cancelled: boolean}}} opts
 * @returns {Promise<{text: string, ocrPages: number, pages: number, segPages?: number[]}>}
 */
export async function extractText(file, { onProgress = () => {}, signal = { cancelled: false } } = {}) {
  const name = file.name || "file";
  const type = file.type || "";
  const check = () => { if (signal.cancelled) throw new Cancelled(); };

  if (type === "application/pdf" || /\.pdf$/i.test(name)) {
    return extractPdf(file, onProgress, signal, check);
  }
  if (type.startsWith("image/") || IMAGE_RE.test(name)) {
    onProgress("Scanning…", 0);
    const canvas = await imageToCanvas(file);
    const text = await withOcr(signal, (ocr) => ocrCanvas(ocr, canvas, check, (f) => onProgress("Scanning…", Math.min(0.99, f))));
    canvas.width = canvas.height = 0;
    return { text, ocrPages: 1, pages: 1 };
  }
  if (/\.docx$/i.test(name) || type.includes("wordprocessingml")) {
    onProgress("Reading Word document…", null);
    const mammoth = await import("mammoth");
    const arrayBuffer = await file.arrayBuffer();
    check();
    const { value } = await mammoth.extractRawText({ arrayBuffer });
    return { text: value, ocrPages: 0, pages: 1 };
  }
  if (/\.doc$/i.test(name)) {
    throw new Error("Old .doc files aren't supported. Save it as .docx or PDF and try again.");
  }

  onProgress("Reading text…", null);
  const raw = await file.text();
  check();
  if (/\.html?$/i.test(name) || type === "text/html") return { text: htmlToText(raw), ocrPages: 0, pages: 1 };
  if (/\.rtf$/i.test(name) || type.includes("rtf")) return { text: rtfToText(raw), ocrPages: 0, pages: 1 };
  if (/\.(md|markdown)$/i.test(name)) return { text: markdownToText(raw), ocrPages: 0, pages: 1 };
  if (looksBinary(raw)) throw new Error("That file doesn't look like text. Try a PDF, image, DOCX or TXT.");
  return { text: raw, ocrPages: 0, pages: 1 };
}

// ---------------------------------------------------------------- PDF

/** A pdf.js loading task with Pace's self-hosted decoder assets. Call task.destroy() when done. */
export function openPdf(data) {
  const base = new URL(`${import.meta.env.BASE_URL}pdfjs/`, location.href).href;
  return pdfjs.getDocument({
    data,
    isEvalSupported: false,
    wasmUrl: `${base}wasm/`,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    iccUrl: `${base}iccs/`,
  });
}

async function extractPdf(file, onProgress, signal, check) {
  onProgress("Opening PDF…", 0);
  const data = new Uint8Array(await file.arrayBuffer());
  check();
  let pdf;
  const task = openPdf(data);
  try {
    pdf = await task.promise;
  } catch (e) {
    task.destroy?.();
    if (e?.name === "PasswordException") throw new Error("This PDF is password-protected.");
    throw new Error("Couldn't open that PDF — it may be damaged.");
  }
  const n = pdf.numPages;
  const pages = new Array(n).fill("");
  const jobs = [];
  let ocrPages = 0;
  // One bar for the whole file, no page counts. An OCR page costs ~OCR_WEIGHT text pages;
  // the total is re-estimated as scans turn up, and the bar never moves backwards.
  const prog = { read: 0, found: 0, ocrDone: 0, partial: new Map(), shown: 0 };
  const report = () => {
    const estOcr = prog.read ? prog.found + ((n - prog.read) * prog.found) / prog.read : 0;
    let partial = 0;
    for (const v of prog.partial.values()) partial += v;
    const frac = (prog.read + OCR_WEIGHT * (prog.ocrDone + partial)) / (n + OCR_WEIGHT * estOcr);
    prog.shown = Math.max(prog.shown, Math.min(0.99, frac));
    onProgress(prog.found ? "Scanning…" : "Reading…", prog.shown);
  };
  try {
    for (let i = 0; i < n; i++) {
      check();
      const page = await pdf.getPage(i + 1);
      const text = pageText(await page.getTextContent());
      const chars = text.replace(/\s/g, "").length;
      pages[i] = text;
      // Scans often carry a sparse, garbled text layer (a few words a copier's OCR caught),
      // which used to skip real OCR and drop the page. Image pages with little text get OCR too.
      if (chars < MIN_CHARS_PER_PAGE || (chars < SPARSE_SCAN_CHARS && (await hasImage(page)))) {
        prog.found++;
        jobs.push(withOcr(signal, async (ocr) => {
          check();
          const canvas = await renderPage(page);
          check();
          const ocrText = await ocrCanvas(ocr, canvas, check, (f) => { prog.partial.set(i, f); report(); });
          canvas.width = canvas.height = 0;
          if (ocrText.replace(/\s/g, "").length > chars * 1.3) { pages[i] = ocrText; ocrPages++; }
        }).finally(() => { page.cleanup(); prog.partial.delete(i); prog.ocrDone++; report(); }));
      } else page.cleanup();
      prog.read++;
      report();
    }
    const failed = (await Promise.allSettled(jobs)).find((s) => s.status === "rejected");
    if (failed) throw failed.reason;
  } finally {
    // in-flight OCR still renders from this document; let it settle before teardown
    await Promise.allSettled(jobs);
    // pdf.js ≥5 tears down via the loading task; older builds expose doc.destroy()
    try { await (task.destroy?.() ?? pdf.destroy?.()); } catch {}
  }
  onProgress("Done", 1);
  // A scanned book spread is OCR'd as two halves joined by a page break, so text segments
  // (form-feed separated) can outnumber PDF pages. segPages[k] = PDF page of segment k.
  const segPages = pages.flatMap((t, i) => new Array((t.match(/\f/g)?.length || 0) + 1).fill(i));
  return { text: pages.join(PAGE_BREAK), ocrPages, pages: n, segPages };
}

function pageText(content) {
  // Rebuild lines from positioned text runs, then paragraphs from vertical gaps.
  const lines = [];
  let cur = "";
  let lastY = null, lastH = 12;
  const gaps = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const y = item.transform[5];
    const h = Math.abs(item.transform[3]) || item.height || lastH;
    if (lastY !== null && Math.abs(y - lastY) > h * 0.5 && cur) {
      lines.push({ text: cur, y: lastY, h: lastH });
      cur = "";
    }
    cur += item.str;
    if (item.hasEOL) { lines.push({ text: cur, y, h }); cur = ""; lastY = null; lastH = h; continue; }
    lastY = y; lastH = h;
  }
  if (cur) lines.push({ text: cur, y: lastY ?? 0, h: lastH });

  // pdf.js emits empty runs at line ends. Some scans' text layers (archive.org, Google Books)
  // do it on every line; read as blank lines they made each printed line its own paragraph.
  // Paragraphs come from the vertical gaps below instead.
  for (let i = lines.length - 1; i >= 0; i--) if (!lines[i].text.trim()) lines.splice(i, 1);
  for (let i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1].y - lines[i].y));
  const typical = median(gaps.filter((g) => g > 0)) || 14;

  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text.replace(/\s+/g, " ").trim();
    if (i > 0) {
      const gap = Math.abs(lines[i - 1].y - lines[i].y);
      const paraBreak = gap > typical * 1.6;
      if (paraBreak) out = out.trimEnd() + "\n\n";
      else if (/[A-Za-z]-$/.test(out)) out = out.slice(0, -1); // re-join hyphenated words
      else out += " ";
    }
    out += t;
  }
  return out.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function renderPage(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, 2000 / Math.max(base.width, base.height)); // ~300 dpi equivalent, capped
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  return canvas;
}

// ---------------------------------------------------------------- OCR

async function hasImage(page) {
  const { fnArray } = await page.getOperatorList();
  const { OPS } = pdfjs;
  return fnArray.some((fn) => fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject);
}

// Phone photos are 12–48 MP; Tesseract time grows with pixels and gains nothing past
// ~300 dpi for a page, so the long side is capped (PDF pages render to 2000px).
const MAX_IMAGE_SIDE = 2400;

async function imageToCanvas(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * s);
  canvas.height = Math.round(bmp.height * s);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas;
}

// OCR a page image. A scanned book spread (two pages side by side) is read one page at a
// time: fed whole, Tesseract stitches lines across both pages ("left line + right line"),
// which turned Breen-style scans into ~56% in-order text. Per-page halves measured 99%.
async function ocrCanvas(ocr, canvas, check, onFrac = () => {}) {
  const parts = [];
  const halves = spreadHalves(canvas);
  for (const [k, rectangle] of halves.entries()) {
    check();
    ocr.progress = (p) => onFrac((k + p) / halves.length);
    let { data } = await ocr.recognize(canvas, rectangle ? { rectangle } : {});
    // Covers, photos and blank leaves come back as a handful of symbols ("4 t : £ |");
    // a sideways text page comes back as many garbled tokens with almost no real words
    // (~4%) — only that is worth rotating. A rough upright typed page still reads ~30% words.
    if (!rectangle && data.confidence < LOW_CONFIDENCE && tokensOf(data.text) >= 20 && wordlikeShare(data.text) < 0.15) data = await bestRotation(ocr, canvas, data, check);
    if (looksLikeNoise(data)) continue;
    parts.push(joinBrokenParas(cleanOcr(data.text)));
  }
  ocr.progress = null;
  check();
  return parts.filter(Boolean).join(PAGE_BREAK);
}

// A page scanned sideways or upside down reads as confident-looking garbage
// ("HR ei gg g 2") at ~20% confidence; upright text scores 80–95. Only low-confidence
// pages pay for the extra passes. Candidates are tried on a half-size copy (~3× cheaper);
// only a clear winner is re-read at full size.
async function bestRotation(ocr, canvas, first, check) {
  const small = scaleCanvas(canvas, 0.5);
  let bestDeg = 0, bestConf = first.confidence;
  try {
    for (const deg of [90, 270, 180]) {
      check();
      const turned = rotateCanvas(small, deg);
      const { data } = await ocr.recognize(turned);
      turned.width = turned.height = 0;
      if (data.confidence > bestConf + 15) { bestDeg = deg; bestConf = data.confidence; }
      if (bestConf >= 75) break;
    }
  } finally { small.width = small.height = 0; }
  if (!bestDeg) return first;
  check();
  const turned = rotateCanvas(canvas, bestDeg);
  const { data } = await ocr.recognize(turned);
  turned.width = turned.height = 0;
  return data.confidence > first.confidence ? data : first;
}

function scaleCanvas(src, s) {
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * s);
  c.height = Math.round(src.height * s);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c;
}

const tokensOf = (text) => text.split(/\s+/).filter(Boolean).length;
const WORDLIKE = /^[\p{L}][\p{Ll}]{2,}[.,;:!?'’"”)]*$/u;
function wordlikeShare(text) {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length ? words.filter((w) => WORDLIKE.test(w)).length / words.length : 0;
}

// OCR of a picture (cover, engraving, seal): low confidence and almost nothing that looks
// like a word. A rough typed memo still yields dozens of real words among the junk
// (a 1960s routing slip: 65 of 219), so this only drops pages with a few stray words at most.
function looksLikeNoise(data) {
  if (data.confidence >= 50) return false;
  const words = data.text.split(/\s+/).filter(Boolean);
  const wordlike = words.filter((w) => WORDLIKE.test(w)).length;
  return wordlike < 8 && wordlike < words.length * 0.4;
}

function rotateCanvas(src, deg) {
  const c = document.createElement("canvas");
  const side = deg % 180 !== 0;
  c.width = side ? src.height : src.width;
  c.height = side ? src.width : src.height;
  const ctx = c.getContext("2d");
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

// Tesseract often puts a blank line after every printed line of an indented quote or a
// page's first lines, so one paragraph comes out as many 1-line "paragraphs". That breaks
// paragraph pauses and makes "skip this paragraph" skip half a sentence. Rejoin a break
// when the text before it plainly continues (hyphenated, or no closing punctuation and the
// next part starts lower-case) — but never glue a running head / page number onto prose.
export function joinBrokenParas(text) {
  const out = [];
  for (const p of text.split(/\n{2,}/)) {
    const prev = out[out.length - 1];
    if (prev && /^[a-z]/.test(p) && !/[.!?:;"”’)\]]$/.test(prev) && !headerLike(prev)) {
      out[out.length - 1] = /[A-Za-z]-$/.test(prev) ? prev.slice(0, -1) + p : `${prev} ${p}`;
    } else out.push(p);
  }
  return out.join("\n\n");
}

function headerLike(p) {
  const words = p.split(/\s+/).filter((w) => w.replace(/\W/g, "").length > 1 || /\d/.test(w)); // drop OCR crumbs like "}" "J"
  if (!words.length) return true;
  if (words.length > 10) return false;
  const letters = p.replace(/[^A-Za-z]/g, "");
  const edge = (w) => /^\W*(\d+|[ivxlcdm]{1,6})\W*$/i.test(w);
  return letters.replace(/[^A-Z]/g, "").length > letters.length * 0.6 || edge(words[0]) || edge(words[words.length - 1]);
}

/** Returns [null] for a single page, or two rectangles split at the book gutter. */
export function spreadHalves(canvas) {
  const w = canvas.width, h = canvas.height;
  if (w < h * 1.15) return [null]; // portrait → one page
  const { data } = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h);
  const x = findGutter(data, w, h);
  if (x == null) return [null];
  return [{ left: 0, top: 0, width: x, height: h }, { left: x, top: 0, width: w - x, height: h }];
}

// Text columns have many dark↔light transitions per pixel column; the gutter (blank or a
// smooth shadow) has almost none. Find the widest quiet run in the middle 38–62%.
export function findGutter(rgba, w, h) {
  const trans = new Float32Array(w);
  const step = h > 1200 ? 2 : 1;
  for (let x = 0; x < w; x++) {
    let prev = false, t = 0;
    for (let y = 0; y < h; y += step) {
      const i = (y * w + x) * 4;
      const ink = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114 < 110;
      if (ink !== prev && y) t++;
      prev = ink;
    }
    trans[x] = t;
  }
  const k = Math.max(3, Math.floor(w / 200));
  const sm = new Float32Array(w);
  let acc = 0;
  for (let x = 0; x < w; x++) {
    acc += trans[x] - (x >= k ? trans[x - k] : 0);
    sm[Math.max(0, x - (k >> 1))] = acc / k;
  }
  const sorted = Array.from(sm).sort((a, b) => a - b);
  const thr = Math.max(1, sorted[Math.floor(w * 0.6)] * 0.05);
  const lo = Math.floor(w * 0.38), hi = Math.floor(w * 0.62);
  let best = 0, bestStart = -1, run = 0, start = 0;
  for (let x = lo; x < hi; x++) {
    if (sm[x] <= thr) {
      if (!run) start = x;
      if (++run > best) { best = run; bestStart = start; }
    } else run = 0;
  }
  if (best < w * 0.01) return null;
  return bestStart + (best >> 1);
}

// A small pool of Tesseract workers. Each OCRs one page at a time on its own core, so a
// scanned book goes ~N× faster. Workers start lazily (the 2nd+ only once a 2nd scanned
// page is waiting), share one cached copy of the language data, and stay warm for the next file.
// Each worker holds ~80 MB, so phones (coarse pointer) get two.
const POOL_MAX = Math.max(1, Math.min(matchMedia("(pointer: coarse)").matches ? 2 : 4, (navigator.hardwareConcurrency || 2) - 1));
const pool = { all: [], idle: [], waiting: [], starting: 0, gen: 0, aborts: new Set() };

function startWorker() {
  pool.starting++;
  const gen = pool.gen;
  const slot = {};
  import("tesseract.js")
    .then(({ createWorker }) => createWorker("eng", 1, { logger: (m) => { if (m.status === "recognizing text") slot.w?.progress?.(m.progress); } }))
    .then((w) => {
      if (gen !== pool.gen) return w.terminate(); // stopOcr() ran while it was loading
      slot.w = w; pool.all.push(w); release(w);
    })
    .catch((e) => { pool.waiting.splice(0).forEach((q) => q.reject(e)); })
    .finally(() => { if (gen === pool.gen) pool.starting--; });
}

function release(w) {
  if (!pool.all.includes(w)) return; // terminated by stopOcr()
  const next = pool.waiting.shift();
  if (next) next.resolve(w);
  else pool.idle.push(w);
}

function acquire() {
  if (pool.idle.length) return Promise.resolve(pool.idle.pop());
  const q = {};
  q.promise = new Promise((resolve, reject) => Object.assign(q, { resolve, reject }));
  pool.waiting.push(q);
  // grow while there's more queued work than workers coming
  if (pool.all.length + pool.starting < POOL_MAX && pool.waiting.length > pool.starting) startWorker();
  return q.promise;
}

async function withOcr(signal, fn) {
  if (signal.cancelled) throw new Cancelled();
  const gen = pool.gen;
  const live = await acquire();
  // After stopOcr() the worker is gone; a late recognize() from the still-running job body
  // would postMessage into null, so it throws Cancelled instead. `progress` is read by the
  // worker's logger (see startWorker), so it lives on the real worker.
  const w = {
    recognize: (...a) => { if (gen !== pool.gen || signal.cancelled) throw new Cancelled(); return live.recognize(...a); },
    set progress(fn) { live.progress = fn; },
  };
  // a terminated worker never settles its pending recognize(); stopOcr() rejects this instead
  let abort;
  const aborted = new Promise((_, reject) => { abort = () => reject(new Cancelled()); });
  pool.aborts.add(abort);
  try {
    if (signal.cancelled) throw new Cancelled();
    return await Promise.race([fn(w), aborted]);
  } finally {
    pool.aborts.delete(abort);
    live.progress = null;
    release(live);
  }
}

export async function stopOcr() {
  pool.gen++;
  pool.starting = 0;
  const ws = pool.all.splice(0);
  pool.idle.length = 0;
  pool.waiting.splice(0).forEach((q) => q.reject(new Cancelled()));
  [...pool.aborts].forEach((abort) => abort());
  pool.aborts.clear();
  await Promise.allSettled(ws.map((w) => w.terminate()));
}

function cleanOcr(text) {
  return text
    .replace(/([A-Za-z])-\n([a-z])/g, "$1$2")       // hyphenated line breaks
    .replace(/([^\n])\n(?!\n)/g, "$1 ")             // single newlines → spaces
    .replace(/[|¦]{1,2}(?=\s)/g, "")                 // common OCR junk
    .replace(/[ \t]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------- other formats

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,nav,footer,header,svg").forEach((n) => n.remove());
  doc.querySelectorAll("p,div,br,li,h1,h2,h3,h4,h5,h6,section,article,blockquote,tr").forEach((n) => n.append("\n\n"));
  return (doc.body?.textContent || "").replace(/\n\s*\n+/g, "\n\n");
}

function rtfToText(rtf) {
  return rtf
    .replace(/\\par[d]?/g, "\n")
    .replace(/\{\\\*[^{}]*\}/g, "")
    .replace(/\\'[0-9a-f]{2}/gi, "")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "")
    .trim();
}

function markdownToText(md) {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^-{3,}$/gm, "");
}

function looksBinary(s) {
  const sample = s.slice(0, 2000);
  let bad = 0;
  for (const ch of sample) { const c = ch.charCodeAt(0); if (c === 0xfffd || (c < 9) || (c > 13 && c < 32)) bad++; }
  return sample.length > 0 && bad / sample.length > 0.05;
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
