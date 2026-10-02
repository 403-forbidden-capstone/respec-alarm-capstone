# Angle: reuse

## When to run this

The diff adds a new function/component whose shape (name, parameters, what it
does) looks like it might already exist somewhere in the codebase.

## How to check it

Grep shared/utility modules and files adjacent to the change for something
that already does this. Also check *within the same diff* — PRs sometimes
copy-paste a block twice in one sitting (e.g. the same "clickable card"
markup+handlers added to two components) instead of factoring it once. Name
the existing helper (or the natural shared helper) to call instead.

## Severity framing

Low-to-medium — this is a maintainability finding, not a crash. Note it in
the report but don't block a merge on it alone unless the duplication is
already showing drift (the two copies aren't identical).
