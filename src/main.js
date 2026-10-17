import "./style.css";
import { extractText, Cancelled, stopOcr } from "./extract.js";
import { tokenize, orpIndex, sentenceStarts, prefixUnits, recomputeUnits } from "./rsvp.js";
import * as store from "./store.js";
import { maskFrom, nextReadable, countSkipped } from "./skips.js";
import { initSkips } from "./skip-ui.js";
import { pageIndex } from "./pages.js";
import { initPages } from "./pages-ui.js";
import { SAMPLE } from "./sample.js";

const $ = (s) => document.querySelector(s);
const els = {
  home: $("#home"), reader: $("#reader"),
  dropzone: $("#dropzone"), fileInput: $("#file-input"), chooseBtn: $("#choose-btn"),
  idle: $(".dz-idle"), busy: $(".dz-busy"), busyName: $("#busy-name"), busyStatus: $("#busy-status"), busyBar: $("#busy-bar"),
  cancelBtn: $("#cancel-btn"), error: $("#error"),
  pasteText: $("#paste-text"), pasteGo: $("#paste-go"), pasteCount: $("#paste-count"),
  recents: $("#recents"), recentList: $("#recent-list"), sampleBtn: $("#sample-btn"),
  backBtn: $("#back-btn"), docTitle: $("#doc-title"),
  stage: $("#stage"), word: $("#word"), wl: $(".w-left"), wp: $(".w-pivot"), wr: $(".w-right"),
  hint: $("#stage-hint"), context: $("#context"),
  scrub: $("#scrub"), tDone: $("#t-done"), tLeft: $("#t-left"),
  play: $("#play-btn"), prev: $("#prev-btn"), next: $("#next-btn"),
  wpmDown: $("#wpm-down"), wpmUp: $("#wpm-up"), wpmBtn: $("#wpm-btn"), wpmNum: $("#wpm-num"),
  speed: $("#speed"), speedNum: $("#speed-num"), wpmRange: $("#wpm-range"), presets: $("#presets"),
  settingsBtn: $("#settings-btn"), settings: $("#settings"),
  sizeSeg: $("#size-seg"), chunkSeg: $("#chunk-seg"), punct: $("#punct-toggle"), orp: $("#orp-toggle"),
};

