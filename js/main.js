import { db, uid } from "./db.js";
import { hasKey, saveKey, callGeminiJSON, callGeminiText, GeminiError } from "./gemini.js";
import { buildEditPrompt, buildStyleSummaryPrompt, buildAiDetectionPrompt, buildDistinctivePhrasesPrompt } from "./prompts.js";
import { wordDiff, diffToHTML, wordCount, paragraphDiff, lcsDiff } from "./diff.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  projectList: $("#project-list"),
  chapterNavSection: $("#chapter-nav-section"),
  chapterList: $("#chapter-list"),
  projectWordTotal: $("#project-word-total"),
  chapterTitleInput: $("#chapter-title-input"),
  manuscript: $("#manuscript"),
  selectionToolbar: $("#selection-toolbar"),
  askEditorBtn: $("#ask-editor-btn"),
  chatEmpty: $("#chat-empty"),
  chatThread: $("#chat-thread"),
  chatForm: $("#chat-form"),
  chatInput: $("#chat-input"),
  toast: $("#toast"),
  checksResults: $("#checks-results"),
  checkpointBtn: $("#checkpoint-btn"),
};

const state = {
  projectId: null,
  chapterId: null,
  chapterSplitWords: Number(localStorage.getItem("redline_split_words")) || 3000,
  chatSession: null, // { markerId, originalText, turnHistory, pendingRevision, contextBefore, contextAfter }
  savedRange: null,
};

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (els.toast.hidden = true), 3200);
}

// ---------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------

async function loadProjects() {
  const projects = await db.getAllProjects();
  els.projectList.innerHTML = "";
  projects
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((p) => {
      const li = document.createElement("li");
      li.textContent = p.name;
      li.dataset.id = p.id;
      if (p.id === state.projectId) li.classList.add("active");
      li.addEventListener("click", () => openProject(p.id));
      els.projectList.appendChild(li);
    });
  return projects;
}

async function createProject() {
  const name = prompt("Project / client name:");
  if (!name) return;
  const project = { id: uid(), name: name.trim(), createdAt: Date.now(), styleExamples: [], styleSummary: "" };
  await db.putProject(project);
  await loadProjects();
  openProject(project.id);
}

async function openProject(projectId) {
  await maybeCheckpointManualEdit("Autosaved checkpoint");
  await saveCurrentChapterIfDirty();
  state.projectId = projectId;
  state.chapterId = null;
  await loadProjects();
  els.chapterNavSection.hidden = false;
  const chapters = await loadChapters();
  if (chapters.length) openChapter(chapters[0].id);
  else els.manuscript.innerHTML = "";
}

// ---------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------

async function loadChapters() {
  if (!state.projectId) return [];
  const chapters = await db.getChaptersForProject(state.projectId);
  els.chapterList.innerHTML = "";
  let total = 0;
  chapters.forEach((c) => {
    total += c.wordCount || 0;
    const li = document.createElement("li");
    li.dataset.id = c.id;
    if (c.id === state.chapterId) li.classList.add("active");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = c.title || "Untitled chapter";
    const wcSpan = document.createElement("span");
    wcSpan.className = "chapter-wc";
    wcSpan.textContent = (c.wordCount || 0).toLocaleString();
    li.append(nameSpan, wcSpan);
    li.addEventListener("click", () => openChapter(c.id));
    els.chapterList.appendChild(li);
  });
  els.projectWordTotal.textContent = `${total.toLocaleString()} words total`;
  return chapters;
}

async function createChapter(initialContent = "", title = "") {
  if (!state.projectId) return;
  await saveCurrentChapterIfDirty();
  const chapters = await db.getChaptersForProject(state.projectId);
  const chapter = {
    id: uid(),
    projectId: state.projectId,
    title: title || `Chapter ${chapters.length + 1}`,
    order: chapters.length,
    content: initialContent,
    wordCount: wordCount(initialContent),
  };
  await db.putChapter(chapter);
  await loadChapters();
  openChapter(chapter.id);
  return chapter;
}

