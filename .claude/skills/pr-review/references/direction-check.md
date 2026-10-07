# Direction check

A line-level review answers "is this diff correct?" It doesn't ask whether the shape of the change will hold once the next few issues build on it. That second question gets cheaper to answer the earlier it's asked. Function signatures, IDs, stored formats, and event names cost almost nothing to change while only a dev screen calls them. Once three screens and a server table depend on them, changing them means a migration.

## When to run this

Always run it, but keep the output in proportion to the PR. A PR that adds a new module, public interface, persisted format, or anything other open issues will build on gets the full pass. A small fix or a copy change gets one line: "방향성: 해당 없음 (이유)".

## How to check it

1. **Gather what will build on this.** Read the linked issues (`Closes`/`Refs`) and their parent. Read open issues that mention the touched module, its paths, or the linked issue number (`gh issue list --state open --search "<module or path> in:body"`). Read other open PRs in the same area (`gh pr list --state open`). Read design docs in the repo (`docs/`) and any schema or migration for data this code persists or will send. Every concern you raise must cite one of these sources. Don't invent future requirements.
2. **Can the next piece be added without rewriting this PR's public surface?** For each upcoming piece of work you found, check whether it fits the current function signatures, IDs, stored formats, events, and error behavior. If it doesn't, name the collision: what exists now, which issue, doc, or schema line it collides with, and what shape would fit both.
3. **Contracts that are cheapest to change now.** Look at identifiers (format, uniqueness, whether a derived ID leaks into lists other code will reconcile against), persisted formats (keys, versioning, how a new field gets added later), units and time zones, event and status names, and sync vs async boundaries.
4. **Parity plans.** If a twin implementation is planned (another platform, a server mirror), check that the current shape maps onto that platform's real API, not just the same function names.
5. **Approach and scope.** Is there a platform-standard or simpler approach the diff is working around? Is the scope right for the issue, neither half a feature that can't be verified nor several issues' worth in one PR?

## Output

Write a "방향성" section with 2–8 items, as a table or short list: 지금 (now) / 부딪히는 곳 (where it collides, with the issue/doc/schema cited) / 제안 (proposal). End with one line saying which items are cheapest to settle now, and which need a decision from the author rather than a code change.

Direction items don't block merge on their own. The exception is an item that would force a rewrite within the next one or two issues on the board; then say so in the merge verdict.
