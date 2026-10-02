# Repo process check

Every other file in this skill looks at the diff. This one looks at the *repo* — because a review, however thorough, is one person (or one model) reading a diff once. If nothing else in the repo's own process catches a mistake this review misses, that single pass is the entire safety net. This check exists to say so plainly when it's true, rather than letting the review's own thoroughness quietly stand in for infrastructure the repo doesn't have.

## When to run this

Run once per review, always — it's cheap (a handful of file-existence checks and one `gh api` call) and it's about the repo, not the specific diff, so it doesn't need a routing trigger the way the diff-content checks do.

## How to check it

```bash
# CI: does anything run automatically on a PR?
ls .github/workflows/ 2>/dev/null

# Branch protection on the PR's base branch (needs a GitHub remote + gh auth)
gh api repos/{owner}/{repo}/branches/<base-branch>/protection 2>&1

# PR template — sets expectations for what an author should self-check before requesting review
ls .github/pull_request_template.md .github/PULL_REQUEST_TEMPLATE.md .github/PULL_REQUEST_TEMPLATE/ 2>/dev/null

# Linter config — Google's own guidance treats automating mechanical checks (lint) as separate
# from and complementary to human/AI review, not a substitute for it, but its absence means
# every mechanical issue (unused vars, inconsistent patterns, obvious footguns) falls on this
# review instead of a fast, free, deterministic tool
ls eslint.config.* .eslintrc* 2>/dev/null

# PR size — Google's internal data and multiple team retrospectives converge on ~400 changed
# lines as the point past which review quality measurably drops
git diff --shortstat <base>...<head>
```

Report what's present and what's missing as a short standing section, not as "findings" mixed in with the diff's own bugs — this is about the safety net, not this PR's code.

## What to say about each gap

- **No CI workflow**: nothing runs tests, builds, or lints automatically on a push or PR — this review (or whichever human/AI review happens) is the *only* gate before merge. State this plainly; it changes how much weight the review's own findings should carry, and it means a regression this review misses ships with nothing else to catch it.
- **No branch protection on the base branch**: even if CI existed, nothing would force it to pass before a merge is allowed — a red check can be merged over. This is a one-time settings change (GitHub → repo Settings → Branches), not a diff or workflow change.
- **No PR template**: nothing prompts an author to self-report what they tested, what they intentionally skipped, or link the issue/spec being addressed — that context is currently only whatever's in the commit messages, which this skill already leans on but shouldn't have to be the only source.
- **No linter**: mechanical issues (unused imports, obviously-inconsistent patterns, some classes of real bugs like unreachable code or shadowed variables) currently rely entirely on this review noticing them by reading, instead of a deterministic tool that never gets tired or skips a file.
- **A large diff** (well past ~400 changed lines): note it, and consider recommending the author split future PRs of this shape — not something to fix retroactively on the PR under review, but worth surfacing since review quality (this skill's own, and any human's) measurably drops on large diffs, so extra scrutiny or a second pass is warranted here specifically.

## What this skill will and won't do about it

This check only **reports** gaps — it never adds a GitHub Actions workflow, changes branch protection, or adds a lint config on its own. Those are standing, repo-wide changes (exactly the kind that need the user's explicit go-ahead each time, not a one-time approval), and getting them wrong (a workflow that blocks all merges, a branch protection rule that locks out the only maintainer) has a much higher blast radius than a wrong finding in a report. If the user wants to close a gap, offer a concrete minimal starting point when asked — for CI, typically a workflow that runs the repo's existing `test` (and `lint`, once one exists) script on `pull_request`; for branch protection, requiring that workflow's check to pass before merge — but propose it and wait, don't apply it as part of a routine review.
