# Angle: efficiency

## When to run this

The diff touches a loop or `.map()`/`.forEach()`, a `useEffect`/`useMemo`, or
async/data-fetching code.

## How to check it

Flag: work computed inside a loop that's actually invariant across
iterations (hoist it above the loop); independent async operations run
sequentially with `await` back-to-back instead of `Promise.all`; blocking
work added to a startup or hot render path; closures/objects that capture
more of the enclosing scope than they need, keeping large values alive
longer than necessary; a click/select handler that sets two pieces of state
at once where one of them (e.g. a search query) unintentionally re-triggers
an unrelated debounced effect that just fired or whose result is now
irrelevant (check what each `useEffect` deps on before assuming a state
update in a handler is free).

## Severity framing

Low unless the hot path is large (list length unbounded, called on every
keystroke/frame) — then medium. This angle is about naming a cheaper
alternative, not about crashes.
