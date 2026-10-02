# Angle: altitude

## When to run this

The diff adds a new prop/flag or a conditional branch to a component that's
imported by 2+ files (a shared/reusable component), or bandages a symptom
instead of fixing where the behavior actually originates.

## How to check it

Ask: is this special case layered on top of shared infrastructure because
the fix genuinely can't go deeper, or because generalizing the underlying
mechanism was more work? A new prop threaded through just for one caller's
need — when an existing generic mechanism (a store, an existing prop, a
config) could cover it — is a sign the fix landed one level too shallow.
Name the deeper fix.

## Severity framing

Low-to-medium, architectural. Don't block a merge on this alone unless the
shallow fix is also fragile (depends on an invariant nothing enforces) —
then say so and treat it closer to a correctness finding.
