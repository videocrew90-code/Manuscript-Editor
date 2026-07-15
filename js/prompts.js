export function buildEditPrompt({ selection, contextBefore, contextAfter, instruction, styleSummary, turnHistory }) {
  const historyBlock = turnHistory && turnHistory.length
    ? `\nPrior conversation about this exact passage (most recent last):\n${turnHistory
        .map((t) => `${t.role.toUpperCase()}: ${t.text}`)
        .join("\n")}\n`
    : "";

  return `You are a professional developmental & line editor working inside an editing tool. You are editing a passage the human editor has selected from a larger manuscript.

${styleSummary ? `EDITOR'S STYLE PROFILE (match this editor's voice/approach, learned from their past edits):\n${styleSummary}\n` : ""}
CONTEXT BEFORE THE SELECTION:
"""${contextBefore || "(start of chapter)"}"""

SELECTED PASSAGE TO EDIT:
"""${selection}"""

CONTEXT AFTER THE SELECTION:
"""${contextAfter || "(end of chapter)"}"""
${historyBlock}
EDITOR'S INSTRUCTION: ${instruction || "General polish: improve clarity, flow, and prose quality while preserving voice and meaning."}

Respond with ONLY minified JSON, no markdown fences, no commentary outside the JSON:
{"revision": "the rewritten version of ONLY the selected passage, ready to drop in as a direct replacement", "explanation": "1-2 sentence note on what you changed and why, written to a fellow editor"}

Rules: keep the revision's length and register plausible for the surrounding context. Do not rewrite the context, only the selection. If the instruction asks a question rather than requesting a change, set "revision" to the original unchanged selection and put your answer in "explanation".`;
}

export function buildStyleSummaryPrompt(examples) {
  const list = examples
    .map(
      (e, i) =>
        `Example ${i + 1}:\nBEFORE: "${e.before}"\nAFTER: "${e.after}"${e.note ? `\nEDITOR'S NOTE: ${e.note}` : ""}`
    )
    .join("\n\n");

  return `Below are paired before/after examples of one editor's real edits to client manuscripts. Study them and produce a concise style profile describing this editor's recurring habits and preferences: sentence length tendencies, what they cut, what they preserve, tone/register preferences, punctuation habits, dialogue tag style, pacing preferences, anything distinctive and consistent across examples. Write it as a tight reference brief (150-250 words, plain prose, no headers) that another editor could read to imitate this editor's approach. Do not summarize the examples' plot content, only the editing pattern.

${list}

Respond with ONLY the style brief text, nothing else.`;
}

export function buildAiDetectionPrompt(chapterText) {
  const excerpt = chapterText.length > 6000 ? chapterText.slice(0, 6000) : chapterText;
  return `You are assessing whether the following manuscript excerpt shows stylistic hallmarks commonly associated with unedited AI-generated prose (e.g. repetitive sentence rhythm, generic phrasing, overuse of certain transition words, lack of specific sensory detail, overly tidy structure). This is a heuristic best-effort read, not a certified detector, and you should reflect that uncertainty honestly.

EXCERPT:
"""${excerpt}"""

Respond with ONLY minified JSON:
{"likelihood": "low" | "medium" | "high", "reasoning": "2-4 sentences of specific, evidence-based observations about this excerpt, citing the kind of patterns you noticed", "caveat": "a short honest reminder that this is a heuristic impression, not a reliable detector"}`;
}

export function buildDistinctivePhrasesPrompt(chapterText) {
  const excerpt = chapterText.length > 6000 ? chapterText.slice(0, 6000) : chapterText;
  return `Read the excerpt below and extract 3-6 short phrases (5-12 words each) that are distinctive enough that, if they appeared verbatim in a published work elsewhere, it would be worth the editor manually checking for unattributed lifting. Prefer unusual turns of phrase, specific factual claims, or memorable constructions over generic sentences.

EXCERPT:
"""${excerpt}"""

Respond with ONLY minified JSON:
{"phrases": ["phrase one", "phrase two", ...]}`;
}
