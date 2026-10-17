// Which PDF page each word came from, and where each page's words start and end.
// The text keeps page boundaries as form feeds; tokenize() records each word's segment
// (form feeds before it). A scanned book spread is two segments on one PDF page, which
// doc.segPages resolves. Docs saved before segPages existed map segments 1:1 when the
// counts match and proportionally otherwise.

/**
 * @param {{seg?: number}[]} tokens
 * @param {{pages?: number, text?: string, segPages?: number[]}} doc
 * @returns {{n: number, of: Int32Array, start: Int32Array, end: Int32Array}}
 *   of[i] = page of token i; start/end[p] = token range of page p ([-1, -1] when it has no words)
 */
export function pageIndex(tokens, doc) {
  const n = Math.max(1, doc.pages || 1);
  const segs = (doc.text?.match(/\f/g)?.length || 0) + 1;
  const sp = Array.isArray(doc.segPages) && doc.segPages.length === segs ? doc.segPages : null;
  const toPage = (s) => (sp ? sp[s] : segs === n ? s : Math.floor((s * n) / segs));
  const of = new Int32Array(tokens.length);
  const start = new Int32Array(n).fill(-1);
  const end = new Int32Array(n).fill(-1);
  for (let i = 0; i < tokens.length; i++) {
    const p = Math.max(0, Math.min(n - 1, toPage(tokens[i].seg || 0)));
    of[i] = p;
    if (start[p] < 0) start[p] = i;
    end[p] = i + 1;
  }
  return { n, of, start, end };
}

/** First word at or after page p (a blank page jumps to the next page with words). */
export function pageTarget(idx, p) {
  for (let q = p; q < idx.n; q++) if (idx.start[q] >= 0) return idx.start[q];
  for (let q = p - 1; q >= 0; q--) if (idx.start[q] >= 0) return idx.start[q];
  return 0;
}
