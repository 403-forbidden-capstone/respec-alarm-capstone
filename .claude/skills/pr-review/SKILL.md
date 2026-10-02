---
name: pr-review
description: Runs a complete pull request review — correctness, security, dependency hygiene, bundle size, web vitals, external API latency, and React re-render risk — in one pass, in any git repository, then produces a single ranked report. Make sure to use this skill whenever the user asks to review, check, audit, or "검수" a PR, a branch, a diff, or "what I just changed" before merging, even if they don't name a specific check (e.g. "이 PR 좀 봐줘", "review this branch", "머지해도 될까", "diff 확인해줘"). Do NOT use this for pure UI/visual/responsive/accessibility review of a live page — that's the separate `ux-review` skill; this skill stays at the code level and will point visual-change PRs to `ux-review` itself.
---

# PR Review

One skill, run once per PR, that answers "is this safe to merge" from every code-level angle at once — instead of asking Claude to check things one at a time across separate messages.

## Why this exists (design notes, not runtime behavior)

This orchestrates rather than reimplements — but as of 2026-08-28 it stopped
reimplementing by *invoking* `code-review`/`security-review` wholesale and
started reimplementing their useful angles as its own lean, diff-gated passes
(Step 1/Step 2 below). Why: those two built-in skills reinject a fixed,
multi-thousand-word protocol into context on every single call (all N angles
+ a verification phase + report ceremony), regardless of whether a given
diff needs all of that. A real incident on 2026-08-28 (PR #52, a mid-size
frontend PR) burned roughly half a million tokens across the built-in
skills' boilerplate and 4 parallel subagents redoing work already done
manually first — the user flagged this directly and asked for a structural
fix, not just "be more careful." The fix: gate each correctness/cleanup
angle and each security category on whether *this diff's content* actually
touches it — never on the PR's size — and only read that angle's reference
file when it's actually going to run. See `references/angles/*.md` and
`references/security-check.md`, and the gating tables in Step 1/Step 2. This
skill still adds what a generic correctness/security pass structurally
can't: dependency hygiene, bundle size, runtime performance, API latency,
and a growing set of specific correctness blind spots that a line-by-line
diff read misses by design — some found on this exact skill's own early runs
(async error propagation, derived-value integrity, interactive-viz scope
creep — see the incident notes in each reference file), others pulled from
established review literature (Google's own eng-practices research, OWASP,
WCAG, and postmortems on what code review reliably misses — see
`references/backend-data-layer-check.md`, `references/lifecycle-and-cleanup-check.md`,
`references/accessibility-in-code-check.md`, `references/test-coverage-check.md`)
so the skill doesn't only grow reactively one incident at a time. The full
current list and what triggers each one is Step 4's table — that table is
the index, this paragraph won't try to restate it. `references/repo-process-check.md`
is different in kind: it checks the *repo's* safety net (CI, branch
protection, lint, PR size) rather than the diff, since a review is only as
load-bearing as whatever else does or doesn't catch what it misses.
Thoroughness is still not something to trade away for savings — when it's
genuinely unclear whether a check applies to a given diff, run it; a missed
category costs far more than the check itself. What changed is *how* that
thoroughness is bought: gated per-angle passes against the actual diff
content instead of always paying for the full fixed-cost protocol of two
external skills. This uses the pattern real PR bots use:

- **CodeRabbit**: doesn't dump a flat file list — it groups the diff into a walkthrough by feature area, investigates by actually reading surrounding code (not just the diff hunk), and remembers what a reviewer has previously waved off so it stops repeating dismissed nitpicks. This skill borrows the grouped-walkthrough report shape and the optional learnings file (see Step 5).
- **Vercel's bundle bot**: only comments when a size change crosses a real threshold, separates "shared/global chunk" from "per-route chunk" (a global chunk regression is worse — it taxes every page), and reports both absolute and percentage delta. This skill borrows the threshold-gating and shared-vs-route split (see `references/bundle-diff.md`).

Tool choices for the added checks (depcheck, knip, native `npm ls`/`pnpm why`, Lighthouse via the Browser pane) were picked over CI-bot stacks like Danger.js/reviewdog/SonarQube because those assume a bot posting comments on a hosted PR — this runs interactively inside a Claude Code session against a local checkout of an arbitrary repo, so everything needs to work via `npx`/native CLI with no server-side setup.