async function openChapter(chapterId) {
  await maybeCheckpointManualEdit("Autosaved checkpoint");
  await saveCurrentChapterIfDirty();
  state.chapterId = chapterId;
  const chapter = await db.getChapter(chapterId);
  if (!chapter) return;
  els.chapterTitleInput.value = chapter.title;
  els.manuscript.innerHTML = chapter.content || "";
  closeChatSession();
  loadChapters();

  // Reset the manual-edit checkpoint baseline to this chapter's current content.
  lastCheckpointHtml = chapter.content || "";
  lastCheckpointText = htmlToText(lastCheckpointHtml);
  manualDirty = false;
}

let dirty = false;
let manualDirty = false;
els.manuscript.addEventListener("input", () => {
  dirty = true;
  manualDirty = true;
});
els.chapterTitleInput.addEventListener("input", () => (dirty = true));

async function saveCurrentChapterIfDirty() {
  if (!state.chapterId || !dirty) return;
  const chapter = await db.getChapter(state.chapterId);
  if (!chapter) return;
  chapter.content = els.manuscript.innerHTML;
  chapter.title = els.chapterTitleInput.value.trim() || chapter.title;
  chapter.wordCount = wordCount(els.manuscript.innerText);
  await db.putChapter(chapter);
  dirty = false;
  loadChapters();
}
setInterval(saveCurrentChapterIfDirty, 4000);
window.addEventListener("beforeunload", () => saveCurrentChapterIfDirty());

// ---------------------------------------------------------------------
// Manual-edit tracking (track changes for typing, separate from AI edits)
// ---------------------------------------------------------------------

// Converts chapter HTML into plain text with "\n\n" between block-level
// paragraphs and "\n" for <br>, matching the convention already used when
// importing text (see splitIntoChapters below). Doesn't touch the DOM/layout
// — just walks the parsed node tree — so it's cheap and safe to call often.
function htmlToText(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  const blockTags = new Set(["P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"]);
  let out = "";
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === "BR") {
      out += "\n";
      return;
    }
    node.childNodes.forEach(walk);
    if (blockTags.has(node.tagName)) out += "\n\n";
  }
  div.childNodes.forEach(walk);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

let lastCheckpointHtml = "";
let lastCheckpointText = "";

// Splits chapter HTML into its top-level paragraph-ish units (one entry per
// direct child of the manuscript root — normally <p> tags, but this handles
// stray text nodes too, e.g. text typed before the first Enter press).
// Each entry is the *exact* HTML substring as it appears in the stored
// chapter.content string, so it can be found again later with a plain
// string search — same trick the existing AI-edit revert already relies on.
function splitHtmlParagraphs(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  const parts = [];
  div.childNodes.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      parts.push(node.outerHTML);
    } else if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      // Bare text nodes aren't HTML-escaped by the DOM the way outerHTML is,
      // so escape to match how this text actually appears in the raw
      // chapter.content string.
      parts.push(escapeHTML(node.textContent));
    }
  });
  return parts;
}

