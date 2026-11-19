#!/usr/bin/env bash
# Run from the repository root. No DB or server writes; offline unit tests.
set -euo pipefail
if [ ! -f mobile/package.json ] || [ ! -d supabase/functions/_shared ]; then
  echo "Run this from respec-alarm-capstone repository root" >&2
  exit 2
fi
node -e 'if(+process.versions.node.split(".")[0]<22){console.error("Node 22+ required for --experimental-strip-types; use Node 24 (CI default)");process.exit(2)}'
echo "== 1: pure-prep calculator / basis / plan / request tests =="
node --experimental-strip-types --test \
  supabase/functions/_shared/calc/pure-prep.test.ts \
  supabase/functions/_shared/calc/pure-prep-basis.test.ts \
  supabase/functions/_shared/plan-core.test.ts \
  supabase/functions/_shared/requests.test.ts
echo "== 2: mobile typecheck / Jest / lint =="
(
  cd mobile
  npm ci
  npm run typecheck
  npm test -- --runInBand src/features/alarm/__tests__/request.test.ts src/features/profile/__tests__/edit.test.ts src/features/profile/__tests__/api.test.ts
  npm run lint
)
echo "== 3: DB migrations and RLS tests (does not push to Supabase) =="
(
  cd supabase/tests
  npm ci
  npm test
)
echo "== PASS. Remote DB migration / device E2E / model integration NOT included. =="