// ------------------------------------------------------------------ prefs
const prefs = Object.assign(
  { wpm: 300, size: "m", chunk: 1, punct: true, orp: true, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" },
  JSON.parse(localStorage.getItem("pace:prefs") || "{}"),
);
const savePrefs = () => localStorage.setItem("pace:prefs", JSON.stringify(prefs));
function applyPrefs() {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.dataset.size = prefs.size;
  root.dataset.orp = prefs.orp ? "on" : "off";
  els.wpmNum.textContent = els.speedNum.textContent = prefs.wpm;
  els.wpmRange.value = prefs.wpm;
  setFill(els.wpmRange);
  els.punct.checked = prefs.punct;
  els.orp.checked = prefs.orp;
  for (const b of els.presets.children) b.classList.toggle("on", +b.dataset.v === prefs.wpm);
  for (const b of els.sizeSeg.children) b.classList.toggle("on", b.dataset.v === prefs.size);
  for (const b of els.chunkSeg.children) b.classList.toggle("on", +b.dataset.v === prefs.chunk);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", prefs.theme === "dark" ? "#0e0e0f" : "#f7f7f5");
}

// ------------------------------------------------------------------ state
const S = {
  doc: null,           // {id, name, ...}
  tokens: [], starts: [], prefix: null,
  mask: new Uint8Array(0), // 1 = the reader chose to skip this token
  pages: null,         // PDF page of every token (pages.js), null for one-page docs
  file: null,          // the original PDF while it is still in memory (page previews)
  i: 0, playing: false, timer: 0, nextAt: 0,
};

// ------------------------------------------------------------------ home: input
let job = null;

function showError(msg) { els.error.textContent = msg; els.error.hidden = !msg; }
function setBusy(on, name = "") {
  els.idle.hidden = on; els.busy.hidden = !on;
  els.dropzone.classList.toggle("busy", on);
  els.busyName.textContent = name;
  els.busyBar.style.width = "0%";
  els.busyBar.classList.remove("indeterminate");
}

async function handleFile(file) {
  if (!file || job) return;
  showError("");
  if (file.size > 200 * 1024 * 1024) return showError("That file is over 200 MB — try a smaller one.");
  const signal = { cancelled: false };
  job = signal;
  setBusy(true, file.name);
  try {
    const { text, ocrPages, pages, segPages } = await extractText(file, {
      signal,
      onProgress(msg, frac) {
        els.busyStatus.textContent = msg;
        if (frac == null) els.busyBar.classList.add("indeterminate");
        else { els.busyBar.classList.remove("indeterminate"); els.busyBar.style.width = `${Math.round(frac * 100)}%`; }
      },
    });
    const words = tokenize(text).length;
    if (words < 1) throw new Error("No readable text found in that file.");
    // same text → same id, so re-uploading resumes instead of duplicating
    const doc = await store.saveDoc({ id: await hashText(text), name: stripExt(file.name), kind: kindOf(file.name), text, words, ocrPages, pages, ...(segPages && { segPages }) });
    if (pages > 1 && segPages) {
      // previews in the page navigator; a full disk only costs the thumbnails
      store.saveFile(doc.id, file).catch((e) => console.warn("Couldn't keep the PDF for page previews", e));
      S.file = file;
    }
    openDoc(doc);
  } catch (e) {
    if (!(e instanceof Cancelled) && !signal.cancelled) { console.error(e); showError(e.message || "Something went wrong reading that file."); }
  } finally {
    job = null;
    setBusy(false);
    els.fileInput.value = "";
  }
}

els.chooseBtn.addEventListener("click", (e) => { e.stopPropagation(); els.fileInput.click(); });
els.dropzone.addEventListener("click", () => { if (!job) els.fileInput.click(); });
els.dropzone.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && !job && e.target === els.dropzone) { e.preventDefault(); els.fileInput.click(); } });
els.fileInput.addEventListener("change", () => handleFile(els.fileInput.files[0]));
els.cancelBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (job) { job.cancelled = true; await stopOcr(); }
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if (!isHome() || !hasFiles(e)) return; e.preventDefault(); dragDepth++; els.dropzone.classList.add("drag"); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; els.dropzone.classList.remove("drag"); } });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; els.dropzone.classList.remove("drag");
  if (isHome()) handleFile(e.dataTransfer.files[0]);
});
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
const isHome = () => !els.home.hidden;

// paste image / text anywhere on the home screen
window.addEventListener("paste", (e) => {
  if (!isHome() || e.target === els.pasteText) return;
  const file = [...(e.clipboardData?.files || [])][0];
  if (file) { e.preventDefault(); handleFile(file); return; }
  const text = e.clipboardData?.getData("text");
  if (text && text.trim()) { e.preventDefault(); $("#paste").open = true; els.pasteText.value = text; updatePasteCount(); }
});

function updatePasteCount() {
  const n = els.pasteText.value.split(/\s+/).filter(Boolean).length;
  els.pasteCount.textContent = `${n.toLocaleString()} word${n === 1 ? "" : "s"}`;
  els.pasteGo.disabled = n === 0;
}
els.pasteText.addEventListener("input", updatePasteCount);
els.pasteGo.addEventListener("click", async () => {
  const text = els.pasteText.value;
  const first = text.trim().split(/\s+/).slice(0, 6).join(" ");
  const doc = await store.saveDoc({ id: await hashText(text), name: first.length > 40 ? first.slice(0, 40) + "…" : first || "Pasted text", kind: "Pasted", text, words: tokenize(text).length, ocrPages: 0, pages: 1 });
  els.pasteText.value = ""; updatePasteCount(); $("#paste").open = false;
  openDoc(doc);
});
els.sampleBtn.addEventListener("click", async () => {
  const doc = await store.saveDoc({ id: "sample", name: SAMPLE.title, kind: "Sample", text: SAMPLE.text, words: tokenize(SAMPLE.text).length, ocrPages: 0, pages: 1 });
  openDoc(doc);
});

