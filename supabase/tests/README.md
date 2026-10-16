# DB 검사

`supabase/migrations/`를 Docker 없이 PGlite(WASM Postgres)에 순서대로 적용하고 RLS · 권한 · 함수 동작을 확인함. PR과 main에서 `DB 검사 · 적용` 워크플로가 같은 검사를 돌림.

```bash
cd supabase/tests
npm ci && npm test
```

- 항목마다 `PASS` / `FAIL`을 찍고, 하나라도 `FAIL`이면 종료 코드 1
- 마이그레이션을 바꾸면 `db-check.mjs`의 확인 항목도 같이 고침
- Supabase는 흉내(auth 스키마 · `auth.uid()` · 역할, 그리고 마이그레이션이 부르는 `realtime.send` · `realtime.messages` · `cron.schedule` · `vault.decrypted_secrets` · `net.http_post`의 이름 · 인자)만 냄. 실제 Realtime · pg_cron · pg_net은 없어서 불러 간 기록만 읽음 → 실제 Supabase 이미지 적용은 같은 워크플로의 `실제 이미지 적용 · 타입`이 확인하고, 실제 DB에는 머지 뒤 Actions가 넣음 (`supabase/README.md`)
