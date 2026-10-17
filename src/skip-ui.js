// "Skip parts": the editor sheet, the first-open suggestion chip, scrubber marks and
// the in-reader toast. Playback reads the shared mask (S.mask); this module only edits it.
import { paragraphs, countSkipped, rangesOf, suggestHeaders } from "./skips.js";

const $ = (s) => document.querySelector(s);
const el = {
  btn: $("#skip-btn"), count: $("#skip-count"),
  chip: $("#skip-chip"), chipText: $("#skip-chip-text"), chipYes: $("#skip-chip-yes"), chipReview: $("#skip-chip-review"), chipNo: $("#skip-chip-no"),
  toast: $("#skip-toast"), marks: $("#skipmarks"),
  sheet: $("#skipper"), body: $("#skipper-body"), done: $("#skipper-done"), clear: $("#skipper-clear"), stat: $("#skipper-stat"),
  sugg: $("#skipper-sugg"), suggText: $("#skipper-sugg-text"), suggBtn: $("#skipper-sugg-btn"),
  selBar: $("#sel-actions"), selSkip: $("#sel-skip"), selKeep: $("#sel-keep"),
};

/**
 * @param {object} S  shared reader state (tokens, mask, i, doc)
 * @param {{changed: () => void, pause: () => void, fmt: (ms: number) => string, beatMs: () => number, save: (fields: object) => void}} api
 */
