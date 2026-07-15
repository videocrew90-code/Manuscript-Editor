/** Tokenize preserving whitespace as its own tokens so diffs read naturally. */
function tokenize(text) {
  return text.match(/\s+|[^\s]+/g) || [];
}

/** Basic LCS-based word diff. Fine for passage-length text (not full chapters). */
export function wordDiff(oldText, newText) {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: a[i] });
      i++;
    } else {
      ops.push({ type: "ins", text: b[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ type: "del", text: a[i] }); i++; }
  while (j < m) { ops.push({ type: "ins", text: b[j] }); j++; }

  // Merge adjacent same-type ops
  const merged = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else merged.push({ ...op });
  }
  return merged;
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
