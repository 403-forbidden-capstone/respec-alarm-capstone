# Angle: line-by-line correctness

Always run this one — it's the core of the review, not an optional angle.

## How to check it

Read every hunk in the diff, line by line. For lines inside a function the diff
touches, also read the rest of that function (not just the changed lines) —
a bug can live in an unchanged line the PR re-exposes or fails to fix.

For each line, ask: what input, state, timing, or platform makes this line
wrong?

- Inverted or off-by-one conditions
- Null/undefined deref on a value that's optional somewhere upstream
- Missing `await` on a call whose result is used synchronously after it
- Falsy-zero treated as missing (`if (!count)` when `0` is valid)
- Wrong-variable copy-paste (near-identical lines where one still says the old name)
- An error swallowed in a `catch` with no rethrow/log/fallback
- Unescaped regex metacharacters in a pattern built from a variable
- A DOM event handed to a function typed for something else (`onClick={handler}`
  passing the event object where a domain value was expected)
- A diff that replaces an entire sort/search/ordering algorithm (not just a
  condition or a data source) — if you see this, also run
  `references/angles/algorithm-swap-check.md` (Step 4 table has the trigger).

## Severity framing

A wrong condition or null deref that's reachable on the happy path is high. One
reachable only through a rare-but-real state (error branch, empty list, first
render before data loads) is medium. A cosmetic-only slip is low — report it,
don't promote it.
