# Audit fix split — 2026-10-11

Source: `AUDIT_2026-10-11.md` (the numbers below match it). Paths are under `web/src/` unless shown otherwise.

**Aditya and Chaubey: every task here is small. One task = a few lines in one file.** If a task turns out bigger than that, stop and hand it to Ujjwal.

## Ground rules (everyone)

- Pull `master` first. The audit was run on `927baac` and master has moved since, so **check the problem still exists before you fix it**. If it's already fixed, tick it and move on.
- One branch per person (`fix/<name>-audit`), small PRs into `master`.
- Only edit the files listed for your task. If you need someone else's file, ask them.
- **Don't run `pnpm eval` or real workflows.** Gemini and Firecrawl credit is almost gone. Checking the UI with `pnpm dev` is fine.
- Before every PR: `cd web && npx tsc --noEmit && npx eslint .` must pass.
- **How to give a task to Claude:** paste the task text exactly as written here, plus the file path, and add: *"Make the smallest change that fixes this. Don't touch other files. Explain the change before you edit."* Read the diff before you commit.

## File ownership

| Person | Owns |
|---|---|
| **Ujjwal** (heavy) | Everything in `lib/` (pipeline, llm, connectors, db, auth, safety), `app/api/**` except export, `vercel.json`, `schema.sql`, the database, the demo env, `components/auth/**`, `Sidebar.tsx`, `AskData.tsx`, `PlanEditor.tsx` (logic) |
| **Aditya** (text + CSS) | `app/page.tsx`, `app/(app)/new/page.tsx`, `components/landing/**`, `components/workflow/Match.tsx`, `MissionControl.tsx`, `Pipeline.tsx`, `Cell.tsx`, `Insights.tsx`, `app/globals.css`, READMEs, `CLAUDE.md`, `FINALS_TASKS.md` |
| **Chaubey** (UI) | `app/(app)/workflows/page.tsx`, `app/(app)/workflows/[id]/page.tsx`, `StatusBadge.tsx`, `AccountMenu.tsx`, `RecordDrawer.tsx`, `DataTable.tsx`, `api/workflows/[id]/export/route.ts`, new `not-found.tsx` / `error.tsx` |

---

## Aditya: wording, CSS, docs (easy)

No logic changes except where a task says so. Each one is find-the-text, replace-the-text.

