# Web vitals (LCP / CLS / INP)

Only meaningful when the diff touches something actually rendered (a route, a layout, a component tree) — skip for pure backend/logic/config PRs.

## Preferred path: the Browser pane tools already in this session

These work regardless of whether the target project has Chrome or `lighthouse` installed, because they drive *this* session's browser, not the target repo's tooling:

1. Start the target project's dev/preview server (the script name found in Step 3):
   `mcp__Claude_Browser__preview_start` with `{name: "<configured launch.json entry>"}`, or add one to `.claude/launch.json` pointing at the project's dev script if it doesn't exist yet.
2. Navigate to the route the PR actually changed — not just the homepage, unless that's what changed.
3. Measure via `javascript_tool`, injecting a `PerformanceObserver` for the Core Web Vitals:
   ```js
   new PerformanceObserver((list) => {
     for (const entry of list.getEntries()) {
       window.__vitals = window.__vitals || {};
       window.__vitals[entry.name || entry.entryType] = entry;
     }
   }).observe({ type: 'largest-contentful-paint', buffered: true });
   ```
   Then read `window.__vitals` back after the page settles. CLS and INP need `layout-shift` and `event` entry types respectively, same pattern.
4. `read_network_requests` for any obviously slow waterfall entries the PR's changes introduced (a newly-added blocking script, an unbounced image, etc.).

## Fallback: Lighthouse CLI

Only if a real Chrome binary is confirmed available in the environment (not guaranteed) and the user specifically wants Lighthouse-formatted numbers/score, not just raw vitals:

```bash
npx lighthouse <preview-url> --output=json --output-path=/tmp/lh.json --chrome-flags="--headless"
```

Don't install `lighthouse` as a project dependency just to run this once — `npx` runs it ephemeral. If the CLI can't find Chrome, fall back to the Browser-pane path above rather than asking the user to install Chrome for a review pass.

## Compare before/after

If practical, check out the base branch in a worktree, repeat the same measurement, and report deltas rather than absolute numbers alone — an LCP of 2.1s means little without knowing whether the PR made it better or worse. If a before/after comparison isn't practical (expensive server startup, etc.), report the absolute numbers with standard thresholds for context: LCP < 2.5s good / < 4s needs improvement / else poor; CLS < 0.1 good / < 0.25 needs improvement / else poor; INP < 200ms good / < 500ms needs improvement / else poor.

## Report format

```
### Web vitals — /routes/dashboard
- LCP: 1.8s → 2.3s (regression, still "good" threshold but worth watching)
- CLS: 0.02 → 0.02 (no change)
- INP: not measured (no interaction in the changed flow)
```
