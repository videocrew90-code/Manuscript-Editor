# Redline — a manuscript editing tool

A free, browser-only editing workbench: paste a manuscript, select any passage, chat with an AI editor about it, accept or reject the suggestion, and it's applied with full undo history. Learns your editing style from before/after examples you feed it. Handles 100k–500k+ word manuscripts by splitting them into chapters.

## Setup (free hosting on GitHub Pages)

1. Create a new **public** GitHub repo (e.g. `redline-editor`).
2. Upload all files in this folder, keeping the `js/` and `css/` subfolders intact.
3. Go to the repo's **Settings → Pages**, set source to your default branch, root folder.
4. Your tool will be live at `https://<your-username>.github.io/<repo-name>/` within a minute or two.

## Getting a free API key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and generate a key (free tier).
2. Open the tool, click **Settings** in the bottom-left, paste the key, save.
3. The key is stored only in your browser (`localStorage`) — never sent anywhere except directly to Google's API.

## How it works

- **Projects** = one per client/book. Each has its own chapters and its own style profile.
- **Chapters** keep the manuscript in manageable chunks so the editor stays fast even on very long books. Use **Import large manuscript** to paste a huge draft and have it auto-split into chapters by word count (set the target in Settings).
- **Editing**: select any passage in the manuscript, click **Ask editor**, and either type an instruction ("tighten this," "fix the tense," "make more formal") or leave it blank for a general polish. The suggested revision shows as a red-strike/green-insert diff. Accept applies it and logs it to history; reject discards it. You can keep chatting about the same passage before deciding.
- **Undo**: the toolbar's Undo button reverts the most recent accepted edit in the open chapter. The **History** button shows the full edit log per chapter with a Revert button on each entry.
- **Style profile**: in the Style profile panel, add pairs of your own before/after edits (paste real examples from past work). Click "Regenerate style summary" to have the AI distill your habits into a brief that's injected into every future edit request for that project.
- **Checks tab**: best-effort heuristics only —
  - *AI-pattern heuristic*: flags prose that reads like unedited AI output (low/medium/high, with reasoning). Not a certified detector.
  - *Distinctive phrases*: pulls out a few phrases worth manually searching for lifted/unattributed text. This is **not** a real plagiarism-database check (no free service does that at this scale) — treat it as a shortlist for your own manual spot-checks, or pair with a paid tool like Copyscape/Turnitin if you have access.

## Data & privacy

Everything — manuscripts, style examples, edit history — lives in your browser's IndexedDB, per-device, per-browser. Nothing is uploaded anywhere except the text you explicitly send to Gemini for a suggestion. There's no backend, no account, no sync between devices. If you clear your browser data, it's gone — there's currently no export/backup button, worth keeping in mind for anything irreplaceable.

## Known limitations (v1)

- Data doesn't sync across devices/browsers (no backend by design, to keep this free).
- Undo/revert works by text-matching, so if you've edited the exact same sentence multiple times, always double check the result after a revert.
- The AI-detection and phrase checks are heuristics, not guarantees — use them as a first pass, not a verdict.
- Free-tier Gemini rate limits still apply; the app automatically falls back across several model versions if one is rate-limited.
