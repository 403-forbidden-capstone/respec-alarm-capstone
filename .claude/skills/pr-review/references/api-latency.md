# External API latency

Only runs when the diff actually introduces or changes a call to an external host — an unrelated PR shouldn't pay for this check.

## Detect what changed

```bash
git diff <base>...<head> -- '*.js' '*.jsx' '*.ts' '*.tsx' | grep -E '^\+.*\b(fetch|axios|http\.get|http\.post)\('
```

Pull out the URL or base-URL constant each new/changed call hits. Internal/relative URLs (`fetch('/api/...')`) aren't "external" for this purpose — skip those, they're the app's own backend and their latency is a backend concern, not a dependency-latency concern. Only time calls to a genuinely external host (a third-party API, a different domain).

If nothing external changed, skip this section entirely — don't time endpoints the PR didn't touch just because they exist somewhere in the codebase.

## Time it

Prefer a real timed request over guessing from documentation — actual latency varies a lot by region/provider/time of day:

```bash
curl -o /dev/null -s -w 'time_total: %{time_total}s\nhttp_code: %{http_code}\n' '<url>'
```

If the endpoint needs auth (API key, token), check whether one is already available in the target repo's `.env`/config for local testing — if not, don't ask the user to paste a key into a shell command; just note "needs authenticated request, couldn't time directly, flagging for manual check" rather than fabricating a number.

Run it 2-3 times, not once — a single sample can be a fluke (cold cache, one bad hop). Report the range, not a single misleadingly-precise number.

## What's worth flagging

- A call added in a hot path (render body, a loop, an effect with no debounce) that takes >300ms — that's a user-visible stall, not just "slow API."
- No timeout/abort handling on a call to a third-party host — third-party APIs fail and hang in ways your own backend doesn't; an unbounded fetch can hang the UI.
- A new external call added inside a component that renders frequently, with no caching/memoization of the result.

## Report format

```
### External API latency
- `POST https://api.thirdparty.com/v1/route` — 3 samples: 210ms, 340ms, 265ms — called inside `useEffect` on every `origin` change with no debounce; consider debouncing if `origin` updates rapidly (e.g. drag-to-reposition)
- `GET https://api.other.com/status` — skipped, requires an API key not present in this checkout; recommend manual verification
```