// Turns a raw paragraph-level LCS diff into a flat list of per-paragraph
// edits revert can act on directly:
//  - { before, after }              -> paragraph edited in place: search
//                                       for `after`, swap in `before`.
//  - { before: null, after }        -> paragraph was inserted: search for
//                                       `after`, remove it.
//  - { before, after: null, ... }   -> paragraph was deleted: no longer
//                                       present to search for, so it needs
//                                       an anchor (a neighboring paragraph
//                                       we know is unchanged) to know where
//                                       to put it back.
function buildParagraphEdits(rawOps) {
  const edits = [];
  let i = 0;
  let lastEqual = null;
  while (i < rawOps.length) {
    const op = rawOps[i];
    if (op.type === "equal") {
      lastEqual = op.a;
      i++;
      continue;
    }
    let j = i;
    const dels = [];
    const inss = [];
    while (j < rawOps.length && rawOps[j].type !== "equal") {
      if (rawOps[j].type === "del") dels.push(rawOps[j].a);
      else inss.push(rawOps[j].b);
      j++;
    }
    const nextEqual = j < rawOps.length ? rawOps[j].a : null;
    const pairCount = Math.min(dels.length, inss.length);
    for (let k = 0; k < pairCount; k++) edits.push({ before: dels[k], after: inss[k] });
    for (let k = pairCount; k < inss.length; k++) edits.push({ before: null, after: inss[k] });
    for (let k = pairCount; k < dels.length; k++) {
      edits.push({ before: dels[k], after: null, anchorAfter: lastEqual, anchorBefore: nextEqual });
    }
    i = j;
  }
  return edits;
}

// Applies a paragraph edit list to live chapter HTML by search-and-replace —
// the exact same mechanism AI-edit revert already uses (search for the
// known "after" text, swap in "before"), just looped per paragraph instead
// of once for a single passage. Edited-in-place and inserted paragraphs are
// found and reverted directly. Deleted paragraphs (nothing left to search
// for) are re-inserted next to whichever neighboring paragraph we can still
// find unchanged nearby. Only a paragraph that's been edited *again* since
// this checkpoint (so neither it nor either neighbor can be found anymore)
// is left untouched — same "can't locate it" fallback the AI-edit path
// already has, just scoped to that one paragraph instead of aborting the
// whole revert.
function applyParagraphRevert(html, edits) {
  let result = html;
  let resolvedCount = 0;
  const unresolved = [];
  const deletions = [];

  for (const edit of edits) {
    if (edit.after != null) {
      const idx = result.indexOf(edit.after);
      if (idx === -1) {
        unresolved.push(edit);
        continue;
      }
      const replacement = edit.before != null ? edit.before : "";
      result = result.slice(0, idx) + replacement + result.slice(idx + edit.after.length);
      resolvedCount++;
    } else {
      deletions.push(edit); // handled below, after the document has settled
    }
  }

  for (const edit of deletions) {
    let idx = edit.anchorAfter != null ? result.indexOf(edit.anchorAfter) : -1;
    if (idx > -1) {
      const insertAt = idx + edit.anchorAfter.length;
      result = result.slice(0, insertAt) + edit.before + result.slice(insertAt);
      resolvedCount++;
      continue;
    }
    idx = edit.anchorBefore != null ? result.indexOf(edit.anchorBefore) : -1;
    if (idx > -1) {
      result = result.slice(0, idx) + edit.before + result.slice(idx);
      resolvedCount++;
      continue;
    }
    unresolved.push(edit);
  }

  return { html: result, resolvedCount, unresolved };
}

// Records a "manual edit" history entry if the manuscript has changed since
// the last checkpoint. Called on a timer (see below), from the toolbar
// "Checkpoint" button, and as a safety flush when switching chapters/projects
// so a change made just before switching isn't silently dropped from the log.
async function maybeCheckpointManualEdit(note) {
  if (!state.chapterId || !manualDirty) return false;
  await saveCurrentChapterIfDirty();
  const chapter = await db.getChapter(state.chapterId);
  if (!chapter) return false;

  const afterHtml = chapter.content || "";
  const afterText = htmlToText(afterHtml);
  const beforeText = lastCheckpointText;
  manualDirty = false;

  if (afterText === beforeText) return false; // nothing actually changed (e.g. only whitespace/formatting)

  const beforeParas = splitHtmlParagraphs(lastCheckpointHtml);
  const afterParas = splitHtmlParagraphs(afterHtml);
  const paragraphEdits = buildParagraphEdits(lcsDiff(beforeParas, afterParas));

  await db.addHistory({
    chapterId: state.chapterId,
    type: "manual",
    before: beforeText,
    after: afterText,
    beforeHtml: lastCheckpointHtml,
    afterHtml,
    paragraphEdits,
    timestamp: Date.now(),
    note,
  });

  lastCheckpointHtml = afterHtml;
  lastCheckpointText = afterText;
  return true;
}