// ------------------------------------------------------------------ home: recents
async function renderRecents() {
  const docs = await store.listDocs();
  els.recents.hidden = docs.length === 0;
  els.recentList.replaceChildren(...docs.slice(0, 8).map((d) => {
    const li = document.createElement("li");
    const pct = d.words ? Math.min(1, (d.pos || 0) / d.words) : 0;
    const btn = document.createElement("button");
    btn.className = "recent";
    const started = (d.pos || 0) > 0;
    btn.innerHTML = `
      <span class="r-name"></span>
      <span class="r-meta"></span>
      <span class="r-pct">
        ${started ? `<span class="r-pct-num">${pct >= 0.995 ? "Done" : Math.round(pct * 100) + "%"}</span>
        <svg class="ring" viewBox="0 0 22 22" aria-hidden="true">
          <circle cx="11" cy="11" r="8.5" fill="none" stroke="var(--line-2)" stroke-width="3"/>
          <circle cx="11" cy="11" r="8.5" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"
            stroke-dasharray="${Math.max(1.5, pct * 53.4).toFixed(2)} 53.4" transform="rotate(-90 11 11)"/>
        </svg>` : `<span class="r-pct-num">New</span>`}
        <span class="icon-btn sm r-del" role="button" tabindex="0" aria-label="Remove ${escapeAttr(d.name)}">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </span>
      </span>`;
    btn.querySelector(".r-name").textContent = d.name;
    const skipped = Math.min(d.skipped || 0, Math.max(0, d.words - (d.pos || 0))); // approx: skips ahead of you
    const leftMin = (d.words - (d.pos || 0) - skipped) / prefs.wpm;
    const left = leftMin < 1 ? "<1 min" : `${Math.round(leftMin)} min`;
    const meta = [d.kind, `${d.words.toLocaleString()} words`, pct >= 0.995 ? "finished" : `${left} left`, d.ocrPages ? "OCR" : "", ago(d.opened)];
    const metaEl = btn.querySelector(".r-meta");
    meta.filter(Boolean).forEach((m) => {
      const s = document.createElement("span");
      s.textContent = m;
      if (m === ago(d.opened)) s.className = "r-ago";
      metaEl.append(s);
    });
    btn.setAttribute("aria-label", `${d.name}, ${Math.round(pct * 100)}% read`);
    btn.addEventListener("click", async (e) => {
      if (e.target.closest(".r-del")) { e.stopPropagation(); await store.deleteDoc(d.id); renderRecents(); return; }
      const full = await store.getDoc(d.id);
      if (full) openDoc(full);
    });
    btn.addEventListener("keydown", async (e) => {
      if (e.target.closest(".r-del") && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); await store.deleteDoc(d.id); renderRecents(); }
    });
    li.append(btn);
    return li;
  }));
}

// ------------------------------------------------------------------ reader
function openDoc(doc) {
  S.doc = doc;
  S.tokens = tokenize(doc.text);
  recomputeUnits(S.tokens, prefs.punct);
  S.mask = maskFrom(doc.skips, S.tokens.length);
  S.pages = (doc.pages || 1) > 1 ? pageIndex(S.tokens, doc) : null;
  syncSkips();
  S.i = Math.min(doc.pos || 0, Math.max(0, S.tokens.length - 1));
  if (S.i >= S.tokens.length - 1) S.i = 0;
  S.i = readableAt(S.i);
  els.docTitle.textContent = doc.name;
  document.title = `${doc.name} — Pace`;
  els.scrub.max = Math.max(0, S.tokens.length - 1);
  els.home.hidden = true; els.reader.hidden = false;
  els.hint.classList.remove("gone");
  els.hint.innerHTML = S.i > 0 ? `Resuming where you left off · <kbd>Space</kbd> to play` : `Tap or press <kbd>Space</kbd> to start`;
  if (location.hash !== `#read`) history.pushState({ reader: true }, "", "#read");
  render();
  showContext(true);
  skips.onOpen();
  pager.onOpen();
}

// Timing, sentence stops and the start position all ignore skipped words.
function syncSkips() {
  S.prefix = prefixUnits(S.tokens, S.mask);
  const seen = new Set();
  S.starts = sentenceStarts(S.tokens).map((s) => nextReadable(S.mask, s)).filter((s) => s < S.tokens.length && !seen.has(s) && seen.add(s));
  if (!S.starts.length) S.starts = [0];
}
/** i itself if readable, else the next readable word, else the last readable one. */
function readableAt(i) {
  const j = nextReadable(S.mask, i);
  if (j < S.tokens.length) return j;
  for (let k = Math.min(i, S.tokens.length - 1); k >= 0; k--) if (!S.mask[k]) return k;
  return 0;
}

