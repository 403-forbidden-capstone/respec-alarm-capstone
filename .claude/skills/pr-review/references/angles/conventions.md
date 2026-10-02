# Angle: conventions (CLAUDE.md)

## When to run this

Only after confirming a `CLAUDE.md` or `CLAUDE.local.md` actually exists —
check with a cheap `Glob` (repo root, `~/.claude/CLAUDE.md`, and any ancestor
directory of a changed file) *before* reading this file or doing anything
else for this angle. If none exist, skip the angle entirely — don't read
this file, don't report anything for it.

## How to check it

Read every applicable CLAUDE.md/CLAUDE.local.md (a directory's file only
governs files at or below it). Check the diff for violations you can quote
exactly: the rule's exact text and the exact line that breaks it. No style
preferences, no "spirit of the doc" inferences.

## Severity framing

Whatever the rule's own stakes imply — quote it and let the report's reader
judge. Don't invent severity language beyond what the rule states.
