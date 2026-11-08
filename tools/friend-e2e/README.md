# friend-e2e — 친구 대본 자동 시험

로컬 Supabase(127.0.0.1)에 계정 A(`demo-me`) · B(`demo-suyeon`) · C(`demo-jihyeong`)가 supabase-js로 로그인해, 논리설계 16장 대본 37단계를 끝까지 돌리고 단계마다 **PASS / FAIL / SKIP**을 찍습니다. 앱 · 서버 코드는 건드리지 않고 DB에 일어나는 일만 봅니다. 단계표는 [SCRIPT.md](SCRIPT.md).

| 결과 | 뜻 |
|---|---|
| PASS | 그 단계의 DB 쪽 확인이 끝까지 맞음. 확인을 못 한 부분(푸시 도착 등)은 `생략`으로 따로 적음 |
| FAIL | 있는 기능이 대본대로 안 됨 |
| SKIP | 아직 없는 기능(표 · 칼럼 · 함수가 DB에 없음)이거나 앞 단계가 PASS가 아님. 이유가 같이 찍힘 |

## 실행

```
cd tools/friend-e2e
npm ci
E2E_SEED_ENV=<supabase/seed/.env 경로> node run.mjs [--report <경로>]
node run.mjs --restore        # 중간에 죽었을 때 A · B · C의 친구 · 권한 되돌리기
npm test                      # 실행기 단위 시험(네트워크 없음)
```

- 필요한 것: 로컬 스택(`npx supabase start`) + 데모 4명이 들어간 상태(`supabase/seed`의 `npm run seed:demo -- --yes`). 비밀번호 · 키는 시드 `.env`에서 읽고 출력하지 않음
- `127.0.0.1` / `localhost`가 아니면 바로 멈춤. `supabase db reset`은 하지 않음
- 끝에 `개발현황 줄`이 나옴 → `친구_개발현황.md` 시나리오 표에 붙임. 보고서 md는 `runs/`(깃 제외)

## 시드를 건드리는 방법

시드의 A · B · C는 이미 친구 · 같은 그룹이라 대본의 시작("아직 친구 아님")과 다릅니다. 그래서 시작 때 A · B · C끼리의 친구 행과 권한 행을 임시 폴더(`friend-e2e-snapshot.json`)에 저장하고 비운 뒤, 끝나면(오류 · Ctrl+C 포함) 같은 id로 되돌립니다. 대본이 만든 그룹 · 약속은 이름이 `E2E `로 시작해 다음 실행 때 지워지고, 시드 그룹(캡스톤팀) · 다른 사람 행은 그대로입니다. 실행하는 몇 초 동안 웹에서 A · B · C의 친구 목록이 비어 보일 수 있습니다.

## 파일

| 파일 | 하는 일 |
|---|---|
| `run.mjs` | 로그인 → 저장 · 비움 → 37단계 → 되돌림 → 요약 · 보고서 |
| `steps.mjs` | 37단계 본문 (그 단계가 DB에 일으키는 일을 supabase-js로 함) |
| `rpc-map.mjs` | 대본이 부르는 DB 함수 이름 스위치판 |
| `caps.mjs` | 지금 DB에 있는 표 · 칼럼 · 함수 읽기 (PostgREST 루트) |
| `snapshot.mjs` | 친구 · 권한 저장 · 비움 · 되돌림 |
| `harness.mjs` | PASS / FAIL / SKIP 판정 · 요약 · 보고서 (시험 있음) |

## 장 PR이 머지된 뒤 하는 일

1. S1이 새 DB 함수를 만들면 `rpc-map.mjs`의 `null`을 그 이름으로 채움 (이름은 `친구_세션약속.md` 1절). 이름이 DB에 생기면 그 단계는 SKIP에서 벗어남
2. 함수 입력 모양이 `steps.mjs`의 가정과 다르면(`PGRST202`) 그 단계가 SKIP으로 떨어지며 "입력 모양이 가정과 달라"라고 알려 줌 → 그 단계 본문을 맞춤
3. DB를 새 마이그레이션으로 올린 뒤(S1이 `db reset`) `node run.mjs`를 다시 돌려 결과를 현황판에 적음
