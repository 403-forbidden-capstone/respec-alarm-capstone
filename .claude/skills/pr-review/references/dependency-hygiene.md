# Dependency hygiene

Two independent, cheap checks. Neither needs project-specific setup.

## Unused dependencies / exports

```bash
npx depcheck
```
`depcheck` works on plain `package.json` + source scanning, no config needed for most JS/TS projects — good default. Report anything it lists under "Unused dependencies" that's also new or touched in this PR's diff (an unused dep that predates the PR is repo debt, not this PR's problem — mention it once, briefly, don't make it a blocking finding).

Optionally, if the project has a conventional structure (single entry point, standard `src/`), try:
```bash
npx knip
```
`knip` catches unused *exports* and files, which `depcheck` doesn't. It's pickier about project shape and will sometimes error out on unconventional monorepos or custom build setups — if it exits non-zero or the output looks like a config error rather than real findings, skip it silently rather than reporting a wall of false positives. Don't spend time writing a `knip.json` for the target repo unless the user asks — that's scope creep for a review pass.

## Duplicate/conflicting dependency versions

No install needed — every package manager has a native command for this. Detect which one from the lockfile (Step 3 in SKILL.md) and use the matching command:

```bash
# npm
npm ls --all 2>&1 | grep -i "invalid\|UNMET\|deduped" 
npm dedupe --dry-run

# pnpm
pnpm why <pkg>   # only useful once you already suspect a specific package
pnpm list --depth Infinity 2>&1 | grep -i "peer\|conflict"

# yarn (classic)
yarn list --pattern <pkg> 2>&1
```

The signal worth reporting: the *same* package present at two or more incompatible major versions in the tree (usually visible as duplicate entries at different depths in `npm ls`/`pnpm list` output), especially if one of them was pulled in by a dependency this PR just added. A single new dependency dragging in a second copy of React, or a second copy of a large utility library, is worth flagging — routine transitive dedup noise in a mature lockfile is not.

## Report format

```
### Dependency hygiene
- depcheck: `lodash` added in this PR but no import found — confirm it's actually used
- version conflict: `date-fns@2.x` (existing) and `date-fns@3.x` (pulled in by new `some-lib` dependency) — two copies will ship
- knip: skipped (project uses a custom monorepo layout knip doesn't recognize)
```
