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
- 배치 키 (아래 "배치") — Vault에 비밀값 두 개를 SQL 편집기에서 한 번 만듦

## 배치 (pg_cron → pg_net → 서버 함수)

`20261015000200_batch_notify.sql`이 `wake-check`를 5분마다 부르게 예약함 (pg_cron이 `private.invoke_edge_function`을 돌리고, 그 함수가 pg_net으로 `<project_url>/functions/v1/wake-check`에 POST함).

- 주소와 키는 코드에 안 넣고 Supabase Vault에서 읽음. 비밀값 이름 두 개는 정해져 있음
  - `project_url` — 프로젝트 주소 (예: `https://gomrhctwjvttoqifxktt.supabase.co`)
  - `service_role_key` — 서버 함수를 부를 키 (`Authorization: Bearer`와 `apikey` 머리글에 같이 실음). 서버 함수 게이트웨이의 JWT 검증을 통과하도록 legacy service_role 키(JWT, `eyJ…`)를 넣음. 새 `sb_secret_…` 키를 쓰려면 함수 쪽에서 JWT 검증을 끄고 직접 비교해야 함
- 관리자가 SQL 편집기에서 한 번 만듦 (바꿀 때는 `vault.update_secret`)

```sql
select vault.create_secret('https://<프로젝트 ref>.supabase.co', 'project_url');
select vault.create_secret('<service_role 키>', 'service_role_key');
```

- 둘 중 하나라도 없으면 오류 없이 경고만 남기고 끝남 → 키를 넣기 전에도 배치가 5분마다 돌지만 아무 일도 안 함
- 예약 확인: `select * from cron.job;` · 실행 기록 `select * from cron.job_run_details order by start_time desc limit 10;`
- 서버 함수가 `service_role` 키를 어떻게 검사하는지(JWT 검증 끄기 등)는 함수 쪽 설정임

## 서버 함수가 쓰는 DB 함수 (service_role 전용)

앱(authenticated · anon)은 못 부름. 서버 함수가 `supabase.rpc(...)`로 부름.

| 함수 | 쓰는 곳 | 하는 일 |
|---|---|---|
| `can_send_push(sender, target, kind)` | `notify` | 푸시를 보내도 되는지. `ALARM_CHANGED`(G04)는 보내는 사람이 받는 사람 알람의 설정 권한을 가졌을 때만 true, `WAKE_PING`(G03 깨우기)은 D19 결정 뒤까지 false |
| `find_missed_wake_alarms(p_now, p_lookback_hours)` | `wake-check` | 기상 미확인(MISSED)으로 기록할 알람 목록 (7장 7.9.2: 알람 시각 + 다시 울림 총 소요 + 미루기 누적 + 30분, 총 소요는 첫 울림 시작부터 마지막 울림 끝까지로 약 11 · 보통 19 · 강 21분 — 알람 코어와 같은 끝난 뒤 간격 기준). 돌려주는 `event_key`를 `alarm_events.client_event_id`로 넣고 `on conflict do nothing`하면 같은 알람이 두 번 기록되지 않음 |

앱(authenticated)이 부르는 DB 함수 추가분:

- `get_shared_alarm_appointments(p_owner_id)` (G04) — 조회 권한(친구 ∪ 그룹)을 받은 사람 알람의 약속 제목 · 장소 · 시각. 본인 알람과 약속 없는 알람(일정 없는 알람 · 루틴)은 안 나옴
- `get_group_wake_status`는 그 그룹에 그날 약속이 있을 때만 행을 줌 (D57)

## 그룹 기상 신호 (Realtime)

`alarm_events`는 본인만 읽을 수 있어서 남의 기상 기록은 Realtime으로 직접 못 받음 → 기상 기록이 들어오면 DB가 그룹 채널에 "새로 고침" 신호만 보내고, 받은 앱이 `get_group_wake_status`를 다시 부름 (권한은 그 함수가 봄).

- 채널 `group:<group_id>:wake` (비공개 채널), 이벤트 `refresh`, 내용 `{"date": "2026-10-15"}` — 누구의 기록인지는 안 담음. 실제 Realtime은 payload에 `id`(uuid)를 덧붙이므로 앱은 payload 전체를 비교하지 말고 `date`만 읽음
- 보내는 때: 기상 알람의 울림 · 미루기 · 해제 · 미확인, 기상 확인. 기록한 사람이 참여 중(JOINED)이고 **그 그룹에서 기상 공유에 동의(`wake_share_opt_in`)했고** 그날 약속이 있는 그룹에만 감 (동의 조건은 D19 결정 전 보수 기본값 — 정해지면 트리거 함수의 한 줄만 고침. 친구 권한으로만 보는 사람은 실시간 새로 고침을 못 받고 직접 조회하면 보임)
- 받는 쪽: `supabase.channel('group:<id>:wake', { config: { private: true } })` — 그 그룹에 참여 중인 사람만 받을 수 있음 (`realtime.messages` 정책). 앱에서 이 채널로 보내는 것은 막혀 있음
- `realtime` 스키마가 없는 DB(PGlite 같은 검사용 DB)에서는 트리거 · 정책을 건너뜀 → 검사는 흉내(`tests/db-check.mjs`)로 확인
- 적용 뒤 확인: `select polname from pg_policy where polrelid = 'realtime.messages'::regclass;`에 `wake_signal_receive`가 있어야 함. 마이그레이션이 "권한이 없음" 경고를 남겼다면 아래를 SQL 편집기에서 직접 실행

```sql
create policy wake_signal_receive on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and case
          when realtime.topic() ~ '^group:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:wake$'
            then private.is_group_member(split_part(realtime.topic(), ':', 2)::uuid)
          else false
        end
  );
```