function closeReader() {
  skips.close();
  pager.release();
  S.file = null;
  skips.hideChip();
  pause();
  persistPos();
  els.reader.hidden = true; els.home.hidden = false;
  closePopovers();
  document.title = "Pace — speed reader";
  renderRecents();
}
els.backBtn.addEventListener("click", () => { if (history.state?.reader) history.back(); else closeReader(); });
window.addEventListener("popstate", () => { if (!els.reader.hidden) closeReader(); });

function chunkAt(i) {
  // group up to prefs.chunk words, never across a sentence boundary
  let j = i + 1;
  while (j < S.tokens.length && j - i < prefs.chunk && !S.tokens[j].sentenceStart && !S.tokens[j - 1].paraEnd && !S.mask[j]) j++;
  return [i, j];
}

function render() {
  const t = S.tokens;
  if (!t.length) return;
  const [a, b] = chunkAt(S.i);
  const text = t.slice(a, b).map((x) => x.w).join(" ");
  const p = b - a === 1 ? orpIndex(text) : Math.floor((text.length - 1) * 0.42);
  els.wl.textContent = text.slice(0, p);
  els.wp.textContent = text[p] || "";
  els.wr.textContent = text.slice(p + 1);
  els.word.classList.toggle("long", text.length > 14 && text.length <= 22);
  els.word.classList.toggle("xlong", text.length > 22);
  fitWord();
  updateProgress();
}

// Keep the pivot fixed but never clip: if either half overflows its column,
// scale the whole word down just enough to fit.
function fitWord() {
  els.word.style.fontSize = "";
  if (els.wl.textContent.length + els.wr.textContent.length < 4) return;
  const over = Math.max(
    els.wl.scrollWidth / Math.max(1, els.wl.clientWidth),
    els.wr.scrollWidth / Math.max(1, els.wr.clientWidth),
  );
  if (over > 1) {
    const base = parseFloat(getComputedStyle(els.word).fontSize);
    els.word.style.fontSize = `${Math.max(12, Math.floor((base / over) * 0.97))}px`;
  }
}
window.addEventListener("resize", () => { if (!els.reader.hidden) fitWord(); });

function updateProgress() {
  const n = S.tokens.length;
  els.scrub.value = S.i;
  setFill(els.scrub);
  // progress = share of the reading time behind you, so skipped parts count as read
  const pct = S.prefix[n] > 0 ? S.prefix[S.i] / S.prefix[n] : 1;
  els.tDone.textContent = `${Math.round(pct * 100)}%`;
  const leftMs = (S.prefix[n] - S.prefix[S.i]) * beatMs();
  els.tLeft.textContent = `${fmtTime(leftMs)} left`;
  pager.update();
}
const readFrac = () => (S.prefix[S.tokens.length] > 0 ? S.prefix[S.i] / S.prefix[S.tokens.length] : 1);

const beatMs = () => 60000 / prefs.wpm;

function tick() {
  if (!S.playing) return;
  const [a, b] = chunkAt(S.i);
  let units = 0;
  for (let k = a; k < b; k++) units += S.tokens[k].units;
  const dur = units * beatMs();
  S.nextAt += dur;
  const delay = Math.max(0, S.nextAt - performance.now());
  S.timer = setTimeout(() => {
    const next = nextReadable(S.mask, b);
    if (next >= S.tokens.length) { finish(); return; }
    if (next > b) skips.toast(`Skipped ${(next - b).toLocaleString()} word${next - b === 1 ? "" : "s"}`);
    const crossed = Math.floor(next / 25) > Math.floor(S.i / 25);
    S.i = next;
    render();
    if (crossed) persistPos();
    tick();
  }, delay);
}