setInterval(() => maybeCheckpointManualEdit("Autosaved checkpoint"), 45000);

els.checkpointBtn?.addEventListener("click", async () => {
  const saved = await maybeCheckpointManualEdit("Manual checkpoint");
  toast(saved ? "Checkpoint saved." : "No changes to checkpoint.");
});

// ---------------------------------------------------------------------
// Import / auto-split large manuscripts
// ---------------------------------------------------------------------

function splitIntoChapters(text, targetWords) {
  // Groups paragraphs into chapter-sized chunks by word count.
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const chunks = [];
  let current = [];
  let currentWords = 0;
  for (const para of paragraphs) {
    const w = wordCount(para);
    if (currentWords > 0 && currentWords + w > targetWords) {
      chunks.push(current.join("\n\n"));
      current = [];
      currentWords = 0;
    }
    current.push(para);
    currentWords += w;
  }
  if (current.length) chunks.push(current.join("\n\n"));
  return chunks;
}

async function runImport() {
  const text = $("#import-textarea").value;
  if (!text.trim()) return;
  const chunks = splitIntoChapters(text, state.chapterSplitWords);
  for (let i = 0; i < chunks.length; i++) {
    const html = chunks[i]
      .split(/\n{2,}/)
      .map((p) => `<p>${escapeHTML(p).replace(/\n/g, "<br>")}</p>`)
      .join("");
    await createChapter(html, `Chapter ${i + 1}`);
  }
  $("#import-textarea").value = "";
  closeModal("import-modal");
  toast(`Imported ${chunks.length} chapter${chunks.length === 1 ? "" : "s"}.`);
}

function escapeHTML(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------
// Selection -> chat editing
// ---------------------------------------------------------------------

els.manuscript.addEventListener("mouseup", handleSelectionChange);
els.manuscript.addEventListener("keyup", handleSelectionChange);

function handleSelectionChange() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    els.selectionToolbar.hidden = true;
    return;
  }
  const range = sel.getRangeAt(0);
  if (!els.manuscript.contains(range.commonAncestorContainer)) {
    els.selectionToolbar.hidden = true;
    return;
  }
  const text = sel.toString().trim();
  if (!text) {
    els.selectionToolbar.hidden = true;
    return;
  }
  state.savedRange = range.cloneRange();
  const rect = range.getBoundingClientRect();
  els.selectionToolbar.style.left = `${rect.left + rect.width / 2}px`;
  els.selectionToolbar.style.top = `${rect.top + window.scrollY}px`;
  els.selectionToolbar.hidden = false;
}

els.askEditorBtn.addEventListener("click", () => {
  if (!hasKey()) {
    toast("Add your free Gemini API key in Settings first.");
    openModal("settings-modal");
    return;
  }
  if (!state.savedRange) return;
  startChatSession(state.savedRange);
  els.selectionToolbar.hidden = true;
});

function startChatSession(range) {
  const markerId = uid();
  const span = document.createElement("span");
  span.className = "edit-marker";
  span.dataset.markerId = markerId;
  try {
    range.surroundContents(span);
  } catch {
    // Selection spans multiple block elements; fall back to extract+wrap.
    const frag = range.extractContents();
    span.appendChild(frag);
    range.insertNode(span);
  }
  dirty = true;

  const fullText = els.manuscript.innerText;
  const markerText = span.innerText;
  const idx = fullText.indexOf(markerText);
  const contextBefore = idx > -1 ? fullText.slice(Math.max(0, idx - 400), idx) : "";
  const contextAfter = idx > -1 ? fullText.slice(idx + markerText.length, idx + markerText.length + 400) : "";

  state.chatSession = {
    markerId,
    originalText: markerText,
    turnHistory: [],
    pendingRevision: null,
    contextBefore,
    contextAfter,
  };

  els.chatEmpty.hidden = true;
  els.chatThread.hidden = false;
  els.chatForm.hidden = false;
  els.chatThread.innerHTML = "";
  appendChatMsg("quote", markerText);
  els.chatInput.value = "";
  els.chatInput.focus();
  switchSideTab("chat");
}

