# React re-render heuristics (static, not measured)

Live profiling (React DevTools Profiler) needs a running app, a route to click through, and interpretation of flame graphs — none of that generalizes across arbitrary projects and PRs. This is a static read of the diff instead. Always label this section as **heuristic** in the report — these are "worth a second look," not measured regressions. Don't overstate confidence.

Read the diff hunks for `.jsx`/`.tsx` files (or `.js`/`.ts` files that clearly contain JSX) and look for:

## 1. Inline literals passed as props to a memoized component

If a component in the diff (or a component it renders) is wrapped in `React.memo` / `memo(...)`, check whether callers pass:
- An inline arrow function (`onClick={() => ...}`) instead of a `useCallback`-wrapped handler
- An inline object/array literal (`style={{...}}`, `data={[...]}`) instead of a stable reference

Either defeats the memoization — a new reference every render means `memo` never actually skips a re-render. Only worth flagging when the receiving component *is* memoized; inline props to a plain (non-memoized) component are normal and not a finding.

## 2. `useMemo`/`useCallback` with a suspicious dependency array

- Missing a dependency that's clearly used in the callback body (stale closure risk, not just a perf issue — flag this as correctness-adjacent, slightly higher severity)
- An object/array/function literal *inside* the dependency array (defeats the memoization the same way as #1, since the array itself is a new reference every render)
- An empty `[]` array where the body references props/state that can change — usually a bug, not just a perf nit

## 3. Unstable list keys

`key={index}` (or no key at all) on a list that can reorder, filter, or have items inserted/removed in the middle — causes React to misattribute state across re-renders, not just waste render cycles. This is worth flagging even outside a "performance" framing.

## 4. Context value churn

A `<Context.Provider value={{...}}>` with an inline object literal — every consumer re-renders on every render of the provider, regardless of whether the actual values changed. Look for this especially in files that changed near the top of the component tree (layout, app shell, providers) since the blast radius is every consumer.

## What NOT to flag

- Inline props to components that aren't memoized — this is normal React and flagging it is noise.
- Missing `useMemo` around cheap computations (a `.filter()` on a short array, simple string formatting) — memoization has its own cost; only worth it for genuinely expensive work or to preserve reference identity for #1/#4.
- Any of the above in code the PR didn't touch — this skill reviews the diff, not the whole codebase.

## Report format

```
### React re-render (heuristic — not measured)
- [medium] `src/components/RouteList.jsx:42` — inline `style={{...}}` passed to `<RouteCard>`, which is wrapped in `React.memo` — defeats the memoization
- [low] `src/hooks/useFilters.js:18` — `useMemo` dependency array missing `sortOrder`, which is read in the callback — check for stale results, not just a perf nit
```
