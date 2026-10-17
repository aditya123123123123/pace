// "Pages": where you are in a PDF, and a way to jump anywhere in it while looking at it.
// A page counter sits by the scrubber; it opens a sheet of the PDF's real pages (rendered
// lazily from the original file, kept on this device). Tap a page to continue from there.
// Docs without the original file (opened before previews existed) get text cards instead.
import { openPdf } from "./extract.js";
import { pageTarget } from "./pages.js";
import * as store from "./store.js";

const $ = (s) => document.querySelector(s);
const el = {
  btn: $("#page-btn"), num: $("#page-num"), of: $("#page-of"), done: $("#t-done"),
  scrub: $("#scrub"), tip: $("#scrub-tip"), keyHint: $("#key-pages"),
  sheet: $("#pager"), grid: $("#pager-grid"), sub: $("#pager-sub"), note: $("#pager-note"), close: $("#pager-done"),
};
const THUMB_W = 180;   // css px; rendered at devicePixelRatio
const CONCURRENCY = 2; // pdf.js renders off the main thread, but each page still costs a decode

/**
 * @param {object} S  shared reader state (tokens, mask, i, doc, pages, file)
 * @param {{jump: (i: number, page: number) => void, pause: () => void, percent: () => number}} api
 */
export function initPages(S, api) {
  let gen = 0;            // bumps per document so late renders from an old doc are dropped
  let pdfTask = null;     // pdf.js loading task for previews (opened on first use)
  let pdfP = null;        // Promise<PDFDocumentProxy | null>
  let urls = new Map();   // page → object URL of its rendered preview
  let built = false;
  let io = null;
  const queue = [];
  let active = 0;

  const isPdf = () => (S.pages?.n || 0) > 1;
  const cur = () => (S.pages ? S.pages.of[S.i] ?? 0 : 0);

  // ------------------------------------------------------------ counter + scrub tip
  function update() {
    if (!isPdf()) return;
    const p = cur() + 1;
    el.num.textContent = p;
    el.btn.setAttribute("aria-label", `Page ${p} of ${S.pages.n}. Show pages`);
    el.scrub.setAttribute("aria-valuetext", `Page ${p} of ${S.pages.n}, ${Math.round(api.percent() * 100)}%`);
    if (!el.sheet.hidden) markCurrent();
  }

  let tipTimer = 0;
  function showTip() {
    if (!isPdf()) return;
    clearTimeout(tipTimer);
    const max = +el.scrub.max || 1;
    el.tip.textContent = `Page ${cur() + 1}`;
    el.tip.style.setProperty("--x", String(+el.scrub.value / max));
    el.tip.classList.add("show");
  }
  const hideTip = () => { clearTimeout(tipTimer); tipTimer = setTimeout(() => el.tip.classList.remove("show"), 500); };
  el.scrub.addEventListener("input", showTip);
  el.scrub.addEventListener("pointerdown", showTip);
  for (const ev of ["change", "pointerup", "pointercancel", "blur"]) el.scrub.addEventListener(ev, hideTip);

  // ------------------------------------------------------------ doc lifecycle
  function onOpen() {
    release();
    const on = isPdf();
    el.btn.hidden = !on;
    el.done.hidden = on;
    el.keyHint.hidden = !on;
    el.tip.classList.remove("show");
    if (on) { el.of.textContent = S.pages.n; update(); }
    else el.scrub.removeAttribute("aria-valuetext");
  }

  function release() {
    gen++;
    close();
    io?.disconnect(); io = null;
    queue.length = 0;
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls = new Map();
    built = false;
    el.grid.replaceChildren();
    const t = pdfTask; pdfTask = null; pdfP = null;
    try { t?.destroy(); } catch {}
  }

  function loadPdf() {
    if (pdfP) return pdfP;
    const g = gen;
    pdfP = (async () => {
      const src = S.file ? await S.file.arrayBuffer() : await store.getFile(S.doc.id).catch(() => null);
      if (!src || g !== gen) return null;
      const task = openPdf(new Uint8Array(src));
      if (g !== gen) { task.destroy(); return null; }
      pdfTask = task;
      const pdf = await task.promise;
      // a file that doesn't match the text (shouldn't happen: same id = same text) → no previews
      return pdf.numPages === S.pages.n ? pdf : null;
    })().catch(() => null);
    return pdfP;
  }

  // ------------------------------------------------------------ the sheet
  async function open() {
    if (!isPdf()) return;
    api.pause();
    el.sheet.hidden = false;
    document.body.classList.add("sheet-open");
    if (!built) await build();
    else refreshState();
    markCurrent();
    el.grid.querySelector(".pg.here")?.scrollIntoView({ block: "center" });
    el.close.focus({ preventScroll: true });
  }

  function close() {
    if (el.sheet.hidden) return;
    el.sheet.hidden = true;
    document.body.classList.remove("sheet-open");
    el.btn.focus({ preventScroll: true });
  }

  async function build() {
    built = true;
    const g = gen;
    const { n, start, end } = S.pages;
    const pdf = await loadPdf();
    if (g !== gen) return;
    let ratio = 11 / 8.5;
    if (pdf) {
      try { const v = (await pdf.getPage(1)).getViewport({ scale: 1 }); ratio = v.height / v.width; } catch {}
    }
    el.note.hidden = !!pdf;
    el.grid.classList.toggle("wide", ratio < 0.9); // scanned spreads: fewer, bigger tiles
    const frag = document.createDocumentFragment();
    for (let p = 0; p < n; p++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pg";
      b.dataset.p = p;
      const words = start[p] < 0 ? 0 : end[p] - start[p];
      b.setAttribute("aria-label", `Page ${p + 1}${words ? "" : ", no text"}`);
      const sheet = document.createElement("span");
      sheet.className = "pg-sheet";
      sheet.style.aspectRatio = `1 / ${ratio}`;
      if (!pdf) {
        const t = document.createElement("span");
        t.className = "pg-text";
        t.textContent = words ? S.tokens.slice(start[p], Math.min(end[p], start[p] + 60)).map((x) => x.w).join(" ") : "";
        sheet.append(t);
      }
      if (!words) b.classList.add("blank");
      else if (skippedAll(start[p], end[p])) b.classList.add("skipped");
      const bar = document.createElement("span");
      bar.className = "pg-prog";
      sheet.append(bar);
      const num = document.createElement("span");
      num.className = "pg-num";
      num.textContent = p + 1;
      b.append(sheet, num);
      frag.append(b);
    }
    el.grid.replaceChildren(frag);
    if (pdf) watch(pdf, g);
  }

  function skippedAll(a, b) {
    for (let k = a; k < b; k++) if (!S.mask[k]) return false;
    return true;
  }
  // skips may have changed since the grid was built
  function refreshState() {
    const { start, end } = S.pages;
    for (const b of el.grid.children) {
      const p = +b.dataset.p;
      b.classList.toggle("skipped", start[p] >= 0 && skippedAll(start[p], end[p]));
    }
  }

  function markCurrent() {
    const p = cur();
    const { start, end } = S.pages;
    for (const b of el.grid.querySelectorAll(".pg.here")) if (+b.dataset.p !== p) b.classList.remove("here");
    const b = el.grid.children[p];
    if (!b) return;
    b.classList.add("here");
    b.setAttribute("aria-current", "page");
    const f = end[p] > start[p] ? (S.i - start[p]) / (end[p] - start[p]) : 0;
    b.querySelector(".pg-prog").style.setProperty("--f", `${f * 100}%`);
    b.classList.toggle("started", f > 0);
    const pct = Math.round(api.percent() * 100);
    el.sub.textContent = `Page ${p + 1} of ${S.pages.n} · ${pct}% read`;
    for (const x of el.grid.querySelectorAll("[aria-current]")) if (x !== b) x.removeAttribute("aria-current");
  }

  el.grid.addEventListener("click", (e) => {
    const b = e.target.closest(".pg");
    if (!b) return;
    const p = +b.dataset.p;
    close();
    api.jump(pageTarget(S.pages, p), p);
  });
  el.close.addEventListener("click", close);
  el.btn.addEventListener("click", (e) => { e.stopPropagation(); open(); });

  // ------------------------------------------------------------ lazy previews
  function watch(pdf, g) {
    io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        queue.push(+en.target.dataset.p);
      }
      pump(pdf, g);
    }, { root: el.grid, rootMargin: "600px 0px" });
    for (const b of el.grid.children) io.observe(b);
  }

  function pump(pdf, g) {
    // nearest-to-current first, so the page you're on shows up before the rest
    const here = cur();
    queue.sort((a, b) => Math.abs(b - here) - Math.abs(a - here));
    while (active < CONCURRENCY && queue.length) {
      const p = queue.pop();
      if (urls.has(p)) continue;
      active++;
      render(pdf, p, g)
        .then((url) => {
          if (g !== gen) { if (url) URL.revokeObjectURL(url); return; }
          if (!url) return;
          urls.set(p, url);
          const img = new Image();
          img.alt = "";
          img.decoding = "async";
          img.src = url;
          el.grid.children[p]?.querySelector(".pg-sheet").prepend(img);
        })
        .catch(() => {})
        .finally(() => { active--; if (g === gen) pump(pdf, g); });
    }
  }

  async function render(pdf, p, g) {
    const page = await pdf.getPage(p + 1);
    try {
      if (g !== gen) return null;
      const v1 = page.getViewport({ scale: 1 });
      const scale = (THUMB_W * Math.min(2, devicePixelRatio || 1)) / v1.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
      const sheet = el.grid.children[p]?.querySelector(".pg-sheet");
      if (sheet) sheet.style.aspectRatio = `${v1.width} / ${v1.height}`;
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
      canvas.width = canvas.height = 0;
      return blob ? URL.createObjectURL(blob) : null;
    } finally {
      page.cleanup();
    }
  }

  return { onOpen, update, open, close, release, isOpen: () => !el.sheet.hidden };
}