function play() {
  if (!S.tokens.length || S.playing) return;
  if (nextReadable(S.mask, S.i + 1) >= S.tokens.length) S.i = readableAt(0); // at the end → from the top
  S.playing = true;
  els.play.classList.add("playing");
  els.play.setAttribute("aria-label", "Pause");
  els.hint.classList.add("gone");
  showContext(false);
  closePopovers();
  render();
  S.nextAt = performance.now() + 120; // brief lead-in so the first word isn't clipped
  tick();
}
function pause() {
  if (!S.playing) return;
  S.playing = false;
  clearTimeout(S.timer);
  els.play.classList.remove("playing");
  els.play.setAttribute("aria-label", "Play");
  persistPos();
  showContext(true);
}
function finish() {
  pause();
  S.i = readableAt(S.tokens.length - 1);
  render();
  const k = countSkipped(S.mask);
  els.hint.innerHTML = `Finished · ${(S.tokens.length - k).toLocaleString()} words${k ? ` (${k.toLocaleString()} skipped)` : ""}. Press <kbd>Space</kbd> to read again`;
  els.hint.classList.remove("gone");
  showContext(false);
  persistPos(S.doc.words);
}
const toggle = () => (S.playing ? pause() : play());

function seek(i, { keepPlaying = true } = {}) {
  const was = S.playing;
  if (was) { clearTimeout(S.timer); S.playing = false; }
  S.i = readableAt(Math.max(0, Math.min(S.tokens.length - 1, i)));
  render();
  if (was && keepPlaying) { S.playing = true; S.nextAt = performance.now() + 250; tick(); }
  else { showContext(true); els.hint.classList.add("gone"); persistPos(); }
}
function sentence(dir) {
  const st = S.starts;
  let k = st.findLastIndex((s) => s <= S.i);
  if (dir < 0) {
    // if we're a few words into a sentence, jump to its start; otherwise previous sentence
    if (k >= 0 && S.i - st[k] < 3 && k > 0) k--;
    seek(st[Math.max(0, k)] ?? 0);
  } else {
    seek(st[k + 1] ?? S.tokens.length - 1);
  }
}

function showContext(on) {
  if (!on || !S.tokens.length) { els.context.hidden = true; return; }
  const st = S.starts;
  const k = Math.max(0, st.findLastIndex((s) => s <= S.i));
  const from = st[Math.max(0, k - 1)] ?? 0;
  const to = st[k + 2] ?? S.tokens.length;
  const frag = document.createDocumentFragment();
  for (let x = from; x < Math.min(to, from + 90); x++) {
    const t = S.tokens[x];
    const sep = S.tokens[x + 1]?.cont ? "" : " ";
    if (x === S.i) { const m = document.createElement("mark"); m.textContent = t.w; frag.append(m, sep); }
    else if (S.mask[x]) { const s = document.createElement("s"); s.textContent = t.w; frag.append(s, sep); }
    else frag.append(t.w + sep);
  }
  els.context.replaceChildren(frag);
  els.context.hidden = false;
}

async function persistPos(pos = S.i) {
  if (!S.doc) return;
  S.doc.pos = pos;
  await store.updatePos(S.doc.id, pos);
}

// ------------------------------------------------------------------ controls
els.play.addEventListener("click", toggle);
els.stage.addEventListener("click", (e) => { if (!e.target.closest(".context")) toggle(); });
els.prev.addEventListener("click", () => sentence(-1));
els.next.addEventListener("click", () => sentence(1));
els.scrub.addEventListener("input", () => seek(+els.scrub.value, { keepPlaying: false }));
els.scrub.addEventListener("change", () => persistPos());

function setWpm(v) {
  prefs.wpm = Math.max(100, Math.min(1200, Math.round(v / 10) * 10));
  savePrefs(); applyPrefs();
  if (S.tokens.length) updateProgress();
}
els.wpmDown.addEventListener("click", () => setWpm(prefs.wpm - 25));
els.wpmUp.addEventListener("click", () => setWpm(prefs.wpm + 25));
els.wpmRange.addEventListener("input", () => setWpm(+els.wpmRange.value));
els.presets.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setWpm(+b.dataset.v); });

