# Angle: algorithm-swap regression

## When to run this

The diff replaces an entire sort/search/selection/ordering algorithm or
heuristic — not just a condition, a threshold, or a data source feeding an
unchanged algorithm. Signal: a function that used to loop/iterate to build
a result now does a single `.sort()`/`.filter()` instead (or vice versa), or
a whole function body is swapped for a differently-shaped one solving the
same named problem.

## How to check it

Compare structural properties, not just outputs. Name what algorithmic
property the OLD approach guaranteed — chaining (each step depends on the
previous step's result, not a fixed reference point), stability, exhaustive
search vs. greedy, optimality for small N — and check the new code still
guarantees it, independent of whether its *inputs* got more accurate.

Incident (2026-08-29, PR #59): a course-reordering feature replaced a proper
nearest-neighbor chain (`buildGreedyOrder` in `routePlan.js` — each step
re-sorts from the *last visited* stop) with a single sort by distance *from
the origin only* (`covered.sort((a,b) => byId.get(a.id).minutes -
byId.get(b.id).minutes)`). The new version used more precise data (real
driving time from an API vs. haversine estimate) but a strictly weaker
ordering algorithm — for a clustered set of stops it produces an objectively
worse tour than the code it replaced, while being labeled "measured/precise"
in the UI, which overstates the guarantee. Every individual line was locally
correct; the bug only showed up when someone named the property the old code
had (chaining) and checked whether the new code still had it — a plain
line-by-line read never asks that question, since nothing about either
version's lines is individually wrong.

## Severity framing

High when the diff's whole stated purpose was to improve the exact property
that got silently dropped (as above) — that's not a regression on some
unrelated axis, it's the diff failing at its own job while looking like it
succeeded. Medium if the property was incidental rather than the diff's main
point.
