# DB 검사

`supabase/migrations/`를 Docker 없이 PGlite(WASM Postgres)에 순서대로 적용하고 RLS · 권한 · 함수 동작을 확인함. PR과 main에서 `DB 검사 · 적용` 워크플로가 같은 검사를 돌림.

```bash
cd supabase/tests
npm ci && npm test
```

- 항목마다 `PASS` / `FAIL`을 찍고, 하나라도 `FAIL`이면 종료 코드 1
- 마이그레이션을 바꾸면 `db-check.mjs`의 확인 항목도 같이 고침
- 친구 기능 검사는 장마다 `friend/chNN.mjs`(친구 시험케이스 번호를 항목 이름 앞에 씀). `db-check.mjs` 맨 끝 목록에 장 이름을 더하면 같은 실행에서 돎
- Supabase는 흉내(auth 스키마 · `auth.uid()` · 역할, 그리고 마이그레이션이 부르는 `realtime.send` · `realtime.messages` · `cron.schedule` · `vault.decrypted_secrets` · `net.http_post`의 이름 · 인자)만 냄. 실제 Realtime · pg_cron · pg_net은 없어서 불러 간 기록만 읽음 → 실제 Supabase 이미지 적용은 같은 워크플로의 `실제 이미지 적용 · 타입`이 확인하고, 실제 DB에는 머지 뒤 Actions가 넣음 (`supabase/README.md`)

## 알람 조정 제안 흐름 (e2e-suggest.mjs)

DB 검사와 같은 PGlite(마이그레이션 전부)에 실제 서버 코드(`_shared/suggest-run.ts` · `suggest-apply.ts` · `calc/chain.ts` · `plan-core.ts`)를 붙여, 가상 사용자의 "매일 9시 수업" 열흘을 돌림 — 아침 기록(준비 시작 · 출발) → 18:00 제안 → 적용 → 다시 계산 · 반복 새 회차 → 되돌리기 · 고쳐 적용 · 무시 → 실측이 쌓이면 다시 제안 → 남의 제안은 적용 못 함.

```bash
cd supabase/tests
npm ci && npm run e2e:suggest
```

- 읽기는 사용자 권한(RLS), 쓰기는 service_role — 실제 서버 함수와 같은 길. 서버 코드가 쓰는 만큼만 흉내 낸 작은 클라이언트로 붙임
- 단계마다 `PASS` / `FAIL`, 하나라도 `FAIL`이면 종료 코드 1. CI의 DB 검사 다음 단계로 돎
- 앞부분(Supabase 흉내 · 마이그레이션 적용)은 `db-check.mjs`와 같음 — 그쪽 흉내를 바꾸면 같이 고침
- 실서버 배포 · 18:00 예약이 실제로 도는지 · 폰 알람 울림은 여기서 못 봄