function closeChatSession() {
  state.chatSession = null;
  els.chatEmpty.hidden = false;
  els.chatThread.hidden = true;
  els.chatForm.hidden = true;
  els.chatThread.innerHTML = "";
}

function appendChatMsg(kind, content, roleLabel) {
  const div = document.createElement("div");
  div.className = `chat-msg ${kind}`;
  if (roleLabel) {
    const role = document.createElement("span");
    role.className = "role";
    role.textContent = roleLabel;
    div.appendChild(role);
  }
  if (typeof content === "string") {
    const p = document.createElement("div");
    p.textContent = content;
    div.appendChild(p);
  } else {
    div.appendChild(content);
  }
  els.chatThread.appendChild(div);
  els.chatThread.scrollTop = els.chatThread.scrollHeight;
  return div;
}

els.chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const instruction = els.chatInput.value.trim();
  if (!state.chatSession) return;

  if (instruction) appendChatMsg("user editor-instruction", instruction, "You");
  els.chatInput.value = "";
  const pendingEl = appendChatMsg("pending-note", "Editor is thinking…");

  try {
    const project = await db.getProject(state.projectId);
    const session = state.chatSession;
    const marker = document.querySelector(`[data-marker-id="${session.markerId}"]`);
    const currentText = marker ? marker.innerText : session.originalText;

    const prompt = buildEditPrompt({
      selection: currentText,
      contextBefore: session.contextBefore,
      contextAfter: session.contextAfter,
      instruction,
      styleSummary: project?.styleSummary || "",
      turnHistory: session.turnHistory,
    });
    const result = await callGeminiJSON(prompt);
    pendingEl.remove();

    session.turnHistory.push({ role: "editor", text: instruction || "(general polish)" });
    session.turnHistory.push({ role: "assistant", text: result.explanation || "" });
    session.pendingRevision = result.revision;

    const body = document.createElement("div");
    const explain = document.createElement("div");
    explain.textContent = result.explanation || "";
    body.appendChild(explain);

    const diffBlock = document.createElement("div");
    diffBlock.className = "diff-block";
    diffBlock.innerHTML = diffToHTML(wordDiff(currentText, result.revision));
    body.appendChild(diffBlock);

    const actions = document.createElement("div");
    actions.className = "chat-actions";
    const acceptBtn = document.createElement("button");
    acceptBtn.className = "accept-btn";
    acceptBtn.textContent = "Accept";
    acceptBtn.addEventListener("click", () => acceptRevision(session));
    const rejectBtn = document.createElement("button");
    rejectBtn.className = "reject-btn";
    rejectBtn.textContent = "Reject";
    rejectBtn.addEventListener("click", () => rejectRevision(session));
    actions.append(acceptBtn, rejectBtn);
    body.appendChild(actions);

    appendChatMsg("editor", body, "Editor");
  } catch (err) {
    pendingEl.remove();
    appendChatMsg("editor", err instanceof GeminiError ? err.message : `Something went wrong: ${err.message}`, "Editor");
  }
});

async function acceptRevision(session) {
  const marker = document.querySelector(`[data-marker-id="${session.markerId}"]`);
  if (!marker || !session.pendingRevision) return;
  const before = session.originalText;
  const after = session.pendingRevision;
  marker.textContent = after;
  marker.classList.remove("edit-marker");
  marker.removeAttribute("class");
  dirty = true;
  await saveCurrentChapterIfDirty();

  await db.addHistory({
    chapterId: state.chapterId,
    before,
    after,
    timestamp: Date.now(),
    note: session.turnHistory.filter((t) => t.role === "editor").map((t) => t.text).join("; "),
  });

  toast("Edit applied.");
  closeChatSession();
}

