# Sync → async migration check

Added after a real miss: a PR that converted a module-level constant (`TAGGED_ATTRACTIONS`, always available) into an async hook (`useAttractions()`, starts empty and fills in later) shipped with a downstream gate (`tourDone = !!tourResult`) that still assumed the old "always available" behavior. `getTourRecommendation` returns a truthy object even when the attraction list is empty — so the gate flipped true the instant the *survey* was complete, not when the *data* had actually arrived. A one-time state (`customStops === null` → set once) got permanently written with zero attractions whenever bakeries (a separate, differently-timed async source) happened to resolve first. Every individual line of that diff looked like a safe, mechanical substitution — the bug only exists in the interaction between the new async timing and old code elsewhere that the diff never touched.

This is a distinct failure mode from what `code-review`'s line-by-line/cross-file angles catch. Nothing was deleted (not a removed-behavior bug), no function signature changed (not a caller/callee break) — the *meaning of "ready"* silently changed, and a gate that used to be trustworthy the instant a condition looked true no longer was, because that condition can now be true before the data behind it exists. Treat this as its own pass, not something the correctness angles will surface for free.

## When to run this

Triggered whenever the diff converts a data source from synchronous (module-level constant, direct import, a value guaranteed present at mount) to asynchronous (a hook with `loading`/`data`, a fetch, anything that starts empty/null and fills in later) — or adds a new async source alongside existing ones. This is common in exactly the kind of PR this skill sees a lot of: "static file → live API" migrations, "prop → hook" refactors, adding a second data-fetching hook next to an existing one.

## How to check it

1. **Find every place the diff replaces a sync value with an async one.** Grep-level: an import of a JSON/constant/config replaced by a hook call.
2. **For each replacement, find every derived boolean/gate in the same file (and files that consume its output) that used to treat the old value as unconditionally present.** Look specifically for:
   - A `!!x` or truthiness check on something built *from* the async value, where the function producing it (`getTourRecommendation`-style) returns a non-null shape even for empty input — truthy-but-empty is not the same as truthy-but-ready. Read the producing function; don't assume null-on-empty.
   - A "set once and never again" pattern (`if (state === null) setState(...)`, a ref-guarded one-time effect) that reads the async value. If it can fire before the async value has resolved, whatever it captures is what ships permanently until something else re-triggers it — and usually nothing does.
   - A gate that already accounts for *one* async source (`!bakeriesLoading`) but not a newly-added second one (`!attractionsLoading`) in the same condition — the PR added a second clock without updating the gate that already knew how to wait for the first one. This is the single highest-signal pattern: grep the diff for an existing `*Loading` check sitting right next to a newly-async value that isn't in that check.
3. **Trace what happens on the "data never arrives" path**, not just "data arrives late": if the fetch fails entirely (not just slow), does the same gate fire on the empty/error result and freeze bad state permanently, the same way the slow-arrival case does? A permanent-freeze bug is usually reachable through both timing *and* failure.
4. **Every screen/component that consumes the newly-async hook is a separate instance of this check**, not one bug — a PR that converts one shared source and updates five call sites needs this same trace repeated at each site, because each one may destructure `loading` differently (or not at all) and gate on it differently (or not at all).

## Severity framing for the report

- **A permanent-freeze pattern** (state set once from a race, no path back to correct it) is the highest-severity finding in this category — it's silent, ships broken data indistinguishable from a legitimate result, and nothing in normal usage self-heals it. Rank above ordinary correctness bugs when it affects a core flow.
- **A transient flash** (wrong/empty message shown for the loading window, then self-corrects once data arrives) is real but lower severity — annoying and worth fixing, but not silently-wrong-forever.
- Don't flag a sync→async conversion just for existing — only flag where you can name the specific gate/state that doesn't account for the new timing. A hook that's consumed with a proper `loading` check throughout is not a finding.
