# Self-check

The review and this check run on the same model, so this check is not a second opinion. A blind spot in the review stays a blind spot here. What this check can catch reliably is *mechanical* gaps: files never opened, angles that never triggered because no table row matched, PR claims never compared with the code, commits that arrived after the last review. Run it after drafting the findings and before posting anything.

## How to check it

1. **File coverage.** List every changed file. If any file other than a lockfile or binary was not read in full (only its diff hunk), read it now.
2. **Angle coverage.** List the gating-table angles (Step 1, Step 4) that didn't trigger. Check whether the diff contains a language or platform that no row covers: Kotlin/Java/Swift, SQL, CI workflow YAML, shell. If it does, name which reference covered it. If none did, run a pass now with the closest reference: `android-native-check.md` for Android native code, `backend-data-layer-check.md` for SQL and migrations, `security-check.md` for workflows that handle secrets or tokens.
3. **Claims vs code.** For each behavioral claim in the PR body (verification steps, "when X, Y happens", "falls back to", "restores"), find the code that makes it true. Mark each claim verified, or not verifiable here (device, runtime, external service). A claim the code contradicts is a finding.
4. **Unreviewed commits.** If the PR already has review comments, list the commits pushed after the latest one and review those diffs as new code (Step 0's rule for fix commits). A fix commit that nobody has reviewed is unreviewed code.
5. **Previous findings.** If earlier review comments exist, give each earlier finding a status: 반영 (fixed, with commit), 남음 (still open), 의도 (intended, explained), or 후속 (follow-up, with where).
6. **Silent drops.** Look for anything you noticed during the review that isn't in the draft. Add it, even as a one-line minor item (Step 6's rule).

Fold anything the self-check finds into the main findings list, at its real severity, tagged "(자가 검수에서 추가)". The tag shows the user what this step was worth.

## Output

Add a short "자가 검수" section to the report:

- 다시 본 것: files re-read, angles added, claims checked against code
- 추가로 찾은 것: count of findings this step added, or "없음"
- 확인 못 한 것: what this environment cannot verify (real device, OS versions, runtime behavior, external services), stated as facts, not apologies
- Gaps in the skill itself: if a whole category of the diff had no matching reference, say so in one line, so the skill can be extended
