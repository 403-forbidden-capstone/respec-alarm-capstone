# Supabase

DB 구조는 `migrations/`의 SQL 파일로만 바꾸고, 실제 프로젝트에는 Actions(`DB 검사 · 적용`)가 넣음. 터미널에서 `db push` 안 함.

## DB 바꾸는 법

1. `npx supabase migration new 이름` → 생긴 `migrations/<시각>_이름.sql`에 SQL 작성
2. 로컬 확인: `cd supabase/tests && npm ci && npm test` (Docker 없이 PGlite)
3. PR → Actions가 임시 DB에 먼저 적용해 봄
   - 마이그레이션 · RLS 검사: PGlite에 적용 → RLS · 권한 · 함수 동작 (`tests/db-check.mjs`)
   - 실제 이미지 적용 · 타입: 실제 Supabase Postgres에 처음부터 적용 → 앱 타입이 스키마와 같은지
4. 머지 → 같은 검사 뒤 실제 프로젝트에 `supabase db push`

## 규칙

- main에 들어간 마이그레이션은 고치지 않음 (실제 DB엔 다시 안 들어감) → 바꿀 내용은 새 파일
- 새 파일 이름(시각)은 기존 파일보다 뒤
- 머지 직전에 main을 반영하고(`git merge origin/main`) 검사를 다시 돌림. DB PR 두 개가 같이 열려 있으면 순서 검사가 각자 통과해 버리므로, 나중에 머지하는 쪽이 꼭 다시 돌림
- 적용이 "마지막 원격 마이그레이션보다 앞선 파일"로 막히면: 파일 이름의 시각을 지금으로 바꿔 새 PR로 올리거나, 관리자가 `npx supabase@2.119.0 migration repair --status applied <시각>`으로 기록을 맞춤
- 스키마를 바꾸면 `mobile/src/types/database.ts`도 같이 바꿈. 타입 확인이 실패하면 그 실행의 `database-types` 파일로 덮어씀 (Docker가 있으면 `npx supabase db start` 뒤 `npx supabase@2.119.0 gen types --lang typescript --local --schema public > mobile/src/types/database.ts`)

## 처음 한 번 (관리자)

- supabase.com → Account → Access Tokens에서 토큰 만들기 → GitHub 레포 → Settings → Secrets and variables → Actions → `SUPABASE_ACCESS_TOKEN`
- DB 비밀번호는 안 넣어도 됨 (CLI가 토큰으로 임시 로그인 역할을 만듦)
- 적용이 실패하면 Actions → `DB 검사 · 적용` → 그 실행 → Re-run. 아무 변경 없이 다시 넣으려면 Run workflow(main)
