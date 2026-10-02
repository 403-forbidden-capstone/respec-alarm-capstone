# Angle: cross-file / breaking-callers trace

## When to run this

The diff changes a function or component's signature (new/removed/renamed
prop, parameter, return shape, thrown exception) — or touches a module/
component that's imported by 2+ files elsewhere in the repo.

## How to check it

Grep every caller of the changed symbol. For each one, check: does it get a
new precondition it doesn't satisfy, a changed return shape it doesn't handle,
a new exception it doesn't catch, or a timing/ordering dependency it doesn't
respect?

Specifically look for **sibling-consumer-not-updated**: when a shared
component/hook gets new behavior (a new effect, a new event listener, a new
default), check whether every consumer actually wants that new behavior, not
just the one the PR was written against. A change reasoned about for consumer
A can silently change behavior for consumer B that the PR's commit message
never mentions.

Also check the diff itself for **duplicated flow logic**: does new code
hand-repeat a multi-step "reset state / open screen" sequence that an
existing helper in the same file already does, instead of reusing or
extending it? (This overlaps with the reuse angle — file it here if the risk
is *drift between the copies*, there if the risk is just *redundant code*.)

## Severity framing

A caller that breaks on a reachable input is high. A sibling consumer that
silently gains new behavior nobody decided on is medium — flag it as "worth
confirming this is intended," not as a certain bug, unless you can show it
produces a wrong result.
