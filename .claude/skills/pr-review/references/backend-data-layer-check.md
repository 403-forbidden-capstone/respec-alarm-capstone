# Backend & data-layer check

This skill's earlier checks all came from real misses on a frontend-only PR, so they skew toward React/browser bugs. Backend correctness is a distinct discipline with its own well-known failure modes — this file exists so a PR touching a server, database, or API contract gets the same depth of scrutiny, grounded in what actually breaks production (Google's own review-guideline research: code review is the single most effective defect-finding method there is, but only for what the reviewer actually knows to look for).

## When to run this

Triggered whenever the diff touches: a database migration or schema file; an ORM query, raw SQL, or query-builder call; a route/controller/resolver that's part of a public or internal API contract (request/response shape); anything that runs on a retry or at-least-once delivery path (webhooks, queue consumers, background jobs).

## How to check it

### Database migrations
- **Destructive operations**: `DROP TABLE`/`DROP COLUMN`, a type change that loses precision or truncates data, a `NOT NULL` added without a default for existing rows. Each needs either a clear justification (dev-only table, feature never shipped) or a safer multi-step alternative (add nullable → backfill → make required in a later migration).
- **Forward-only, backward-compatible during rollout**: during a rolling deploy, old application code runs against the new schema for some window. Does the migration break that? (Renaming a column the old code still reads/writes is the classic version of this.)
- **Idempotency**: can the migration run twice without erroring or double-applying (relevant for CI retries, manual re-runs)?
- **Lock/downtime risk**: does it take an exclusive lock on a large/hot table (e.g., adding an index without `CONCURRENTLY` on Postgres, or an `ALTER TABLE` that rewrites the table on MySQL)? This matters far more on a table with real traffic than an empty dev table — check row-count/traffic context if available, don't assume it's fine because it's fine locally.

### Query patterns
- **N+1 queries**: a loop that issues one query per iteration where a single eager-loaded/joined query would do. Look specifically at any new loop over a collection that then calls into a data-fetching function per item.
- **New query patterns without a supporting index**: a new `WHERE`/`ORDER BY`/`JOIN` column that isn't indexed, especially on a table already known to be large.
- **Unbounded list endpoints**: a new list/search endpoint or query with no `LIMIT`/pagination — fine on a table with 12 rows in dev, not fine once it has 200k.

### API contracts
- **Breaking changes to an existing endpoint's request or response shape**: a removed field, a renamed field, a type change (string→number, nullable→required), a changed status code for an existing case. Check every existing consumer (other services, the frontend code in the same repo, or documented external consumers) for whether it depends on the old shape.
- **Missing deprecation path**: if a field/endpoint is being removed, is there a prior release that marked it deprecated, or is this a hard break in one step?
- **New required fields on an existing request**: breaks every existing caller that doesn't send it — check whether it has a default or is genuinely additive.

### Idempotency & retry safety
- Any handler on a path that can be retried or delivered more than once (webhooks, queue/job consumers, anything behind an at-least-once queue) — does processing the same event/message twice produce a wrong result (double-charging, double-inserting, double-sending a notification), or is there an idempotency key / dedupe check?
- A background job or scheduled task that isn't safe to run concurrently with itself (no lock/lease) if the scheduler could ever double-fire it.

## Severity framing for the report

- A destructive/lossy migration or a breaking API change with no deprecation path is high severity even if it "works" in the PR's own test environment — the cost shows up in production during rollout or in a consumer the PR's author doesn't control, not in the PR's own tests.
- N+1 queries and missing indexes are medium-to-high depending on whether the table/collection involved is realistically going to grow — say which, since "fine forever because this table has 5 rows by design" and "fine today, a production incident in 6 months" look identical in a diff.
- Idempotency gaps on retryable paths are high severity specifically because they're invisible in normal testing (a test suite rarely fires the same webhook twice) and only surface under real infrastructure retry behavior.