function rejectRevision(session) {
  const marker = document.querySelector(`[data-marker-id="${session.markerId}"]`);
  if (marker) {
    marker.replaceWith(document.createTextNode(marker.innerText));
    dirty = true;
  }
  closeChatSession();
}

// ---------------------------------------------------------------------
// Undo / history
// ---------------------------------------------------------------------

async function undoLastEdit() {
  if (!state.chapterId) return;
  const history = await db.getHistoryForChapter(state.chapterId);
  if (!history.length) {
    toast("No edits to undo in this chapter.");
    return;
  }
  await revertHistoryEntry(history[0]);
}

async function revertHistoryEntry(entry) {
  const chapter = await db.getChapter(state.chapterId);
  if (!chapter) return;

  if (entry.type === "manual") {
    const result = applyParagraphRevert(chapter.content, entry.paragraphEdits || []);
    chapter.content = result.html;
    chapter.wordCount = wordCount(chapter.content.replace(/<[^>]+>/g, " "));
    await db.putChapter(chapter);
    await db.deleteHistoryEntry(entry.id);
    if (state.chapterId === chapter.id) {
      els.manuscript.innerHTML = chapter.content;
      dirty = false;
      manualDirty = false;
      lastCheckpointHtml = chapter.content;
      lastCheckpointText = htmlToText(chapter.content);
    }
    if (result.unresolved.length) {
      toast(
        `Reverted ${result.resolvedCount} paragraph(s). ${result.unresolved.length} couldn't be located (likely edited again since) — those weren't touched.`
      );
    } else {
      toast("Reverted.");
    }
    loadChapters();
    return;
  }

  const html = chapter.content;
  const idx = html.indexOf(escapeHTML(entry.after));
  let newHtml;
  if (idx > -1) {
    newHtml = html.slice(0, idx) + escapeHTML(entry.before) + html.slice(idx + escapeHTML(entry.after).length);
  } else if (html.includes(entry.after)) {
    newHtml = html.replace(entry.after, entry.before);
  } else {
    toast("Couldn't locate that text to revert — it may have been edited again since.");
    return;
  }
  chapter.content = newHtml;
  chapter.wordCount = wordCount(newHtml.replace(/<[^>]+>/g, " "));
  await db.putChapter(chapter);
  await db.deleteHistoryEntry(entry.id);
  if (state.chapterId === chapter.id) {
    els.manuscript.innerHTML = newHtml;
    dirty = false;
  }
  toast("Reverted.");
  loadChapters();
}

let historyCache = [];
let historyTab = "ai";

async function openHistoryModal() {
  if (!state.chapterId) return;
  const chapter = await db.getChapter(state.chapterId);
  $("#history-chapter-name").textContent = chapter?.title || "";
  historyCache = await db.getHistoryForChapter(state.chapterId);
  historyTab = "ai";
  $$(".history-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.type === historyTab));
  renderHistoryList();
  openModal("history-modal");
}

function renderHistoryList() {
  const list = $("#history-list");
  list.innerHTML = "";
  // Older entries predate manual-edit tracking and have no `type` field —
  // treat those as "ai" so they keep showing up where they always did.
  const entries = historyCache.filter((entry) => (entry.type || "ai") === historyTab);

  if (!entries.length) {
    const label = historyTab === "ai" ? "AI" : "manual";
    list.innerHTML = `<p class="field-hint">No ${label} edits recorded yet for this chapter.</p>`;
    return;
  }

  entries.forEach((entry) => {
    const div = document.createElement("div");
    div.className = "history-item";
    const time = new Date(entry.timestamp).toLocaleString();
    const ops = entry.type === "manual" ? paragraphDiff(entry.before, entry.after) : wordDiff(entry.before, entry.after);
    div.innerHTML = `<button class="h-revert">Revert</button><span class="h-time">${time}</span><div class="diff-block">${diffToHTML(
      ops
    )}</div>${entry.note ? `<div class="field-hint">${escapeHTML(entry.note)}</div>` : ""}`;
    div.querySelector(".h-revert").addEventListener("click", () => {
      revertHistoryEntry(entry);
      closeModal("history-modal");
    });
    list.appendChild(div);
  });
}

$$(".history-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    historyTab = btn.dataset.type;
    $$(".history-tab").forEach((b) => b.classList.toggle("active", b === btn));
    renderHistoryList();
  });
});

