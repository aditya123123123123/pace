# Pace — speed reader

**Try it: [readpace.vercel.app](https://readpace.vercel.app/)**

Drop in a PDF, a scanned PDF, a photo of a page, a DOCX, TXT or Markdown file (or paste text) and read it one word at a time (RSVP) at the speed you choose. Everything runs in your browser: files are never uploaded.

## Features

- **Scanned PDFs and photos work.** Text PDFs use the pdf.js text layer; image-only pages are read with Tesseract OCR, automatically, page by page. Sideways pages are detected and rotated, and unreadable noise pages are skipped.
- **Skip the clutter.** Mark page numbers, running headers or any passage to skip; Pace offers to skip repeated headers it detects.
- **Page navigator.** See which PDF page you're on, scrub with a page tooltip, or open a grid of real page previews and jump anywhere.
- **Comfortable timing.** Optimal-recognition-point highlight and punctuation-aware pauses, normalised so the WPM is the true average. 100–1200 WPM, 1–3 words per flash, 3 sizes, light/dark.
- **Remembers your place.** Recent documents and reading position are stored on-device in IndexedDB.

Keys: `Space` play/pause · `←`/`→` sentence · `↑`/`↓` ±25 WPM · `S` skip editor · `P` pages · `Esc` back

## Run it locally

```
npm install
npm run dev                        # http://127.0.0.1:5310
npm run build && npm run preview   # production build on :5311
```

The production build in `dist/` is a static site and can be hosted anywhere (`vercel.json` sets cache headers for Vercel). English OCR language data is fetched once from a CDN by tesseract.js on first use.

## How it's built

Vanilla JS + [Vite](https://vite.dev/), [pdf.js](https://mozilla.github.io/pdf.js/), [Tesseract.js](https://tesseract.projectnaptha.com/) and [mammoth](https://github.com/mwilliamson/mammoth.js) for DOCX.

| File | What it does |
|---|---|
| `src/extract.js` | Text extraction: PDF text layer, OCR worker pool, rotation, noise filtering, images, DOCX |
| `src/rsvp.js` | Tokenising and per-word timing |
| `src/skips.js`, `src/skip-ui.js` | Skip ranges and the skip editor |
| `src/pages.js`, `src/pages-ui.js` | Word → page mapping and the page navigator |
| `src/store.js` | IndexedDB persistence |
| `src/main.js` | App state, reader, controls |

## License

[MIT](LICENSE) © Aditya Jhalani
