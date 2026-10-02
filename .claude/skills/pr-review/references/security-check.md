# Lean security pass

Replaces invoking the full `security-review` skill by default — that skill's
fixed exclusion-list/methodology text is long and mostly irrelevant to a diff
with no security-relevant surface (a typical UI-only PR). Use this instead,
and only escalate to the real skill when it's warranted (see bottom).

## Gate first, dig only where triggered

Grep the diff for each category below. If a category has no hits, say so in
the report ("no new X surface — skipped") and move on — don't manufacture a
finding to justify having looked.

- **Injection / unsafe sinks**: new `dangerouslySetInnerHTML`, `innerHTML =`,
  `eval(`, `new Function(`, `document.write`, a new SQL/ORM/query-builder
  call built from a variable, a new subprocess/shell call, new file-path
  construction from external input.
- **Auth/session**: new auth check, new token/session/cookie handling, new
  OAuth flow, a changed permission/authorization condition.
- **Secrets**: a new string literal that looks like a key/token/password
  (long random-looking constant, `sk-`/`AKIA`-style prefixes) instead of an
  env var reference.
- **Data exposure**: new logging of a value that could carry PII or a
  secret; a new API response that returns more fields than the caller needs.

## Bar for reporting

Only report a category that actually triggered and where you're reasonably
confident (roughly: you can name the exact input and the exact resulting
exposure) it's exploitable. Skip: DoS/resource-exhaustion, secrets already
on disk and handled elsewhere, rate limiting, outdated-dependency CVEs,
client-side-only auth checks (the backend is the trust boundary — see
below), style/hardening-without-a-concrete-exploit.

**React/Angular note**: these frameworks escape interpolated content by
default. Don't flag plain JSX interpolation as XSS — only
`dangerouslySetInnerHTML`/`innerHTML`/equivalent unsafe sinks count.

**Client-side trust note**: a missing permission check in client-side JS/TS
is not a vulnerability by itself — the backend is responsible for
authorization; only flag it if the diff shows the backend trusting the
client-side check instead of re-verifying.

## Escalate to the real `security-review` skill instead of this file when...

The diff touches genuinely security-sensitive surface: new/changed auth or
session logic, payments, an authorization boundary, a backend/API route, or
new handling of external/untrusted input that reaches a backend. That's
where the heavier, false-positive-filtered protocol earns its cost — don't
use this lean pass as the final word there.
