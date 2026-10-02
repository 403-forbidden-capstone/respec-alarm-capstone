# Angle: simplification

## When to run this

The diff adds new state, new conditionals, or two blocks that look like
variations on the same shape.

## How to check it

Flag redundant or derivable state (a value kept in state that could be
computed from other state on render instead), deep nesting, dead code left
behind, and — worth calling out on its own — **two parallel mechanisms added
in the same diff to solve the same problem** (e.g. a new prop-drilled channel
for "preselect an item" added alongside an existing global-store channel that
already does the same job). Name the simpler form.

## Severity framing

Low-to-medium, maintainability-oriented. Promote to medium when the added
complexity creates two sources of truth that can drift out of sync.
