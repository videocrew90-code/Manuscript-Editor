/** Tokenize preserving whitespace as its own tokens so diffs read naturally. */
function tokenize(text) {
  return text.match(/\s+|[^\s]+/g) || [];
}

/**
 * Generic LCS diff over two arrays of comparable items (words, paragraphs, etc).
 * O(n*m) time/space — fine for short-to-medium arrays (a passage's words, or a
 * chapter's paragraphs). NOT fine for two full chapters' worth of words at once
 * — see paragraphDiff() below, which keeps this bounded by never handing it
 * more than one paragraph's worth of words at a time.
 */
export function lcsDiff(a, b, isEqual = (x, y) => x === y) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = isEqual(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (isEqual(a[i], b[j])) {
      ops.push({ type: "equal", a: a[i], b: b[j] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", a: a[i] });
      i++;
    } else {
      ops.push({ type: "ins", b: b[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ type: "del", a: a[i] }); i++; }
  while (j < m) { ops.push({ type: "ins", b: b[j] }); j++; }
  return ops;
}

/** Basic LCS-based word diff. Fine for passage-length text (not full chapters). */
export function wordDiff(oldText, newText) {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const rawOps = lcsDiff(a, b);

  const ops = rawOps.map((op) => {
    if (op.type === "equal") return { type: "equal", text: op.a };
    if (op.type === "del") return { type: "del", text: op.a };
    return { type: "ins", text: op.b };
  });

  // Merge adjacent same-type ops
  const merged = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else merged.push({ ...op });
  }
  return merged;
}

// Paragraph boundary = one-or-more blank lines. A single "\n" (e.g. from a
// <br>) stays inside a paragraph and is treated as ordinary whitespace by
// wordDiff's tokenizer.
function splitParagraphs(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// Safety cap: never hand wordDiff (which is O(n*m)) two paragraphs whose
// combined word count could blow up the matrix. If a "paragraph" is this
// long (e.g. someone pasted a huge block with no blank lines), fall back to
// showing it as a whole replaced block instead of word-diffing it.
const MAX_PARAGRAPH_WORDS_FOR_WORD_DIFF = 600;

/**
 * Cheap diff for full-document-length text (chapters). Diffs at the
 * paragraph level first (paragraph counts are small even for long chapters,
 * so this LCS pass is cheap), then only runs the expensive word-level
 * wordDiff() on paragraphs that were actually replaced 1:1 — bounding the
 * expensive part to individual paragraphs instead of the whole chapter.
 */
export function paragraphDiff(oldText, newText) {
  const oldParas = splitParagraphs(oldText);
  const newParas = splitParagraphs(newText);
  const rawOps = lcsDiff(oldParas, newParas);

  const ops = [];
  let i = 0;
  while (i < rawOps.length) {
    const op = rawOps[i];

    if (op.type === "equal") {
      ops.push({ type: "equal", text: op.a }, { type: "equal", text: "\n\n" });
      i++;
      continue;
    }

    // Collect a run of consecutive non-equal ops (a block of removed and/or
    // added paragraphs sitting next to each other).
    let j = i;
    const dels = [];
    const inss = [];
    while (j < rawOps.length && rawOps[j].type !== "equal") {
      if (rawOps[j].type === "del") dels.push(rawOps[j].a);
      else inss.push(rawOps[j].b);
      j++;
    }

    if (dels.length && dels.length === inss.length) {
      // Equal-length run: treat as N paragraphs each edited in place, and
      // word-diff each pair individually (bounded cost per pair).
      for (let k = 0; k < dels.length; k++) {
        const delWords = dels[k].split(/\s+/).length;
        const insWords = inss[k].split(/\s+/).length;
        if (delWords <= MAX_PARAGRAPH_WORDS_FOR_WORD_DIFF && insWords <= MAX_PARAGRAPH_WORDS_FOR_WORD_DIFF) {
          ops.push(...wordDiff(dels[k], inss[k]));
        } else {
          ops.push({ type: "del", text: dels[k] }, { type: "ins", text: inss[k] });
        }
        ops.push({ type: "equal", text: "\n\n" });
      }
    } else {
      // Uneven run (paragraphs added/removed, not a clean 1:1 edit) — show
      // as whole-paragraph blocks, no word-level refinement needed.
      dels.forEach((d) => ops.push({ type: "del", text: d }, { type: "equal", text: "\n\n" }));
      inss.forEach((n) => ops.push({ type: "ins", text: n }, { type: "equal", text: "\n\n" }));
    }

    i = j;
  }

  return ops;
}

export function diffToHTML(ops) {
  return ops
    .map((op) => {
      const escaped = op.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      if (op.type === "del") return `<span class="diff-del">${escaped}</span>`;
      if (op.type === "ins") return `<span class="diff-ins">${escaped}</span>`;
      return escaped;
    })
    .join("");
}

export function wordCount(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