// ---------------------------------------------------------------------
// Style profile
// ---------------------------------------------------------------------

async function renderStyleModal() {
  const project = await db.getProject(state.projectId);
  if (!project) return;
  const list = $("#style-examples-list");
  list.innerHTML = "";
  (project.styleExamples || []).forEach((ex, i) => {
    const div = document.createElement("div");
    div.className = "style-example";
    div.innerHTML = `<button class="ex-remove">×</button><span class="ex-before">${escapeHTML(ex.before)}</span><span class="ex-after">${escapeHTML(
      ex.after
    )}</span>${ex.note ? `<div class="ex-note">${escapeHTML(ex.note)}</div>` : ""}`;
    div.querySelector(".ex-remove").addEventListener("click", async () => {
      project.styleExamples.splice(i, 1);
      await db.putProject(project);
      renderStyleModal();
    });
    list.appendChild(div);
  });
  $("#style-summary-box").textContent = project.styleSummary || "No style summary generated yet. Add a few examples, then click Regenerate.";
}

$("#style-add-btn").addEventListener("click", async () => {
  const before = $("#style-before").value.trim();
  const after = $("#style-after").value.trim();
  const note = $("#style-note").value.trim();
  if (!before || !after) {
    toast("Add both a before and after example.");
    return;
  }
  const project = await db.getProject(state.projectId);
  project.styleExamples = project.styleExamples || [];
  project.styleExamples.push({ before, after, note });
  await db.putProject(project);
  $("#style-before").value = "";
  $("#style-after").value = "";
  $("#style-note").value = "";
  renderStyleModal();
});

$("#style-summarize-btn").addEventListener("click", async () => {
  const project = await db.getProject(state.projectId);
  if (!project?.styleExamples?.length) {
    toast("Add at least one example first.");
    return;
  }
  if (!hasKey()) {
    toast("Add your Gemini API key in Settings first.");
    return;
  }
  $("#style-summary-box").textContent = "Generating summary…";
  try {
    const summary = await callGeminiText(buildStyleSummaryPrompt(project.styleExamples));
    project.styleSummary = summary.trim();
    await db.putProject(project);
    $("#style-summary-box").textContent = project.styleSummary;
    toast("Style summary updated.");
  } catch (err) {
    $("#style-summary-box").textContent = "Failed to generate summary.";
    toast(err.message);
  }
});

// ---------------------------------------------------------------------
// Checks (AI-likelihood heuristic + distinctive phrase flags)
// ---------------------------------------------------------------------

