# DB 검사

`supabase/migrations/`를 Docker 없이 PGlite(WASM Postgres)에 순서대로 적용하고 RLS · 권한 · 함수 동작을 확인함. PR과 main에서 `DB 검사` 워크플로가 같은 검사를 돌림.

```bash
cd supabase/tests
npm ci && npm test
```

- 항목마다 `PASS` / `FAIL`을 찍고, 하나라도 `FAIL`이면 종료 코드 1
- 마이그레이션을 바꾸면 `db-check.mjs`의 확인 항목도 같이 고침
- Supabase는 흉내(auth 스키마 · `auth.uid()` · 역할)만 냄 → 실제 적용은 머지 뒤 `npx supabase db push`로 확인