- [ ] **A1. Overclaiming copy, landing + new page** (audit #10)
  - `app/page.tsx` lines ~29, 88, 96 and `app/(app)/new/page.tsx` ~123: remove "word-for-word" and "every row proves where it came from". Use "every row links to its source page".
  - `app/page.tsx` ~24: replace "agents" with "AI-planned pipeline".
- [ ] **A2. Overclaiming copy, components** (audit #10)
  - `Match.tsx` ~112: remove "word-for-word"; use "Quote found in source".
  - `MissionControl.tsx` ~119, 175, 193: replace "agent(s)" wording with "step(s)" or "pipeline".
  - `Pipeline.tsx` ~179: rename "Confidence" to "Match score".
- [ ] **A3. Landing demo data** (audit #12) `components/landing/DemoRun.tsx` ~27-28: the "React jobs" demo shows a "Shopify Developer" row and a € salary from RemoteOK (RemoteOK only gives USD). Change that row to a React job title and the salary to `$`.
- [ ] **A4. Demo column count** (audit #72) The landing demo says "8 columns" but shows 4. Change the text to match what's shown.
- [ ] **A5. Text contrast** (audit #38) `app/globals.css` ~11-12: `--color-zinc-500: #6b6f76` and `--color-zinc-600: #50535a` are too dark to read on a projector. Make them lighter (try `#8b8f96` and `#71757c`). Open `pnpm dev`, check that grey text is readable and nothing looks broken.
- [ ] **A6. Keyboard focus** (audit #62) `app/globals.css` ~115 has `outline: none` that removes the focus ring everywhere. Delete it only if the `:focus-visible` rule above it (~108) still covers buttons and links. Check by pressing Tab on the landing page: you should see an outline.
- [ ] **A7. Unused CSS** (audit #71) In `app/globals.css`, search the whole `src/` folder for `hero-wordmark`, `horizon`, `preview-frame`, `animate-shimmer`. Delete each class **only if** the search finds no other use.
- [ ] **A8. Landing `<main>`** (audit #72) `app/page.tsx`: wrap the page body in `<main>` instead of `<div>` (just the outer tag).
- [ ] **A9. Double Enter** (audit #61) `app/(app)/new/page.tsx` ~76: pressing Enter twice submits twice. At the top of the submit function, add `if (busy) return;` (use whatever the "submitting" state is called in that file).
- [ ] **A10. Url cells** (audit #61) `Cell.tsx` ~417: a url-type cell turns any text into a link. Only make it a link if the value starts with `http://` or `https://`; otherwise show plain text.
- [ ] **A11. Minus signs** (audit #61) `Insights.tsx` ~31: negative numbers lose their minus sign. Find the code that strips characters from the number and keep `-`.
- [ ] **A12. Docs** (audit #73)
  - Root `README.md` and `CLAUDE.md`: add `RUN_LIMIT_PER_HOUR`, `AI_LIMIT_PER_HOUR`, `MAX_RAW_ITEMS`, `EXTRACT_BATCH`, `LLM_NO_FALLBACK` to the env list (ask Ujjwal for one line on what each does).
  - `FINALS_TASKS.md`: tick the boxes that are done (ask the owner), change "one provider" to "providers fail over", and "90s" to "180s".

## Chaubey: UI fixes (easy, one file each)

- [ ] **C1. Polling never stops** (audit #9) `workflows/[id]/page.tsx` ~109-119: when the fetch returns 404 or 401, stop the poll timer and show "This workflow no longer exists" (404) or "Please sign in again" (401).
- [ ] **C2. Example label** (audit #35) `workflows/page.tsx` ~493: the list API already returns `owner_id`. When `owner_id` is `null`, hide the Delete button and show a small "Example" tag next to the title.
- [ ] **C3. Phone layout** (audit #36) `workflows/page.tsx` ~340: the header row overflows on a phone. Add `flex-wrap` (and `gap-2`) to that row. Check in the browser at 375px width (DevTools → device toolbar).
- [ ] **C4. Error pages** (audit #37) Create `app/not-found.tsx` ("Page not found" + link to `/workflows`) and `app/error.tsx` ("Something went wrong" + a "Try again" button that calls `reset()`). `error.tsx` must start with `"use client"`. Copy the styling from an existing page. Check by opening `/does-not-exist`.
- [ ] **C5. "Failed" count** (audit #39) `workflows/[id]/page.tsx` ~417: "2 failed" also counts sources that just returned nothing. Only count sources whose status is an actual error, so it matches the Sources tab.
- [ ] **C6. "Confidence" labels** (audit #10) Rename "Confidence" to "Match score" in `RecordDrawer.tsx` ~126 and `DataTable.tsx` ~208. In `workflows/[id]/page.tsx` ~494, replace "agents" wording with "pipeline". Labels only.
- [ ] **C7. Small UI bugs in `workflows/[id]/page.tsx`** (audit #61). One commit each:
  - ~376: "1 rows" → "1 row" (singular when the count is 1).
  - ~293: a long prompt overflows; add `break-words` to it.
  - ~271: disable the Delete button while the workflow is running (use `isRunning` from `components/utils.ts`).
  - ~346: the "seems stuck" check uses 3 min but the server uses 6 min, so Retry can start a second run. Change the client check to 7 min.
- [ ] **C8. Copy button** (audit #62) `workflows/[id]/page.tsx` ~313: add `aria-label="Copy"` and change the text/icon to "Copied" for 1.5s after a click.
- [ ] **C9. Workflows list states** (audit #61) `workflows/page.tsx`:
  - ~285: when loading fails, show "Couldn't load workflows" instead of "No workflows yet".
  - ~459: rows show raw status text (`completed`, `review`). Use `<StatusBadge>` instead.
- [ ] **C10. Review badge** (audit #61) `StatusBadge.tsx` ~148: give `review` its own colour and label "Needs review" (skip if it's already done on master).
- [ ] **C11. Sign-out spinner** (audit #61) `AccountMenu.tsx` ~217: if sign-out fails, the spinner never stops. Reset the loading state in a `finally`.
- [ ] **C12. Export small fixes** (audit #70) `api/workflows/[id]/export/route.ts`:
  - Run the header names through `csvCell` too.
  - Use `\r\n` between lines instead of `\n`.
  - Return the 404 as JSON: `NextResponse.json({ error: "Not found" }, { status: 404 })`.
  - If the title has no ASCII letters, name the file `dataset.csv` instead of `-.csv`.

---

## Ujjwal: everything heavy

Monis's files (`llm.ts`, `extract.ts`, `validate.ts`, `planner.ts`) are in this list too. Hand them back to Monis if Monis is available.

**Before the demo (do first)**
- [x] #1 Delete or hide the empty, junk and duplicate shared examples in the DB (owner_id IS NULL). Check the IDs listed in the audit.
- [ ] #3 Set `RUN_LIMIT_PER_HOUR` / `AI_LIMIT_PER_HOUR` high in the demo env.
- [x] #2 `safety.ts`: fix the false positives and catch "pipe bomb" without the LLM.
- [x] #4 `null` JSON body → 500 on POST workflows, /run, /ask, /columns, PATCH.
- [x] #5, #6, #31 Run time budget: in-flight LLM calls, the top-up search and slow steps can exceed 300s.
- [x] #7 LLM failover on Gemini 400 / Anthropic credit 400 / empty SAFETY answer.
- [x] #8 Dedupe collapses list pages to 1 row (`validate.ts:287`).
- [ ] #11 DDG/Bing scraping vs the robots.txt claim (fix the code or the claim; tell Aditya the wording).

**Correctness (B)**
- [ ] Connectors: #13, #14, #15 (CoinGecko), #16, #63 (jobs), #28, #29, #30, #32, #59, #60, #64, #65, #58 (robots) — done: #13, #14, #15, #16, #63
- [ ] Extraction / validation / planner: #17, #18, #19, #20, #21, #44, #45, #46, #47, #48, #67, #68, #69 + the morning items (7c missing must-include value; subject checks for keyword rows) — done: #21
- [x] Run / refresh: #22, #23, #40, #41, #42, #43, #66 (sync-chain cleanup in #66 skipped: not a bug)
- [x] Cron: #24 (use `claimRun`, don't restart cancelled), #25 (daily vs 6h), constant-time secret compare (#70)
- [x] Security: #26 export formula `-1+1|cmd` (in Chaubey's export file; coordinate), #27 plan edits skip `blockedReason`, raw TypeError text, client keys in the plan
- [x] API: #49, #50, #51, #52, #53, #54, #55 (credit spent on failure), #56, ask 503 vs columns 502, "no records" 400 → 409 (#70) (#50 skipped: covered by #41; watch select UI left to Chaubey)
- [ ] #33 email verification (probably post-demo), #57 `schema.sql` re-runnable + prune usage_events

**UI that needs logic (too tricky for a first task)**
- [ ] #34 `AskData.tsx`: use `rows_considered`; say "based on the top 80 rows"; double-Enter submit
- [ ] #61 stale table after Stop; discard a review-state workflow (`PlanEditor`); "Try again" on a refused prompt; cited-rows mode ignores filters (`DataTable.tsx:79`); Pipeline row count index fallback; Sidebar stale after delete + 3 pollers + nav highlight; deep links lost after sign-in (`AuthForm.tsx`, watch for open redirect)
- [ ] #62 tab roles and aria-sort; unlabelled source select
- [ ] #72 per-page tab titles; PlanEditor text; "Failed" filter includes cancelled; Insights badge; raw "Record #id"; AskData list key