async function runChecks() {
  if (!state.chapterId) return;
  if (!hasKey()) {
    toast("Add your Gemini API key in Settings first.");
    openModal("settings-modal");
    return;
  }
  await saveCurrentChapterIfDirty();
  const chapter = await db.getChapter(state.chapterId);
  const plainText = els.manuscript.innerText;
  if (!plainText.trim()) {
    toast("Nothing to check yet.");
    return;
  }
  switchSideTab("checks");
  els.checksResults.innerHTML = `<p class="field-hint">Running checks…</p>`;

  try {
    const [aiResult, phraseResult] = await Promise.all([
      callGeminiJSON(buildAiDetectionPrompt(plainText)),
      callGeminiJSON(buildDistinctivePhrasesPrompt(plainText)),
    ]);

    els.checksResults.innerHTML = "";

    const aiCard = document.createElement("div");
    aiCard.className = "check-card";
    const levelClass = aiResult.likelihood === "low" ? "check-ok" : "check-flag";
    aiCard.innerHTML = `<h4>AI-pattern heuristic</h4><p><span class="${levelClass}">${(
      aiResult.likelihood || "unknown"
    ).toUpperCase()}</span> — ${escapeHTML(aiResult.reasoning || "")}</p><p class="field-hint">${escapeHTML(
      aiResult.caveat || ""
    )}</p>`;
    els.checksResults.appendChild(aiCard);

    const phraseCard = document.createElement("div");
    phraseCard.className = "check-card";
    const phrases = phraseResult.phrases || [];
    phraseCard.innerHTML = `<h4>Distinctive phrases worth a manual originality search</h4>${
      phrases.length
        ? `<ul style="margin:4px 0 0; padding-left:18px;">${phrases
            .map((p) => `<li>"${escapeHTML(p)}"</li>`)
            .join("")}</ul>`
        : `<p>No standout phrases flagged.</p>`
    }<p class="field-hint">Not a plagiarism-database check — paste these into a search engine or Copyscape/Turnitin if you have access, for a real match check.</p>`;
    els.checksResults.appendChild(phraseCard);
  } catch (err) {
    els.checksResults.innerHTML = `<p class="field-hint">Check failed: ${escapeHTML(err.message)}</p>`;
  }
}

// ---------------------------------------------------------------------
// UI plumbing: modals, tabs, settings
// ---------------------------------------------------------------------

function openModal(id) {
  $(`#${id}`).hidden = false;
}
function closeModal(id) {
  $(`#${id}`).hidden = true;
}
$$(".modal-close").forEach((btn) => btn.addEventListener("click", () => closeModal(btn.dataset.close)));
$$(".modal").forEach((modal) =>
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  })
);

function switchSideTab(tab) {
  $$(".side-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".side-tab-content").forEach((c) => c.classList.toggle("active", c.id === `tab-${tab}`));
}
$$(".side-tab").forEach((btn) => btn.addEventListener("click", () => switchSideTab(btn.dataset.tab)));

$("#new-project-btn").addEventListener("click", createProject);
$("#new-chapter-btn").addEventListener("click", () => createChapter());
$("#import-btn").addEventListener("click", () => openModal("import-modal"));
$("#import-run-btn").addEventListener("click", runImport);
$("#undo-btn").addEventListener("click", undoLastEdit);
$("#history-btn").addEventListener("click", openHistoryModal);
$("#check-btn").addEventListener("click", runChecks);
$("#style-profile-btn").addEventListener("click", () => {
  if (!state.projectId) {
    toast("Open or create a project first.");
    return;
  }
  renderStyleModal();
  openModal("style-modal");
});
$("#settings-btn").addEventListener("click", () => {
  $("#api-key-input").value = localStorage.getItem("redline_gemini_key") || "";
  $("#chapter-split-input").value = state.chapterSplitWords;
  openModal("settings-modal");
});
$("#save-key-btn").addEventListener("click", () => {
  saveKey($("#api-key-input").value);
  state.chapterSplitWords = Number($("#chapter-split-input").value) || 3000;
  localStorage.setItem("redline_split_words", state.chapterSplitWords);
  toast("Settings saved.");
  closeModal("settings-modal");
});

document.addEventListener("click", (e) => {
  if (!els.selectionToolbar.contains(e.target) && e.target !== els.askEditorBtn) {
    const sel = window.getSelection();
    if (sel && sel.isCollapsed) els.selectionToolbar.hidden = true;
  }
});

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

(async function init() {
  const projects = await loadProjects();
  if (!hasKey()) {
    toast("Welcome — add a free Gemini API key in Settings to start editing.");
  }
  if (projects.length) openProject(projects[0].id);
})();
