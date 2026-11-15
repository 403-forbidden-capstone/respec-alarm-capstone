# suggest-e2e — 알람 조정 제안 실전 시험

알람 조정 제안(준비 알람 당김, 안건 D111)의 전체 흐름을 **진짜 서버 환경**으로 확인합니다. CI의 `supabase/tests/e2e-suggest.mjs`(PGlite)가 못 보는 서버 함수 실행 환경(Deno) · API 권한(RLS) · 로그인 토큰 검사까지 봅니다.

| 파일 | 어디서 | 하는 일 |
|---|---|---|
| `run.mjs` | 로컬 Supabase(127.0.0.1)만 | 데모 준성으로 로그인 → 시험 일정 "E2E 제안 수업"(지난 3일 + 내일) · 아침 기록 → `suggestion-generate`(서비스 키) → `suggestion-apply` 적용 · 되돌리기 · 무시(사용자 토큰) → 토큰 없이는 거절 → **시험 데이터 지움** |
| `deploy-check.mjs` | 실서버 (읽기만) | 두 서버 함수가 올라가 있는지만 — 키 없이 불러 거절(401 · 403)이면 있음, 404면 없음. 데이터 · 키 안 씀 |

## 로컬 실전 시험 (`run.mjs`)

준비물은 친구 e2e(`tools/friend-e2e`)와 같음: Docker, `npx supabase start`(서버 함수 포함), 데모 계정 시드.

```
npx supabase start
cd supabase/seed && npm ci && npm run seed:demo -- --yes && cd ../..
cd tools/suggest-e2e
npm ci
E2E_SEED_ENV=<supabase/seed/.env 경로> node run.mjs
```

- 단계마다 `PASS` / `FAIL`, 하나라도 `FAIL`이면 종료 코드 1. 비밀번호 · 키는 출력하지 않음
- 127.0.0.1이 아니면 바로 멈춤 (`../friend-e2e/env.mjs`). 시험 일정은 데모 준성의 "E2E 제안 수업"만 만들고 끝나면(실패해도) 지움 — 친구 e2e 계정(A · B · C)과 안 겹침
- 서버 함수가 안 떠 있으면 ①에서 HTTP 404 — `npx supabase functions serve`를 따로 띄워 봄

## 실서버 배포 확인 (`deploy-check.mjs`)

```
node tools/suggest-e2e/deploy-check.mjs
```

레포 맨 위에서. 주소는 `SUPABASE_URL` → `mobile/.env`의 `EXPO_PUBLIC_SUPABASE_URL` → `mobile/.env.production` 순서로 읽음. DB 마이그레이션 적용 · 18:00 예약이 실제로 도는지는 이 확인으로 못 봄 (Supabase 대시보드 · 지형님 확인).