function togglePopover(pop, btn) {
  const open = pop.hidden;
  closePopovers();
  if (open) { pop.hidden = false; btn.setAttribute("aria-expanded", "true"); }
}
function closePopovers() {
  for (const [p, b] of [[els.speed, els.wpmBtn], [els.settings, els.settingsBtn]]) { p.hidden = true; b.setAttribute("aria-expanded", "false"); }
}
els.wpmBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePopover(els.speed, els.wpmBtn); });
els.settingsBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePopover(els.settings, els.settingsBtn); });
document.addEventListener("click", (e) => {
  if (!e.target.closest(".popover") && !e.target.closest("#wpm-btn") && !e.target.closest("#settings-btn")) closePopovers();
});

els.sizeSeg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { prefs.size = b.dataset.v; savePrefs(); applyPrefs(); } });
els.chunkSeg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { prefs.chunk = +b.dataset.v; savePrefs(); applyPrefs(); render(); } });
els.punct.addEventListener("change", () => {
  prefs.punct = els.punct.checked; savePrefs();
  recomputeUnits(S.tokens, prefs.punct); S.prefix = prefixUnits(S.tokens, S.mask); updateProgress();
});
els.orp.addEventListener("change", () => { prefs.orp = els.orp.checked; savePrefs(); applyPrefs(); });

for (const id of ["#theme-toggle", "#theme-toggle-home"]) {
  $(id).addEventListener("click", () => { prefs.theme = prefs.theme === "dark" ? "light" : "dark"; savePrefs(); applyPrefs(); });
}

document.addEventListener("keydown", (e) => {
  if (els.reader.hidden) return;
  if (skips.isOpen()) { if (e.key === "Escape") { e.preventDefault(); skips.close(); } return; }
  if (pager.isOpen()) { if (e.key === "Escape" || e.key === "p" || e.key === "P") { e.preventDefault(); pager.close(); } return; }
  if (e.target.matches("input[type=range]") && /Arrow/.test(e.key)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case " ": case "k": e.preventDefault(); toggle(); break;
    case "ArrowLeft": case "j": e.preventDefault(); sentence(-1); break;
    case "ArrowRight": case "l": e.preventDefault(); sentence(1); break;
    case "ArrowUp": e.preventDefault(); setWpm(prefs.wpm + 25); break;
    case "ArrowDown": e.preventDefault(); setWpm(prefs.wpm - 25); break;
    case "s": case "S": e.preventDefault(); skips.open(); break;
    case "p": case "P": e.preventDefault(); pager.open(); break;
    case "Escape": if (!els.speed.hidden || !els.settings.hidden) closePopovers(); else els.backBtn.click(); break;
  }
});
document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
window.addEventListener("pagehide", () => persistPos());

// ------------------------------------------------------------------ utils
function setFill(r) {
  const min = +r.min || 0, max = +r.max || 100;
  r.style.setProperty("--p", `${max > min ? ((r.value - min) / (max - min)) * 100 : 0}%`);
}
function fmtTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
const stripExt = (n) => n.replace(/\.[a-z0-9]{1,5}$/i, "") || n;
const kindOf = (n) => (n.match(/\.([a-z0-9]{1,5})$/i)?.[1] || "").toUpperCase().replace("JPEG", "JPG").replace("MARKDOWN", "MD");
function ago(t) {
  if (!t) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
async function hashText(text) {
  const buf = await crypto.subtle?.digest("SHA-256", new TextEncoder().encode(text));
  if (!buf) { let h = 0; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0; return "h" + (h >>> 0).toString(16); }
  return "h" + [...new Uint8Array(buf).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const escapeAttr = (s) => s.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]);

const skips = initSkips(S, {
  changed() {
    syncSkips();
    S.i = readableAt(S.i);
    render();
    if (!S.playing) showContext(true);
  },
  pause,
  fmt: fmtTime,
  beatMs,
  save(fields) {
    Object.assign(S.doc, fields);
    store.updateDoc(S.doc.id, fields);
  },
});

const pager = initPages(S, {
  pause,
  percent: readFrac,
  jump(i, page) {
    seek(i, { keepPlaying: false });
    skips.toast(`Page ${page + 1}`);
  },
});

// ------------------------------------------------------------------ boot
applyPrefs();
renderRecents();
if (location.hash === "#read") history.replaceState(null, "", location.pathname);

// test hook (used by automated QA only)
window.__pace = { S, prefs, handleFile, openDoc, extract: extractText };