## Step 0 — Scope the review

Figure out what's being reviewed, same as `code-review` would: uncommitted diff, a branch vs its base, or a PR number/URL if `gh` is available. Ask the user only if genuinely ambiguous (e.g. multiple long-lived branches and no current diff).

Run once, up front, and reuse for every later step:
```bash
git diff --stat <base>...<head>     # files touched, +/- counts
git diff --name-only <base>...<head>
```

**Re-reviewing a fix commit ("I fixed the N things you found, check again") is two different tasks — do both, not just the first:**
1. Point-verify each originally-reported item against the fix (this is usually enough for a small/mechanical fix — a null check added, an `if` condition corrected).
2. **Separately, run the normal angle-gating table (Step 1/Step 4) against the fix commit's own diff**, as if it were any other PR — a fix that's itself a non-trivial change (swaps an algorithm, splits a function, reorders effects) can introduce new bugs of its own. Incident (2026-08-30, PR #59's `fb3421a`): a fix that correctly closed a race by splitting one function into two effects introduced a *different* race via the two effects' declaration order — something only a normal correctness pass over the fix's own diff would catch, not a targeted point-check of "did they fix what I said." Skipping step 2 because the fix "only touches the 4 things I flagged" is exactly the gap that let this through — a fix's diff is unreviewed code until it's actually been read the same way as any other diff.

## Step 1 — Correctness & reuse

Don't invoke the built-in `code-review` skill by default. Instead, run your
own pass using the gating table below: for each angle, check its trigger
against the diff's actual content (never against its size) — if triggered,
Read that angle's reference file (short, checklist-style — nothing like the
built-in skill's full multi-phase protocol) and apply it yourself, directly,
against the diff. If not triggered, skip it and don't read the file.

| Angle | Trigger | Reference |
|---|---|---|
| Line-by-line correctness | Always | `references/angles/correctness-line-scan.md` |
| Removed-behavior audit | Diff has any deletions/replacements (`git diff --stat` deletions > 0) | `references/angles/removed-behavior.md` |
| Cross-file / breaking-callers | Diff changes a function/component's signature, or touches a module imported by 2+ files | `references/angles/cross-file-trace.md` |
| Reuse | New function/component that looks like it might duplicate existing logic | `references/angles/reuse.md` |
| Simplification | New state, new conditionals, or two same-shaped blocks added | `references/angles/simplification.md` |
| Efficiency | Diff touches a loop/`.map()`, `useEffect`/`useMemo`, or async/data-fetching code | `references/angles/efficiency.md` |
| Altitude | New prop/flag/special-case added to a component imported by 2+ files | `references/angles/altitude.md` |
| Conventions | A `CLAUDE.md`/`CLAUDE.local.md` exists in the repo root or an ancestor dir of a changed file (check with `Glob` first) | `references/angles/conventions.md` |

Do the triggered angles yourself, inline, in the main thread, by default —
you already have the diff and file contents in context from Step 0, so
redoing that work in a fresh subagent is pure overhead for most PRs this
skill sees. Only fan out to parallel subagents (one per triggered angle,
handed only that angle's reference file — not the built-in `code-review`
skill) when the diff is genuinely large: rough guide, 15+ files or 500+
changed lines, or it spans enough unrelated feature areas that one pass
risks missing things. Falling back to invoking the actual `code-review`
skill wholesale is a last resort, not a default — reserve it for a diff big
and unfamiliar enough that its independent verification phase is worth the
token cost.

**Then, if the diff touches an async call chain (adds/changes an `async` function called from other async code, a `Promise.all()`/`Promise.allSettled()` batch, or a `.then()`/await consumer of one), run `references/error-propagation-check.md` yourself as a mandatory extension of this step — not an optional Step 4 routing pick.** This is not redundant with `code-review`: a real incident on this exact skill showed `code-review`'s line-by-line and cross-file angles both pass a diff like this because every line looks locally reasonable — the bug only exists in whether a throw from three calls deep actually gets caught anywhere between there and the UI, which requires tracing the whole chain, not reading the diff. The same pass also checks comments against the code that follows them (a comment claiming a fallback happens is not the same fact as the fallback existing) — code-review reads comments as context, not as claims to verify, so this is a gap only this skill's extra pass closes.

## Step 2 — Security

Don't invoke the built-in `security-review` skill by default — same reason
as Step 1: its exclusion-list/methodology text is long and mostly moot on a
diff with no security-relevant surface. Instead, Read `references/security-check.md`
(short, gate-driven) and apply it directly. Escalate to actually invoking
`security-review` only when the diff touches genuinely security-sensitive
surface — new/changed auth or session logic, payments, an authorization
boundary, a backend/API route, or new handling of external/untrusted input
reaching a backend — per that file's own escalation note.

## Step 3 — Detect project shape

Before running anything else, work out what you're standing in — every later check depends on this and must skip cleanly if the signal isn't there:

```bash
test -f package.json && cat package.json   # scripts, dependencies
test -f package-lock.json && echo npm
test -f pnpm-lock.yaml && echo pnpm
test -f yarn.lock && echo yarn
```

Note the build script name (`build`, `build:prod`, ...), the dev/preview script name, and the package manager. If there's no `package.json` at all, this is not a JS/TS project — skip Steps 4–7 entirely and say so in the report; don't force Node-specific checks onto a Python/Go/Rust repo.

**Also run `references/repo-process-check.md` here, always — it's cheap, it's about the repo rather than the diff, and it doesn't depend on project shape.** It checks whether anything besides this review would catch a mistake (CI, branch protection, lint, a PR template) and reports the gaps as a standing note, not a diff finding. It never modifies repo settings or adds workflow files itself — see the file for why and what to do instead when the user wants a gap closed.

## Step 4 — Route to the checks that actually apply

Don't run every check on every PR — read the diff from Step 0 and pick:

| Diff touches... | Run | Reference |
|---|---|---|
| Async call chains — new/changed `async` functions, `Promise.all`/`allSettled` batches, `.then()` consumers (see Step 1 — this one runs as part of the correctness pass, not standalone here) | Error propagation & stated-intent check | `references/error-propagation-check.md` |
| Distributes a total across parts via a weight/proxy variable, displays a total next to independently-rounded components, wraps a third-party API and extracts only some response fields, or adds a validation guard/fallback in response to one input site | Derived-value integrity check | `references/derived-value-integrity-check.md` |
| A `useEffect` (or equivalent) redraws a map/canvas/chart and its dependency array mixes real data with UI-only state (hover/selection/highlight), or hover handlers and a click/tap handler write to the same state | Interactive visualization scope check | `references/interactive-viz-scope-check.md` |
| A piece of state holds a position into a list (a current-index for a carousel/wizard/table/highlight/focus) and that list can be added to, removed from, filtered, or reordered elsewhere in the same component | Stale index-reference check | `references/stale-index-reference-check.md` |
| A data source changes from sync (constant, direct import) to async (a hook/fetch with loading state), or a new async source is added alongside an existing one | Sync→async migration check | `references/async-migration-check.md` |
| A database migration/schema file, an ORM/SQL/query-builder call, a route/controller/resolver that's part of an API contract, or anything on a retry/at-least-once delivery path (webhooks, queue consumers, jobs) | Backend & data-layer check | `references/backend-data-layer-check.md` |
| A `useEffect`/lifecycle hook starts a timer, listener, subscription, connection, or async operation; a `setTimeout`/`setInterval`/`addEventListener` call; an async state update after an `await`; **or a diff routes 2+ previously-separate async entry points (effects, callbacks) through one newly-shared function** | Lifecycle & cleanup check | `references/lifecycle-and-cleanup-check.md` |
| A new/changed interactive element on a non-native tag, a modal/dialog/dropdown/menu, a custom multi-part widget (tabs, accordion, combobox), or ARIA attributes | Accessibility-in-code check | `references/accessibility-in-code-check.md` |
| Any non-trivial logic change — weight heavily for bug-fix PRs, new branches in existing logic, or a file with an existing sibling test file | Test coverage check | `references/test-coverage-check.md` |
| New/changed imports, new dependencies, lazy-loading boundaries, or a large diff (100+ changed lines) — and a build script exists | Bundle size diff | `references/bundle-diff.md` |
| `package.json` dependencies, or many new files/exports | Unused deps/exports | `references/dependency-hygiene.md` |
| (always, if `package.json` exists — it's cheap and native) | Duplicate dependency versions | `references/dependency-hygiene.md` |
| Components with props, hooks, list rendering (`.jsx`/`.tsx`) | React re-render heuristics | `references/react-rerender-heuristics.md` |
| `fetch`/`axios`/http client calls, new/changed endpoints | External API latency | `references/api-latency.md` |
| A dev/preview script exists and the diff touches rendered UI/routes | Web vitals | `references/web-vitals.md` |
| A whole sort/search/selection/ordering algorithm is replaced (not just a condition or data source feeding an unchanged one) | Algorithm-swap regression check | `references/angles/algorithm-swap-check.md` |

A pure logic change inside an already-imported function (same imports, same exports, just different internal behavior) essentially never moves bundle size — don't spend a double-build on it. Building twice via a worktree costs real time; reserve it for diffs where the import graph or dependency tree actually changed.

If the diff is overwhelmingly CSS/layout/visual (many className/style/JSX-structure changes, few logic changes), say so plainly and suggest the user run `ux-review` on the live page instead of trying to approximate visual judgment from a diff — that skill has real screenshots and breakpoint testing that this one doesn't.

Every check must degrade to a one-line "skipped: <reason>" in the final report rather than block the whole review — a missing tool or an incompatible project shape is information, not a failure.

## Step 5 — Optional: learnings

If `<repo>/.claude/pr-review-learnings.md` exists, read it before writing findings — it holds things the user has previously told you to stop flagging in this repo (e.g. "we intentionally don't memoize this component, ignore re-render warnings on `<Chart>`"). Skip anything it covers. If the user dismisses a finding as intentional during this session, offer to append it there for next time — don't do it silently.

## Step 6 — Report

**Never silently drop a finding you actually confirmed or plausibly suspected, no matter how minor it seemed at the time.** A real incident: this skill found a transient loading-state flash in a component, correctly judged it low severity and self-healing, and then left it out of the report entirely because it seemed too minor to mention — only for the same finding to resurface later, independently, as evidence the skill was "still missing things." The triage was right; the silent omission was the actual bug. Low severity is a reason to put a finding last and keep it to one line, never a reason to cut it — whether something is worth fixing is the user's call, and they can't make it about a finding they never saw. If the report would otherwise get cluttered, compress minor items into a short "Minor / observed, not blocking" list rather than deleting them — one line per item is enough. This applies to every check in this skill, not just the ones diff-triggered this run.

Group findings by feature area (the files/directories they cluster in), not as a flat file list — a reviewer thinks in "the auth flow changed" not "file 7 of 12 changed". Within each group, rank by severity. Structure:

```
## PR Review: <scope>

### Summary
One paragraph: what changed, and the overall verdict (safe to merge / needs changes / blocked).

### <Feature area 1>
- [severity] finding — file:line — one-line fix suggestion
...

### <Feature area 2>
...

### Dependency & bundle
...

### Performance
...

### Repo process
One or two lines from `repo-process-check.md` — what's missing (CI, branch protection, lint, PR template), stated as a standing fact about the repo, not a finding about this PR. Omit this section only if the repo genuinely has all of it.

### Skipped
- <check>: <reason>
```

Findings from Steps 1–2 (the correctness angles and the security pass) and the diff-triggered checks in Step 4 (backend/data-layer, lifecycle/cleanup, accessibility-in-code, test coverage, derived-value integrity, interactive-viz scope, error propagation, async migration) all fold into the feature-area groups by where they actually are in the code — don't give each check its own separate untouched sub-report. The point of this skill is one merged picture organized the way a reviewer thinks about the change, not a stack of reports stapled together by which pass produced them.

## Step 7 — When to suggest `/code-review ultra`

This skill and its subagents are all the same model reviewing its own reasoning — real, but limited: blind spots in the code tend to be blind spots in the review too, since the same assumptions that produced the bug also make the review of it feel fine. `/code-review ultra` is a cloud multi-agent review with more independent angles, but it's user-triggered and billed — it cannot be launched from inside this skill, and must never be run automatically.

End the report with a one-line suggestion to run it, but only when the signal actually warrants the cost — not on every PR:
- The diff is large or touches many feature areas at once (harder for a single pass to hold in mind)
- Any finding landed in a security-sensitive area (auth, payments, data access, external input handling)
- Several findings came back as PLAUSIBLE rather than CONFIRMED (real uncertainty, not just noise)

Otherwise, leave the suggestion out — a routine small PR with a clean report doesn't need it, and appending it every time trains the user to ignore it.
