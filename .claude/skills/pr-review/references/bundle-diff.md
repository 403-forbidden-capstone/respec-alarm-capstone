# Bundle size diff

Borrowed from Vercel's bundle bot: don't report noise, report *regressions that matter*. Only surface this section if a change crosses a real threshold — otherwise every PR gets a "-0.3KB" comment nobody reads and the signal dies. Default threshold: **flag if any single output file changes by more than 5% or 10KB, whichever is smaller in absolute terms; always flag if a shared/vendor chunk grows at all** (a shared chunk regression taxes every route, not just one page — that asymmetry is the whole reason Vercel splits the two).

## How to measure it generically

There's no universal bundle-analyzer plugin you can assume is installed, so measure the one thing every bundler produces: the output directory. Build twice and diff sizes.

```bash
# 1. Find the build script and output dir from package.json (build/build:prod, "outDir" in vite.config, "dist"/"build"/".next" by convention)
grep -m1 '"build"' package.json

# 2. Build the PR branch (current working tree state), capture output dir sizes
npm run build 2>&1 | tail -20
du -sk dist/* 2>/dev/null | sort -rn   # or build/*, .next/* — whichever the project uses

# 3. Build the base branch in a worktree so you don't disturb the working tree
git worktree add /tmp/pr-review-base <base-ref>
(cd /tmp/pr-review-base && npm install --silent && npm run build 2>&1 | tail -20)
du -sk /tmp/pr-review-base/dist/* 2>/dev/null | sort -rn

# 4. Clean up
git worktree remove /tmp/pr-review-base --force
```

**Copy untracked env/config files into the worktree before building it — this is not optional.** `git worktree add` only checks out tracked files; `.env`, `.env.local`, and similar files are gitignored by convention and will be silently missing in the new worktree. Frameworks that inline `import.meta.env.*`/`process.env.*` at build time (Vite, Next.js, CRA) treat a missing env var as `undefined`, and a minifier can then constant-fold a whole feature branch (`enabled ? doThing() : null`) into dead code and strip it — making an entire library (Supabase, an SDK, anything gated by a "is this configured" check) vanish from just one side of the comparison. This produces a bundle-size delta that looks huge and looks real (build succeeds, numbers are concrete) but has nothing to do with the PR's actual changes — a false positive that's more convincing than a normal bug because it's a real measurement, just of the wrong thing. Before trusting any delta:

```bash
cp .env /tmp/pr-review-base/.env 2>/dev/null   # and .env.local, .env.production, whatever the project uses
```

If the sizes look surprising in either direction — much bigger or suspiciously smaller — that's the moment to double check for this, not a moment to just report the number. Grep the two output bundles for a distinctive string from a library you'd expect in both (e.g. a client library's internal method name) before writing the finding; if it's present on one side and absent on the other with no code difference to explain it, that's the env-file trap, not a real regression.

Compare the two `du` outputs file-by-file (match by filename stem, since hashed filenames change — a `main-a1b2c3.js` and `main-d4e5f6.js` are "the same file" for this purpose, match by position/role, e.g. "the largest JS chunk", "the CSS bundle").

## What counts as "shared/vendor"

Heuristics, since there's no universal manifest to read:
- A JS chunk that's referenced from more than one HTML entry point or route (if the project has one entry point, everything is "shared" by definition — skip the split, just report total).
- Named `vendor`, `chunk-vendors`, `common`, or similar by convention.
- If you can't tell, just report total output size — don't force a split that isn't there.

## If there's no build script

Say so and skip — this is common for libraries, backends, or CLI tools that don't produce a browser bundle. Don't try to substitute something else.

## Report format

```
### Bundle size
- shared/vendor chunk: 142KB → 158KB (+11.3%, +16KB) ⚠️ regression, affects every route
- route chunk (Dashboard): 34KB → 31KB (-8.8%)
- total: within threshold, not flagged
```