export function initSkips(S, api) {
  let paras = [];        // [a, b) per paragraph
  let suggested = [];    // header/page-number ranges, offered never applied silently
  let sel = null;        // [lo, hi) token range of the current text selection in the sheet
  let toastTimer = 0;

  // ------------------------------------------------------------ doc open
  function onOpen() {
    paras = paragraphs(S.tokens);
    suggested = suggestHeaders(S.tokens).filter(([a, b]) => countSkipped(S.mask, a, b) < b - a);
    refresh();
    const offer = suggested.length >= 2 && !S.doc.skipPrompt;
    el.chip.hidden = !offer;
    if (offer) el.chipText.textContent = `${suggested.length} page headers & page numbers found`;
  }

  function dismissChip() {
    el.chip.hidden = true;
    S.doc.skipPrompt = "done";
    api.save({ skipPrompt: "done" });
  }

  function skipSuggested() {
    for (const [a, b] of suggested) S.mask.fill(1, a, b);
    commit();
  }

  el.chipYes.addEventListener("click", (e) => {
    e.stopPropagation();
    const n = suggested.length;
    skipSuggested();
    dismissChip();
    toast(`Skipping ${n} headers · tap Skip parts to undo`);
  });
  el.chipReview.addEventListener("click", (e) => { e.stopPropagation(); dismissChip(); open(); });
  el.chipNo.addEventListener("click", (e) => { e.stopPropagation(); dismissChip(); });

  // ------------------------------------------------------------ state → UI
  function commit() {
    api.changed();
    refresh();
    api.save({ skips: { n: S.tokens.length, ranges: rangesOf(S.mask) }, skipped: countSkipped(S.mask) });
  }

  function refresh() {
    const n = S.tokens.length;
    const k = countSkipped(S.mask);
    el.count.hidden = !k;
    el.count.textContent = k ? k.toLocaleString() : "";
    el.btn.classList.toggle("on", k > 0);
    el.btn.setAttribute("aria-label", k ? `Skip parts: ${k} words skipped` : "Choose parts to skip");
    // scrubber: one faint hatched block per skipped run
    const span = Math.max(1, n - 1);
    el.marks.replaceChildren(...rangesOf(S.mask).map(([a, b]) => {
      const m = document.createElement("i");
      m.style.left = `${(a / span) * 100}%`;
      m.style.width = `max(2px, ${((b - a) / span) * 100}%)`;
      return m;
    }));
    if (!el.sheet.hidden) paintSheet();
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 1800);
  }

  // ------------------------------------------------------------ the sheet
  function open() {
    api.pause();
    el.chip.hidden = true;
    build();
    el.sheet.hidden = false;
    document.body.classList.add("sheet-open");
    // land on what you were just reading
    const cur = paras.findIndex(([a, b]) => S.i >= a && S.i < b);
    const p = el.body.children[Math.max(0, cur)];
    p?.classList.add("here");
    p?.scrollIntoView({ block: "center" });
    el.done.focus({ preventScroll: true });
  }

  function close() {
    if (el.sheet.hidden) return;
    el.sheet.hidden = true;
    document.body.classList.remove("sheet-open");
    getSelection()?.removeAllRanges();
    sel = null;
    el.body.replaceChildren(); // big docs: don't keep thousands of spans alive
    el.btn.focus({ preventScroll: true });
  }

  function build() {
    const frag = document.createDocumentFragment();
    const sug = new Set(suggested.map(([a]) => a));
    for (const [a, b] of paras) {
      const p = document.createElement("p");
      p.className = "sp-para";
      p.dataset.a = a; p.dataset.b = b;
      if (sug.has(a)) p.classList.add("sugg");
      for (let i = a; i < b; i++) {
        if (i > a && !S.tokens[i].cont) p.append(" ");
        const s = document.createElement("span");
        s.dataset.i = i;
        s.textContent = S.tokens[i].w;
        p.append(s);
      }
      frag.append(p);
    }
    el.body.replaceChildren(frag);
    paintSheet();
  }

  function paintSheet() {
    for (const p of el.body.children) {
      const a = +p.dataset.a, b = +p.dataset.b;
      const k = countSkipped(S.mask, a, b);
      p.classList.toggle("off", k === b - a);
      p.classList.toggle("part", k > 0 && k < b - a);
      if (k > 0 && k < b - a) for (const s of p.children) s.classList.toggle("x", !!S.mask[+s.dataset.i]);
      else for (const s of p.querySelectorAll(".x")) s.classList.remove("x");
    }
    const k = countSkipped(S.mask);
    let saved = 0;
    for (let i = 0; i < S.tokens.length; i++) if (S.mask[i]) saved += S.tokens[i].units;
    el.stat.textContent = k
      ? `${k.toLocaleString()} word${k === 1 ? "" : "s"} skipped · saves ${api.fmt(saved * api.beatMs())}`
      : "Nothing skipped yet";
    el.clear.hidden = !k;
    const pending = suggested.filter(([a, b]) => countSkipped(S.mask, a, b) < b - a);
    el.sugg.hidden = pending.length < 1;
    el.suggText.textContent = `${pending.length} likely page header${pending.length === 1 ? "" : "s"} marked “Header?”`;
  }

  // tap a paragraph → skip it (or bring it back)
  el.body.addEventListener("click", (e) => {
    if (!getSelection().isCollapsed) return; // that was a drag-select, not a tap
    const p = e.target.closest(".sp-para");
    if (!p) return;
    const a = +p.dataset.a, b = +p.dataset.b;
    S.mask.fill(countSkipped(S.mask, a, b) === b - a ? 0 : 1, a, b);
    commit();
  });

  // select words → skip / keep just those
  document.addEventListener("selectionchange", () => {
    if (el.sheet.hidden) return;
    sel = selectedTokens();
    el.selBar.hidden = !sel;
    el.stat.hidden = !!sel;
  });
  function selectedTokens() {
    const s = getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return null;
    const r = s.getRangeAt(0);
    if (!el.body.contains(r.commonAncestorContainer)) return null;
    const startP = paraOf(r.startContainer) ?? el.body.firstElementChild;
    const endP = paraOf(r.endContainer) ?? el.body.lastElementChild;
    let lo = Infinity, hi = -1;
    for (let p = startP; p; p = p.nextElementSibling) {
      for (const span of p.children) {
        if (r.intersectsNode(span) && span.textContent && !edgeOnly(r, span)) {
          lo = Math.min(lo, +span.dataset.i); hi = Math.max(hi, +span.dataset.i);
        }
      }
      if (p === endP) break;
    }
    return hi < 0 ? null : [lo, hi + 1];
  }
  const paraOf = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest?.(".sp-para") ?? null;
  // a range that merely touches a word's far edge (offset at its end/start) doesn't select it
  function edgeOnly(r, span) {
    const t = span.firstChild;
    return (r.startContainer === t && r.startOffset >= t.length) || (r.endContainer === t && r.endOffset === 0);
  }
  for (const [btn, v] of [[el.selSkip, 1], [el.selKeep, 0]]) {
    btn.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the selection alive
    btn.addEventListener("click", () => {
      const r = selectedTokens() || sel; // cached copy covers iOS collapsing the selection on tap
      if (!r) return;
      S.mask.fill(v, r[0], r[1]);
      getSelection().removeAllRanges();
      sel = null; el.selBar.hidden = true; el.stat.hidden = false;
      commit();
    });
  }

  el.suggBtn.addEventListener("click", () => { skipSuggested(); dismissChip(); });
  el.clear.addEventListener("click", () => { S.mask.fill(0); commit(); });
  el.done.addEventListener("click", close);
  el.btn.addEventListener("click", (e) => { e.stopPropagation(); open(); });

  return { onOpen, open, close, toast, isOpen: () => !el.sheet.hidden, hideChip: () => (el.chip.hidden = true) };
}
