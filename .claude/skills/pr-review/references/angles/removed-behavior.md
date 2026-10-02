# Angle: removed-behavior audit

## When to run this

The diff has at least one deleted or replaced line (`git diff --stat` shows
deletions > 0). Skip on a pure-addition diff — there's nothing to audit.

## How to check it

For every line the diff DELETES or REPLACES, name the invariant or behavior
it used to enforce, then find where (if anywhere) the new code re-establishes
it. If you can't find it, that's a finding: a dropped guard, a narrowed
validation, a removed error path.

Give special weight to **`useEffect`/hook dependency-array changes** — a real,
recurring bug class: a variable is dropped from the deps array but the effect
body still reads it, so the effect stops re-running when that variable
changes. When you see one:

1. Confirm the body still reads the dropped variable.
2. Find **every** consumer of that component/hook, not just the one the PR's
   own comment reasons about — a shared component often has a sibling
   consumer for whom the dropped dependency was load-bearing, and the PR
   author usually only thought about the consumer they were actually working
   on.

**This dependency-completeness check isn't only for diffs that delete a dep —
run it on every brand-new `useEffect`/async fetch too**, even with nothing to
diff against. Incident (2026-08-29, PR #59): a new effect reordered a course's
stops using `fetchDestinationsMatrix(origin, customStops)` — a car-only
driving-time API — with deps `[origin, customStops, manualOrderIds]`. The
component also has a `travelMode` toggle ('car'/'walk'/'transit'), and the
reorder is applied unconditionally regardless of it. Nothing was *removed*
here (it's new code), so the diff-deletion trigger above would never fire —
but the effect's own dependency list was incomplete relative to what it
should have reacted to, and the underlying fetch's mode was never
parameterized at all. The tell: **read what state the component has that
could plausibly change what a fetched/computed value should be (a mode
toggle, a filter, a selected tab), then check whether the effect's deps *and*
the function's own parameters actually account for all of it** — not just
whether old async responses get correctly ignored (that's the stale-response
race this angle already covers), but whether the fetch's *inputs* are
complete in the first place.

## Severity framing

A removed guard that's reachable and produces a wrong/crashing result is
high. A removed dependency that only stops re-firing for a sibling consumer
the PR didn't touch is medium — real, but conditional on that consumer's
usage pattern; say so explicitly rather than asserting certainty. A missing
dependency/parameter that silently makes a feature use the wrong mode/context
for some or all of its intended cases (as in the PR #59 incident above) is
high when it defeats the diff's own stated purpose.
