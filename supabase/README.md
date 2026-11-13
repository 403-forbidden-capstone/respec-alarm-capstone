# Supabase

DB 구조는 `migrations/`의 SQL 파일로만 바꾸고, 실제 프로젝트에는 Actions(`DB 검사 · 적용`)가 넣음. 터미널에서 `db push` 안 함.
서버 함수(`functions/`)는 Actions를 안 쓰고 터미널에서 배포함 ("서버 함수" 절). 데모 시드는 `seed/` ("데모 시드" 절).

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
- `20261029075743_alarm_roll.sql`(반복 다음 회차)이 같은 방식으로 `alarm-roll`도 5분마다 부르게 예약함. **`alarm-roll` 함수 배포는 앱 맞추기 PR(3b) 머지 뒤** — 그 전엔 호출이 404로 끝남 (해롭지 않음)
- `20261112090000_suggest_generate.sql`(알람 조정 제안, #49 · 안건 D111)이 `suggestion-generate`를 매일 09:00 UTC(한국 18:00, 저녁 대화 전)에 부르게 예약함. 서비스 키로 오면 `_shared/suggest-run.ts`가 `prepare_suggestion_inputs`로 재료를 읽고 규칙(`calc/suggest.ts`)을 돌려 `alarm_suggestions`에 준비 알람 당김 제안(PENDING)을 넣음 — 앱은 S01 작업 전까지 이 종류를 숨김. 배포 전에는 404 (해롭지 않음)
- `20261113090000_suggest_advance_plan.sql`(알람 조정 제안 · 당김 계산): 반복 일정의 새 회차 참여 조건이 바로 앞 회차의 당김 분(`prepare_advance_minutes`)을 이어받는 트리거, 제안 재료에서 직접 고른 준비 알람 제외. 계산은 `plan-core` · `calc/chain.ts`가 당김 분만큼 준비 알람을 앞당기고 준비 전 활동을 넘는 만큼만 기상도 앞당김 — 준비 전 활동은 저장하지 않고 저장된 알람에서 되찾음(`inferBeforePrepare`, 안건 D111 · B안)
- `20261109080000_voice_auto_commit.sql`(하루 기록 자동 정리)이 `voice-commit`을 10분마다 부르게 예약함(`voice-auto-commit`). 서비스 키로 오면 `_shared/ai/auto-commit.ts`가 [완료] 없이 지난 기준일 대화를 정리 — 기준일 다음 날 KST 새벽 4시 뒤(기상 알람과 상관없음, 11/13), 마지막 사용자 말 60분 뒤, 한 번에 3개 · 60초. pg_net이 10초만 기다려서 바로 202로 답하고 정리는 `EdgeRuntime.waitUntil`로 뒤에서 — 결과는 함수 로그(`[auto-commit] 시작 · 완료 · 실패`)로 봄. `voice-commit`도 `verify_jwt = false`(alarm-roll과 같이 `isServiceCall` · `requireUser`로 가름) — **마이그레이션 적용 전에 함수를 먼저 배포**
- `wake-check`는 `config.toml`에서 `verify_jwt = false`로 두고, 코드(`_shared/auth.ts` `requireServiceCall`)가 `apikey` · `Authorization` 머리글의 키를 `SUPABASE_SERVICE_ROLE_KEY`(legacy JWT) 또는 `SUPABASE_SECRET_KEYS`(`sb_secret_…`)와 직접 비교함 → Vault에 어느 형식을 넣어도 됨

## 서버 함수가 쓰는 DB 함수 (service_role 전용)

앱(authenticated · anon)은 못 부름. 서버 함수가 `supabase.rpc(...)`로 부름.

| 함수 | 쓰는 곳 | 하는 일 |
|---|---|---|
| `can_send_push(sender, target, kind)` | `notify` | 푸시를 보내도 되는지(한 사람에게). `ALARM_CHANGED`(G04)는 보내는 사람이 받는 사람 알람의 설정 권한(조회도 함께 가진 같은 권한 행, 친구 6장)을 가졌고 받는 사람에게 방금(1시간 안) 보낸 대기 중 제안이 있을 때만 true(친구 10장 — 제안 없이 알림만 보내거나 지난 제안으로 다시 보내지 못하게), `FRIEND_REQUEST`는 보내는 사람이 받는 사람에게 방금(1시간 안) 보낸 대기 요청이 있을 때, `FRIEND_ACCEPTED`는 받는 사람이 보낸 요청을 보내는 사람이 방금(1시간 안) 수락했을 때(친구 11장), `WAKE_PING`(G03 깨우기)은 늘 false(깨우기의 권한 · 한도는 `plan_wake_ping` 한 곳이고, 새 `notify`는 깨우기에만 `can_send_push`를 안 부름 — 이 마이그레이션이 서버 함수 배포보다 먼저 적용돼도 옛 `notify`가 한도 없이 보내지 못함). 보내는 사람과 받는 사람이 차단 쌍이면(어느 쪽이 걸었든, 친구 4장) 종류와 상관없이 false |
| `plan_group_push(sender, group, kind, appointment?)` | `notify` | 그룹 알림(`GROUP_MEMBER_JOINED` · `GROUP_APPT_CHANGED`)의 받는 사람을 서버가 고름(친구 11장). 보낸 사람이 그 그룹에 참여 중이어야 하고 (새 멤버 알림은 들어온 지 10분 안, 약속 변경은 그 그룹의 아직 안 지난 약속을 만든 사람이 보낼 때만) 받는 사람 = 새 멤버 알림은 참여 중 멤버 전체, 약속 변경은 그 약속에 참여 조건이 있는 참여 중 멤버 − 보낸 사람 − 알림 끈 멤버(`notifications_off`) − 보낸 사람과 차단 쌍. `{status, group_name, appointment_title, recipients}` — 안 되는 모든 경우는 같은 `FORBIDDEN` |
| `plan_wake_ping(sender, target, reserve?, now?, group_id?)` | `notify` | 깨우기(G03)를 보낼 수 있는지 판정, 응답 jsonb `{status, group_id?, count?, limit?, next_at?, resets_at?, send_id?}`. `group_id`를 주면 그 그룹에서 보이는 사람일 때만(G03를 연 그룹), 응답 `group_id` = 판정에 쓴 그룹. `status`: `FORBIDDEN`(기상이 안 보이는 사람 · 자기 자신 · 없는 사람 — 이유 구분 없음) → `OFF`([깨우기 받기]를 끈 사람) → `ALREADY_UP`(확인이 있거나 자동 판정 확인이 20분 전이라 친구에게 안 보이는 중) → `NOT_RINGING`(그날 첫 기상 알람 시각 전 · 알람 없음) → `DAILY_LIMIT`(보내는 사람 → 받는 사람 쌍마다 하루 3번, 하루 = 받는 사람 시간대 0시, `resets_at`) → `WAIT`(5분에 한 번, `next_at`) → `OK`. 알람 시각이 지났으면 울림 기록이 없어도 OK(폰이 꺼져 기록이 못 올라와도). `reserve`가 참이면 같은 쌍을 잠그고 그 안에서 다시 판정한 뒤 `push_sends`에 한 줄 남기고 `{status:'OK', group_id, count, limit:3, next_at, send_id}` — `send_id`는 센 줄 번호로, 푸시가 한 건도 못 나가면 서버가 그 줄을 지워 횟수를 돌려놓음 |
| `claim_wake_nudges(p_now)` | `wake-check` | 미확인 친구 알림의 받는 사람을 정하면서 `push_sends`에 한 줄씩 남겨 같은 알림이 두 번 안 가게 함. 행 `(event_key, kind, recipient_id, sleeper_id, group_id)`. `NUDGE`('깨워 볼까요?'): 미확인(MISSED) 기록 10분 뒤(최근 12시간 안 기록만), 그사이 본인이 확인했으면 없음, 받는 사람 = 안 일어난 사람이 기상 공유에 동의한 그룹 중 그날 가장 이른 그룹 약속이 아직 안 시작한 그룹의 참여 중 멤버로 기상이 보이고(동의 · 숨김 · 차단 반영) 그 그룹 알림을 안 끈 사람, 여러 그룹이어도 같은 날 한 사람에게 한 번. `UP`(후속 '일어났어요'): `NUDGE`를 받은 사람에게 본인이 늦게 확인했을 때 한 번(자동 판정은 20분 뒤부터). `group_id` = 누르면 열 그룹 |
| `propose_alarm_time(alarm, new_at)` | 앱 G04 | 친구가 내 알람 시각을 바꾸자고 **제안**(친구 10장). 설정 권한(조회도 함께) 재확인, 일정에 붙은 켜진 알람만, 시각만(끄기 · 삭제 불가). 응답 jsonb `{status, proposal_id?}` — `OK` · `FORBIDDEN`(권한 없음 · 남의 알람 · 일정에 안 붙음 · 꺼짐 · 내 알람 · 이미 울린 알람) · `INVALID` · `SAME`(같은 시각) · `TOO_SOON`(알람이 지금 + 10분 안이거나 새 시각이 지금 + 5분 이전이거나, 같은 카드의 다른 안 울린 알람이 같은 만큼 움직여 지금 + 5분 이전이 됨) · `LIMIT`(원래 시각 기준 합계 ±60분 초과) · `TOO_LATE`(늦추는 제안인데 같은 카드의 안 울린 켜진 출발 알람 + 늦춘 만큼 + `est_travel_minutes`가 약속 시각을 넘음 — 이동시간 값이 없으면 출발이 약속 시각을 넘을 때만, 앞당기는 제안은 검사 안 함, 11/9 탐색 시험 X-PROP-01). 같은 알람의 대기 중 제안은 하나(이전 것은 `REPLACED`). 같은 카드의 제안 · 적용은 카드 단위 잠금으로 차례로 처리 |
| `respond_alarm_proposal(proposal, apply)` | 앱 홈 · 알람 | 받은 사람(주인)이 제안을 [적용] / [무시]. 적용하면 그 카드(같은 참여 조건)의 아직 안 울린 알람이 같은 만큼 움직이고 `time_source = MANUAL`, `original_scheduled_at` · `original_time_source`에 처음 시각 · 그때의 time_source를 기억(원래대로 돌아오면 time_source까지 복원하고 비움). 응답 `{status}` — `APPLIED` · `DISMISSED` · `EXPIRED`(알람 시각이 지남 · 새 시각이 곧 지남 · 주인이 그사이 직접 고침 · 보낸 친구의 설정 권한이 거둬짐 · 같은 카드의 이른 알람이 과거가 됨) · `LIMIT` · `TOO_LATE`(적용하면 출발 + 이동시간이 약속 시각을 넘음 — 보낸 뒤 약속 · 이동시간이 바뀐 경우, 그 제안은 `EXPIRED`로 닫힘) · `NOT_FOUND`(남의 제안 · 이미 처리 · 없음). 적용되면 같은 카드의 다른 대기 제안은 만료 |
| `my_alarm_proposals()` | 앱 홈 · 알람 | 내가 받은 대기 중 제안 카드 `(proposal_id, alarm_id, alarm_type, proposer_id, proposer_nickname, from_at, to_at, created_at)` 최신 순. 알람 시각이 지났거나 알람이 꺼졌거나 새 시각이 지금 + 5분 안이거나 주인이 그사이 직접 고쳤거나 권한이 거둬진 것은 빠짐([적용]하면 바로 만료될 것은 안 보여 줌) |
| `sent_alarm_proposals(owner)` | 앱 G04 | 내가 그 사람에게 보낸 제안의 알람마다 가장 최근 한 줄 `(proposal_id, alarm_id, status, from_at, to_at, created_at)` — `status`는 `PENDING`(대기 중 · 주인이 무시한 것도 같은 값 — 보낸 친구에게는 '제안함' 그대로) · `APPLIED`(적용, 반영됨)만, 알람 시각이 지나면 빠짐. 설정 권한이 거둬지면 안 보임 |
| `prepare_account_delete(user)` | `account-delete` | 계정을 지우기 **전에** 하는 준비(친구 12장, 서버 전용, 몇 번 불러도 같음). ① 개인 약속(그룹 없음) 삭제 ② 영향 수를 세어 둠 ③ 푸시 토큰 삭제 ④ 모든 그룹에서 나가기(멤버 행 삭제 → 앞으로 약속의 참여 · 알람 정리, 그 사람이 만든 앞으로 공동 약속의 만든 사람 칸 비움, 마지막 참여 멤버였으면 그룹 삭제 — 초대만 받은 사람의 초대도 같이). 응답 jsonb `{groups_left, groups_deleted, personal_deleted, group_appointments_kept}`. 공동 약속은 지우지 않음 — 계정이 지워질 때 FK가 만든 사람 칸만 비움 |
| `my_account_delete_summary()` | 앱 설정 > [계정 삭제] | 확인 문구용 영향 요약 한 줄 `(groups_leaving, groups_disappearing, group_appointments_staying, friends)` — 나갈 그룹 수 · 그중 내가 마지막 참여 멤버라 사라질 그룹 수 · 내가 만들어 남을 공동 약속 수 · 친구 수. 부른 사람 본인 것만 |
| `find_missed_wake_alarms(p_now, p_lookback_hours)` | `wake-check` | 기상 미확인(MISSED)으로 기록할 알람 목록 (미확인 시각 = 마지막으로 울리기 시작한 때 + 30분 — 확인 알림에 답이 없으면 다시 울리지 않으므로 다시 울림 소요를 안 더함, 친구 7장 D2). 폰은 미루면 다시 울림 묶음을 처음부터 새로 시작하므로, 마지막 울림 시작 = 마지막 미루기 시각 + 미루기 시간(미루기가 없으면 알람 시각). 돌려주는 `snooze_minutes`는 미루기 합이라 참고용이고 `missed_at`은 이 합으로 구하지 않음. 기상 확인은 같은 사람의 `WAKE_CONFIRMED`(어느 기상 알람이든) 또는 `daily_records.wake_confirmed_at`이면 인정. 기록은 알람 시각 6시간 전 ~ 18시간 뒤만 봄. 기상 알람은 켜져 있거나, 꺼졌어도 그 구간에 울린 기록(TRIGGERED)이 있으면 셈 — 알람이 울린 뒤 알람만 꺼도 미확인 후보에 남음(`private.wake_alarm_counts`, 11/9 탐색 시험 X-WAKE-04). 돌려주는 `event_key`를 `alarm_events.client_event_id`로 넣고 `on conflict do nothing`하면 같은 알람이 두 번 기록되지 않음 |
| `roll_insert_occurrence(p_appointment, p_participant, p_alarms, p_items)` | `alarm-roll` (다음 PR) | 반복 회차 하나를 약속 · 참여 조건 · 알람 · 준비물(`todos` ITEM)까지 **한 트랜잭션**으로 씀. 같은 (만든 사람, 묶음, 날짜)가 이미 있으면 아무것도 안 쓰고 `null`(같은 요청 두 번 = 같은 결과), 새로 만들면 `appointment_id`. 넣는 칸은 `alarm-commit`(`_shared/commit.ts` persistAppointment)과 같고 (알람의 `vibration`은 `20261030200000_alarm_vibration.sql`부터 — 직접 고른 진동을 다음 회차가 이어받음) 약속에 `memo` · `dest_radius_m`만 더 이어받음. 입력은 jsonb(`series_id` · `occurrence_on` 필수) |
| `roll_due_series(p_now, p_limit)` | `alarm-roll` 배치 (다음 PR) | 회차를 넘길 후보 묶음 `(user_id, series_id, kind, template_id)`, 다음 회차가 급한 순 (정말 만들 날짜가 있는지는 `alarm-roll`이 다시 봄). `APPOINTMENT`: 묶음의 **기준 회차**(예외 아닌 회차 중 날짜가 가장 늦은 것, 없으면 이번만 고친 회차 중, 이번만 지운 회차는 기준이 아님)에 읽을 수 있는 `recurrence_rule`(두 모양)이 있고 개인 약속이며 **다음 회차** 시각이 `p_now + 14일` 앞(14일치가 차 있으면 안 줌) · 재시도 대기 아님(`roll_attempts.next_try_at`이 안 온 줄 없음) · 미뤄 둔 날짜의 재시도 때가 지났으면 창 밖이어도 포함. `STANDALONE`: 일정 없는 반복 알람(같은 기준). `ROUTINE`: 켜 둔 루틴(읽을 수 있는 요일)의 켜진 단계 알람 시각이 지난 것. 못 읽는 규칙 · 요일(예전 MONTHLY · INTERVAL 등)은 빼서 매번 앞자리를 차지하지 않게 |
| `prepare_suggestion_inputs(p_now)` | `suggestion-generate` 배치 | 앞으로 36시간 안 반복 일정의 켜진 준비 알람마다 지난 회차 잔차(실제 준비 − 계획 준비, 분, 오래된 → 최근 최대 10개) · 지금 당김 분 · 준비 전 시간 · 상한(10 / 5분). 예정 출발 ±3분 · 준비 시작 없는 날은 빼고, 대기 중 제안 · 7일 안 제안 · 무시 뒤 실측 3번 전은 후보에서 뺌 (D62 · D24 C). 서버 역할만 |

앱(authenticated)이 부르는 DB 함수 추가분:

- `get_shared_alarm_appointments(p_owner_id)` (G04) — 조회 권한(친구 ∪ 그룹)을 받은 사람 알람의 약속 제목 · 장소 · 시각. 본인 알람과 약속 없는 알람(일정 없는 알람 · 루틴)은 안 나옴. 보는 사람이 그 공동 약속의 그룹 멤버가 아니면 `title` = '그룹 일정', `dest_name` = ''(11/9 탐색 시험 X-PRIV-09)
- `get_group_wake(p_group_id, p_date?)` (G01 · G02 · G03) — 그 그룹에 그날 약속이 있을 때만(D57) 나 + 기상 공유에 동의한 참여 중 멤버의 줄을 줌. 칸은 `user_id · nickname · profile_image_url · is_me · wake_alarm_at · wake_confirmed_at · wake_status`뿐 (미루기 횟수 · 알람 끈 시각 · 울린 시각 · 미확인 시각은 안 줌). `wake_status`: `SCHEDULED` · `RINGING` · `DISMISSED` · `MISSED` · `CONFIRMED` · `NO_ALARM`(앱이 아직 · 울렸어요 · 일어남 · 알람 없음으로 묶음). 자세한 규칙은 아래 "친구 7장"
- `get_group_wake_status(p_group_id, p_date?)` — 위 함수의 옛 11칸 모양 호환판(앱이 옮길 때까지, 15장에서 지움). 내 줄만 울린 시각 · 미루기 · 해제 · 미확인 칸이 차고 다른 사람 줄은 비어 있음(미루기 0)
- `set_wake_hidden(p_user_id, p_hidden)` (G02 멤버 메뉴) → `OK` · `NOT_FOUND` — 내 기상을 그 사람에게만 숨김/보이기. 같은 그룹이거나 친구인 사람만 숨길 수 있고(보이기는 아무에게나), 숨긴 목록은 `wake_hides`에서 내 줄만 읽힘
- 친구 2장 아이디 · 찾기 (`20261108062757_friend_handle_search.sql`, 이슈 #366) — 새 함수는 jsonb `status`로 돌려주고 앱이 문구로 바꿈
  - `change_my_handle(p_handle)` — 아이디 바꾸기(`OK` · `SAME` · `INVALID` · `RESERVED` · `TAKEN` · `LIMIT`). `respec_`로 시작하는 아이디와 예약어 10개(admin · respec · support · help · official · system · root · operator · manager · null, 정확히 같을 때만)는 `RESERVED`. 30일 1번, 자동 아이디 첫 변경 · 온보딩 중 변경은 안 셈(`LIMIT` + `next_change_at`). 바꾸기 시도도 검색과 같은 1분 10회 + 하루 100회에 셈(`LIMIT` + `retry_after_seconds`). 앱이 `profiles.handle`을 직접 update하거나 채워진 `onboarded_at`을 바꾸면 42501(`onboarded_at`은 비어 있을 때 한 번 채우기만)
  - `search_by_handle(p_query)` — 아이디 정확 일치(`FOUND` · `SELF` · `NOT_FOUND` · `LIMIT`), 1분 10회 + 하루 100회(바꾸기 시도와 합쳐서). 차단 · 탈퇴 · 온보딩 전은 없는 아이디와 같은 응답. `find_profile_by_handle`은 이걸 거치는 옛 모양(앱이 옮기면 지움)
  - `search_related_by_name(p_query)` — 친구 · 같은 그룹 안 닉네임 부분 일치
  - `my_friend_link(p_renew)` · `open_friend_link(p_token)` — 친구 링크(7일, 다시 만들면 옛 링크 무효). 표 `friend_links` · 제한 기록 `rate_limit_events`는 서버 전용(정책 없음)
  - 가입하면 아이디가 `respec_` + 4자로 자동으로 생기고 빈 아이디는 채움(NOT NULL은 앱 타입이 옮긴 뒤). 닉네임은 앞뒤 공백(탭 · 줄바꿈 포함)을 떼고 1~30자, 가입 때 이름이 공백뿐이면 이메일 앞부분 · '사용자'
- 친구 3장 친구 관계 (`20261108180042_friend_relations.sql`, 이슈 #372) — 상태 값으로 돌려주고 앱이 문구로 바꿈. 푸시는 11장
  - `send_friend_request(p_target_id)`(`REQUESTED` · `ACCEPTED`(맞요청 자동 수락) · `ALREADY_REQUESTED` · `ALREADY_FRIEND` · `SELF` · `NOT_FOUND` · `LIMIT` · `FRIEND_LIMIT`) — 1분 10회 + 하루 50회(행을 만든 요청만, 취소해도 안 줄어듦), 친구 100명 상한
  - `accept_friend_request(p_requester_id)`(`ACCEPTED` · `ALREADY_FRIEND` · `GONE` · `FRIEND_LIMIT`) · `decline_friend_request(p_requester_id)`(`DECLINED` · `GONE`) · `cancel_friend_request(p_addressee_id)`(`CANCELED` · `GONE`) · `remove_friend(p_user_id)`(`REMOVED` · `GONE`) — 거절 · 취소 · 끊기는 행 삭제, 끊기는 친구 출처 권한만 지움
  - `friends` 상태는 대기 → 친구로만 바뀌고(서버 쪽 고침에서 수락 되돌리기 · 차단으로 바꾸기는 42501, 앱의 직접 update는 11/9부터 늘 0행) 수락 시각은 서버가 넣음. 같은 사람이 끼는 동작은 사람별 잠금(`private.lock_friend_pair`)으로 한 줄씩. 받은 요청은 30일 뒤 5분 배치(`friend-requests-expire`)가 지움
  - 앱이 `friends`를 직접 고치는 옛 길은 모두 닫음 — insert는 15장(#434), update · delete는 11/9 후속(`20261109070000_friend_direct_write_closed.sql`, 정책 `friends_update_addressee` · `friends_delete_party` 삭제). 요청 · 수락 · 거절 · 취소 · 끊기는 함수로만 되고, 앱이 직접 update · delete하면 오류 없이 0행. 열려 있던 동안은 친구 100명인 사람에게 온 요청을 직접 update로 수락하면 100명 상한(`FRIEND_LIMIT`)을 안 거쳐 101명이 되는 길이었음(검수가 확인). 상태 규칙 트리거(`guard_friend_status`)는 서버 쪽 고침에 대해 그대로
- 친구 4장 차단 · 신고 (`20261108181556_friend_blocks.sql`, 이슈 #375) — 상태 값으로 돌려줌
  - `block_user(p_user_id)`(`BLOCKED` · `ALREADY_BLOCKED` · `SELF` · `NOT_FOUND`) · `unblock_user(p_user_id)`(`UNBLOCKED` · `GONE`) · `my_blocks()` — 누구나 차단, 친구 끊김 + 양쪽 방향 대기 요청 삭제 + 두 사람 사이 공유 권한 삭제 + 두 사람 사이 대기 중인 그룹 초대(어느 쪽이 보냈든) 삭제, 풀어도 친구 · 권한은 복구 안 됨. 표 `user_blocks`는 차단한 사람 본인만 읽고 쓰기는 함수로만
  - 차단 판정은 `private.is_blocked_pair` 한 곳: 검색 · 이름 검색 · 친구 링크 · 친구 요청이 없는 사람과 같은 응답, 권한 판정(`is_valid_permission_source`)이 끝나서 알람 조회 · 설정 · 기상 · 푸시(`can_send_push`)도 끊김, `get_public_profiles`는 같은 그룹의 차단 쌍에게 닉네임만(사진 · 아이디 `null`), `friends` 직접 insert는 차단 여부와 상관없이 모두 같은 거절(42501, 11/9부터 직접 insert 정책이 없음)
  - `submit_report(p_target_type, p_target_id, p_reason, p_note)`(`REPORTED` · `ALREADY_REPORTED` · `INVALID` · `SELF` · `NOT_FOUND`) — 같은 대상 하루 1번(신고하는 사람 시간대). 표 `reports`는 서버 전용(운영 화면용 조회 · 처리 함수 `list_reports` · `resolve_report`와 팀원 표 `team_members`는 아래 '친구 4장 꼬리 신고 처리 · 팀원 표' 항목, 괴롭힘 신고 근거 복사 포함)
- 친구 5장 그룹 · 초대, 그룹장 없음 (`20261108183700_friend_groups.sql`, 이슈 #384) — 상태 값으로 돌려줌
  - `preview_group_by_code(p_code)`(`FOUND` · `NOT_FOUND` · `EXPIRED` · `LIMIT`) · `join_group(p_code, p_wake_share)`(`JOINED` · `ALREADY_JOINED` · `NOT_FOUND` · `EXPIRED` · `LIMIT` · `FULL` · `TOO_MANY_GROUPS`) — 코드는 공백 제거 · 대문자(O/0 보정 없음), 틀린 코드는 계정별 1시간 10번까지 기록(반환값이라 되돌려지지 않음)하고 막힌 동안은 맞는 코드도 `LIMIT`. 그룹 20명 · 한 사람 10개 상한은 그룹 잠금 → 사람 잠금으로 한 명씩 셈
  - `accept_group_invite(p_group_id, p_wake_share)`(초대한 사람과 차단한 사이면 `GONE` — 차단 전에 받은 초대도) · `invite_to_group(p_group_id, p_user_id)`(친구 사이 · 차단 아님만) · `my_group_invites()`(초대 카드: 이름 · 인원 · 초대한 사람까지만, 차단한 사이가 보낸 초대는 빠짐) · `my_group_code(p_group_id)`(시트를 열 때 만료면 새 코드 + 7일)
  - 그룹장 없음: 이름 바꾸기(`groups` update) · `regenerate_invite_code` · 초대 · 내보내기(다른 사람의 `group_members` 행 삭제)는 참여 중 멤버 누구나, 그룹 삭제 길은 없음. 마지막 참여 멤버가 나가거나 탈퇴하면 그룹 · 공동 약속 · 초대 · 코드가 지워지고(각자 `daily_records`는 남음) 나가는 사람의 그 그룹 **앞으로 약속**의 참여 · 알람이 지워짐(지난 약속의 참여 · 울림 · 도착 · 이동 시간 기록은 남음). `groups.owner_id`는 '만든 사람' 기록(탈퇴하면 비어 있음)
  - 앱이 `group_members`를 직접 고칠 수 있는 건 나가기(`JOINED → LEFT`) · 기상 공유 동의 · 알림 끄기(`notifications_off`)뿐, 초대 수락 · 다시 참여는 함수로만(그 밖은 42501). 초대만 받은 사람은 `groups` · 멤버 목록 · 공개 프로필을 못 읽음
  - 초대 코드는 8자(0 O 1 I 뺀 글자표), 만료 칸 `groups.invite_code_expires_at`(마지막 발급 + 7일, 기존 그룹은 마이그레이션 시각 + 7일). 지금 앱이 쓰는 `join_group_by_invite_code`는 옛 모양으로 남김(실패는 예외라 틀린 코드 횟수는 못 셈)
  - 읽기 예외·상한 (1번째 리뷰 반영): 방금 만든 사람이 `insert ... returning`으로 돌려받을 수 있는 예외는 만든 시각 = 그 트랜잭션 시각일 때만(`created_at`은 트리거가 `now()`로 못 박고 못 바꿈) — 내보내진 · 나간 만든 사람은 새 코드를 못 읽음. 10개 상한은 앱이 직접 그룹을 만들 때도 참여 · 수락과 같은 사람 잠금을 건 채로 셈. 참여 · 수락은 그룹 행을 키 공유로 잡아 마지막 멤버가 나가며 그룹이 지워지는 일과 겹쳐도 `GONE` · `NOT_FOUND`
  - 앱 쪽 주의: 직접 만들기 한도는 `54000` 예외로 옴 · `my_group_invites`의 `invited_by` · `invited_by_nickname` · `invited_at`은 비어 있을 수 있음(마이그레이션 전 초대 행 · 초대한 사람 탈퇴, 생성 타입은 `string`). 12장 탈퇴 연쇄를 함수로 순회하면 그룹 번호 순서로 잠글 것(같은 그룹 여러 개에 함께 속한 두 사람이 반대 순서로 지우면 교착 가능)
- 친구 6장 공유 권한 (`20261108190500_friend_permissions.sql`, 이슈 #388)
  - `save_group_permissions(p_group_id, p_can_view_alarm, p_can_edit_alarm)` → `OK`(`saved` = 참여 중인 다른 멤버 수) · `NO_MEMBERS`(혼자인 그룹) · `NOT_FOUND`(참여 중 멤버가 아님) — 그룹 권한 저장을 함수 하나(한 트랜잭션)로: 참여 중 멤버 전원(나 빼고)에게 같은 값 한 벌, 설정을 켜면 조회도 켜짐, 값이 그대로여도 update가 실행되어 수정 시각이 새로 찍힘. 차단 쌍은 오류 없이 행만 안 쓰고 응답은 같은 모양. 그룹 잠금(5장)을 건 채로 참여 중 멤버 행을 잠가(`for share`) 일하므로 나가기 · 내보내기와 겹쳐도 나간 사람 몫 행이 남거나 되살아나지 않음. 조회 끔 + 설정 켬으로 어긋나게 보내면 설정이 이겨 둘 다 켬
  - '설정이면 조회': `sharing_permissions`에 제약 `sharing_permissions_edit_needs_view`, 조회만 끄면(설정 값을 그대로 보내도) 트리거가 설정도 끔. 친구 출처 `can_view_wake`는 써 넣어도 꺼진 채 저장(F03 친구 스위치 3개 → 2개). 마이그레이션이 옛 행을 정리: 그룹 권한은 (준 사람, 그룹) 한 벌로 맞추고(멤버마다 값이 다르거나 일부 멤버 행이 없으면 모두 꺼짐), 설정만 켠 옛 행은 설정을 끔
  - 권한을 준 뒤 참여 중이 된 사람(코드 참여 · 초대 수락)에게는 이미 그 그룹에 조회를 준 멤버들의 조회 행만 자동으로 생김(설정은 준 사람이 다시 저장해야, 차단 쌍은 건너뜀)
  - `private.granted_owner_ids_for`는 이제 `VIEW_ALARM` · `EDIT_ALARM`만 — 설정은 조회를 함께 가진 같은 행만 인정(알림 판정 `can_send_push`도 이 집합을 그대로 써서 설정과 조회를 둘 다 봄). 알람 조회는 일정에 붙은 알람만(`alarms_select_shared`: 개인 일정 포함, 루틴 · 일정 없는 알람 제외) — 수정 정책은 조회 정책도 같이 통과해야 해서 따로 안 바꿈
  - 기상 보기는 권한 행 없이 그 그룹의 기상 공유 동의(`group_members.wake_share_opt_in`)로만: `get_group_wake_status`가 그룹마다 따로 판정(참여 중 멤버 · 차단 쌍 제외). `sharing_permissions.can_view_wake` 칸은 판정에 안 쓰임(칸 정리는 15장). 사람별 기상 숨기기는 7장
- 친구 7장 그룹 기상 상태 (`20261108203600_friend_wake_status.sql`, 이슈 #400)
  - 보임 판정 `private.can_see_wake(보는 사람, 주인, 그룹)` 한 곳 — 둘 다 그 그룹 참여 중 · 주인이 그 그룹에서 기상 공유에 동의 · 차단 쌍 아님 · 주인이 보는 사람에게 숨기지 않음. 8장 깨우기도 이 함수를 씀. 내 줄은 늘 나옴
  - 하루는 사람마다 프로필 시간대(`profiles.timezone`)로 셈. 그날 첫 켜진 기상 알람이 기준 알람(개인 일정 알람도 포함). 새벽 약속의 전날 밤 알람은 알람이 울린 날로 잡혀 그날이 '약속 있는 날'(그 그룹 약속이 그날에 있거나, 그 그룹 약속 참여자의 기상 알람이 그날에 울릴 때)
  - 단계 우선순위 `CONFIRMED` > `MISSED` > `DISMISSED` > `RINGING` > `SCHEDULED`, 기상 알람이 없으면 `NO_ALARM`. 기록은 그 알람 시각 6시간 전 ~ 18시간 뒤만 봄(`find_missed_wake_alarms`와 같은 구간)
  - 기상 확인: 직접 입력(`MANUAL`) · 대화 정정(`VOICE`) 출처는 그룹에 안 띄움, 자동 판정(`USAGE`)은 다른 사람에게 20분 뒤부터(내 줄은 바로, 20분을 기다리는 동안은 MISSED로 보지 않음). 저녁에 직접 입력한 `daily_records`는 안 읽음
  - 폰이 꺼졌거나 기록이 못 올라와도 (마지막 울림 시작 + 30분)이 지나면 확인이 없는 한 `MISSED`(서버 배치가 기록한 MISSED도 같음)
  - `wake_hides(owner_id, hidden_from_id)` 표 + `set_wake_hidden` — 앱은 쓰기 불가, 내 줄만 읽기. 숨김당한 쪽은 숨김 · 동의 안 함 · 차단이 같은 모습이라 알 수 없음
  - `alarm_events`의 `WAKE_CONFIRMED`는 사람마다 하루(그 사람 시간대) 첫 한 건만 저장 — 둘째부터는 오류 없이 무시되고 먼저 것(출처도)이 남음(사람 · 날짜별 잠금). 저장될 때 그날 `daily_records.wake_confirmed_at`도 같이 기록(이미 있으면 덮지 않음, `data_source = ALARM`)
  - 새로 고침 신호: 직접 입력 · 대화 정정 · 자동 판정 출처의 기록은 신호를 안 냄. 날짜 = 그 기상 알람이 울린 날(그 사람 시간대)
  - 미확인 시각 식에서 다시 울림 몫을 뺌(`find_missed_wake_alarms`의 `rering_minutes` 칸 없어짐)
- 친구 11장 푸시 바탕 (`20261108195000_friend_push.sql`, 이슈 #398)
  - `push_tickets`(서버 전용 표): Expo가 접수한 알림마다 한 줄(접수 번호 · 받는 토큰 · 종류). 15분 뒤 `wake-check`가 영수증을 확인해 지움. 탈퇴하면 같이 지워짐
  - `register_push_token`: Expo 토큰 모양(`ExponentPushToken[...]` · 옛 `ExpoPushToken[...]`, 200자 이하)과 플랫폼(`android` · `ios`, 웹은 푸시를 안 받음)을 검사(`22023`). 같은 폰의 토큰은 마지막 로그인 계정이 가짐(옛 그대로). 한 사람당 최대 10대 — 넘으면 가장 오래 전에 등록한 것부터 지움. 앱 역할의 `push_tokens` 직접 insert · update는 회수됐고(읽기 · 지우기만) 로그아웃 때는 앱이 자기 행을 지움(본인 행만 RLS). 안드로이드는 알림 채널 5개(`friend_v1` · `alarm_change_v1` · `request_v1` · `group_v1` · `missed_v1`)를 먼저 만든 뒤에 토큰을 등록해야 함 — 서버가 채널 이름을 싣는데 기기에 채널이 없으면 알림이 안 보임
  - `can_send_push`에 `FRIEND_REQUEST` · `FRIEND_ACCEPTED`, 새 `plan_group_push`(위 표). 문구 · 채널 · 이동 경로는 `functions/_shared/push-copy.ts`의 종류 표 한 곳
- 친구 8장 깨우기 · 미확인 알림 (`20261109011723_friend_wake_ping.sql`, 이슈 #402)
  - `push_sends`(서버 전용 표): 보낸 깨우기(`WAKE_PING`, 보낸 사람 → 받는 사람 · 시각) · 친구 알림(`NUDGE` · `UP`, 받는 사람 · 안 일어난 사람 · 기상한 날). 깨우기 횟수(5분 1번 · 하루 3번) · 받은 깨우기 한 줄 · 같은 알림 두 번 방지가 이 표 하나. 탈퇴하면 그 사람이 낀 줄도 같이 지워짐
  - `profiles.wake_ping_enabled`(기본 켬): [깨우기 받기] 스위치 — 앱이 내 프로필을 직접 update. 다른 사람은 프로필을 못 읽어 꺼 둔 사실은 보낸 쪽 응답 `OFF`로만 드러남
  - `plan_wake_ping` · `claim_wake_nudges`(위 표, 서버 전용), `my_wake_pings(p_date?)`(앱: 오늘 받은 깨우기 `(sender_id, sender_nickname, sent_at)` 최신 순, 차단한 사람 것 제외), `get_wake_announcement()`(앱: 알람이 울리기 직전 음성 안내 `(group_id, group_name, up_count)` — 오늘 약속이 있는 내 그룹마다 일어난 사람 수(내가 볼 수 있는 사람, 나 빼고), 없으면 줄이 없음)
  - `can_send_push`의 `WAKE_PING`은 늘 거절(위 표) — 깨우기 판정은 `plan_wake_ping`이 따로 하고 새 `notify`는 `can_send_push`를 안 부름. `alarm_events`에 미확인(`MISSED`)만 빠르게 찾는 색인 추가
  - 새벽 약속(다음 날 01:00, 알람은 그 전날 밤)의 전날 밤 미확인도 친구 알림 대상 — 7장 '약속 있는 날'과 같은 기준
  - 9장 보정(11/9 헤드 결정): **'지난 약속'은 하루 경계** — 그 사람 프로필 시간대의 오늘 0시(`private.day_start`)보다 앞의 약속(오늘 이미 지난 약속은 오늘 안에는 고치기 · 참여 가능). 공동 약속 고치기(RLS)·참여 조건 만들기·그룹을 나갈 때 지우는 앞으로 약속·`plan_group_push`의 '안 지난 약속'이 모두 이 기준이고, 서버 함수 `appointment-edit` · `alarm-commit`도 같음. `plan_group_push`는 `silent_recipients`(약속 변경에서 알림을 껐거나 차단 쌍이라 보이는 알림에서 빠진 참여자)도 돌려주고, 서버는 이 사람들에게 문구 없는 조용한 데이터 푸시만 보내 알람을 다시 맞추게 함(`silent: true`)
  - 실서버에서 5분 배치(`wake-check`)가 돌고 있는지는 머지 · 배포 뒤 확인할 몫(Vault 키 · pg_cron 기록, "배치" 절). 이 PR은 로컬 스택에서만 확인
- 친구 9장 공동 약속 (`20261109003320_friend_group_appointments.sql`, 이슈 #404)
  - 고치기 규칙(RLS): 공동 약속은 **만든 사람만**(`creator_id`가 비면 그 약속에 참여한 사람 누구나), **앞으로 약속만**(내 시간대 오늘 0시 이후, 아래 8장 보정) 고침(지난 약속을 고치기는 오류 없이 0행, 지난 날로 옮기기는 오류 42501), 그룹을 나간 만든 사람은 더 못 고치고 못 지움. 지우기는 만든 사람만(`creator_id`가 비면 그 약속에 참여한 그룹원 누구나, 앞으로 약속만 — 고치기와 같은 규칙, 11/9 탐색 시험 X-APPT-01). `appointments.creator_id`는 비울 수 있게 됨(탈퇴한 사람의 약속, 비우는 일은 12장). 지난 공동 약속에는 `appointment_participants`를 새로 못 만듦(개인 일정은 지나도 만들 수 있음). 이미 있는 참여 조건의 고치기(도착 기록)는 막지 않음
  - 그룹을 나가거나 내보내지면 그 그룹의 **앞으로 약속**(그 사람 시간대 오늘 0시 이후)의 참여 조건 · 알람만 지워짐(5장 `after_group_member_gone` 고침, 11/9 결정). 지난 약속의 참여 · 울림 · 이동 시간 · 도착 기록은 남음. 나가는 사람의 참여가 지워져 참여자가 한 명도 안 남고 만든 사람 칸도 빈 앞으로 약속은 같이 지움(남의 할 일 · 고친 값 기록이 걸린 약속은 안 지움, 11/9 탐색 시험 X-APPT-04)
  - `group_appointment_counts(p_group_id)` · `appointment_joiners(p_appointment_id)`: 약속마다 '참여'(알람이 하나라도 켜짐) 수 · 참여자 줄. 참여 조건이 본인 줄만 읽혀서 서버가 세어 줌, 차단 쌍은 `hidden` = true(`joined`는 false)이고 인원수 합계에서도 뺌
  - 서버 함수 `appointment-edit`: 만든 사람이 공동 약속의 시각 · 장소를 고치면 **참여자마다** 자기 출발지 · 수단 · 준비 시간으로 알람을 다시 계산(앞당김과 5분 미만 늦춤은 바로, 5분 이상 늦춤은 그 사람이 확인할 때까지 보류, 이미 울린 알람은 안 건드림, 길찾기가 안 되면 그 사람의 알람은 그대로 + 경고) 하고 참여자에게 `GROUP_APPT_CHANGED` 푸시(`data.change` = `CHANGED`, `data.needsConfirm`). 지우면 참여자에게 취소 푸시(`data.change` = `CANCELED`)가 가고 받은 폰이 그 약속의 알람을 지움. 제목 · 중요도만 고치면 알림 없음. 공동 약속의 반복 고치기는 아직 `GROUP_RECURRENCE_LATER`로 거절(회차마다 참여자 알람을 만드는 일이 따로 필요). 지난 약속 고치기 · 새 참여는 `PAST_APPOINTMENT`(422)
- 친구 10장 알람 바꾸기 제안 (`20261109020300_friend_alarm_proposals.sql`, 이슈 #407)
  - `alarm_proposals`: 친구별 제안 한 줄 — `from_at`(제안 때 시각) → `to_at`, 상태 `PENDING` · `APPLIED` · `DISMISSED` · `REPLACED` · `EXPIRED`. 주인 본인 줄만 읽고(RLS select — 보낸 친구는 표를 직접 못 읽고 `sent_alarm_proposals`로만 봄: 무시 · 응답 시각 같은 주인 쪽 흔적이 새지 않게), 쓰기는 위 함수로만. 같은 알람에 대기 중 제안은 하나(부분 유일 색인)
  - `alarms.original_scheduled_at` · `original_time_source`: 친구가 처음 바꾸기 전 시각(합계 ±60분의 기준 · [원래대로])과 그때의 time_source(원래대로 돌아오면 복원 — 자동이었으면 다시 자동, 주인이 직접 골랐으면 계속 직접). 값을 쓰는 곳은 `respond_alarm_proposal` 하나이고, 그 밖에 시각이 바뀌면(주인이 직접 고침 · 서버가 새로 계산함) 트리거 `guard_alarm_original`이 둘 다 비움. 앱 역할은 이 칸들을 직접 못 씀
  - **배포 순서(중요)**: `alarm-suggest` · `alarm-commit` · `appointment-edit` · `alarm-roll`이 모두 알람을 읽을 때 `original_scheduled_at` · `original_time_source` 열을 고르므로 **이 마이그레이션이 실서버에 적용된 뒤에** 다시 배포함(먼저 배포하면 42703으로 전부 500). D67(친구 값은 약속의 시각 · 장소를 바꾸면 새 계산이 이김)은 `appointment-edit` · `alarm-roll`을 다시 배포해야 켜지고, `notify`만 배포하면 알림 문구만 바뀜
  - 친구가 알람을 바로 고치는 옛 길(`alarms_update_shared`)은 이 마이그레이션에서는 열어 둠(앱 G04가 그 길로 고치던 때) → G04가 제안으로 옮겨진 11/9(PR #423)에 `20261109043000_friend_alarm_direct_edit_closed.sql`(이슈 #427)로 닫음: 정책을 `alarms_update_own`(주인 본인만)으로 바꿔, 설정 권한이 있는 친구가 앱(PostgREST)으로 알람 시각 · 켬/끔 · `time_source`를 직접 update하면 0행이고 알람은 그대로. 친구가 바꾸는 값은 `propose_alarm_time` → 주인 `respond_alarm_proposal`([적용])으로만 들어가며(보안 정의자 함수라 RLS를 안 거침), 서버 함수(service_role)도 그대로. 알림 판정 `can_send_push`의 `ALARM_CHANGED`는 이미 '방금 보낸 대기 중 제안'이 있어야 true라 바꿀 것 없음. 설정 권한(`can_edit_alarm`)의 뜻은 '제안 보낼 수 있음'으로 그대로
  - 서버 함수: `notify`의 `ALARM_CHANGED` 문구가 "○○님이 내일 기상 알람을 7:30 → 7:00으로 제안했어요"이고 이름 · 이전 → 새 시각 · 알람 종류는 요청이 아니라 제안 기록에서 가져옴(옛 앱이 보낸 `previousAt` · `newAt`은 무시, 알림 데이터에 `alarmId` · `proposalId`). `appointment-edit`는 친구가 정한 알람(`original_scheduled_at`이 있는 것)을 주인이 직접 고른 MANUAL처럼 취급하다가 약속의 시각 · 장소를 바꿀 때만 새 계산에 밀려나게 함(D67)
- 친구 12장 계정 삭제 (`20261109031500_friend_account_delete.sql`, 이슈 #418)
  - `appointments.creator_id` 외래키가 연쇄 삭제에서 **비움(`on delete set null`)**으로 바뀜 — 계정을 지우면 내가 만든 공동 약속은 지워지지 않고 '만든 사람 알 수 없음'으로 남아 참여자 누구나 고침(9장). 개인 약속(그룹 없음)은 만든 사람이 늘 있어야 해서(`appointments_creator_or_group` 검사) 프로필 삭제 직전 트리거(`delete_personal_appointments`)가 먼저 지움 — 준비 함수를 안 거친 계정 삭제(시드 · 시험 도구)도 막히지 않음
  - 키 칸 보호(`keep_keys`)는 appointments에서 `prevent_appointment_key_change()`로 바뀜: `group_id` · `series_id` · `occurrence_on`은 그대로 못 바꾸고, `creator_id`는 **값 → 비움**만 허용 — 그 사람의 프로필이 이미 없을 때(FK) 또는 그 그룹의 참여 멤버가 아닐 때(나간 뒤). 참여 중인 사람이 자기 약속의 만든 사람을 스스로 비우는 길은 여전히 막힘
  - 그룹을 **나갈 때**(탈퇴가 아니어도) 그 사람이 만든 앞으로 공동 약속(그 사람 시간대 오늘 0시 이후)의 만든 사람 칸도 비움(11/9 헤드 결정). 지난 약속은 기록으로 만든 사람이 남음
  - `prepare_account_delete` · `my_account_delete_summary`(위 표), 서버 함수 `account-delete`: 본인만(요청의 `userId`는 로그인한 사람과 같아야 하고 다르면 403), 준비 → `auth.admin.deleteUser`, 응답 `{ deleted: true, groups_left, groups_deleted, group_appointments_kept }`. 준비가 확실하지 않으면(DB 오류 · 이상한 응답) 계정을 지우지 않고(준비의 권한 오류도 일반 500), 계정 삭제 단계가 실패하면 일반 문구의 500 — 다시 부르면 이어서 끝남(그 사이엔 개인 약속 · 토큰 · 그룹 멤버십이 이미 지워진 상태라 취소는 안 됨, 준비는 두 번째에 모두 0, 같은 계정을 동시에 두 번 지울 때의 "이미 없는 계정"(`user_not_found`)만 끝난 것으로 봄). 삭제 직후 같은 토큰은 로그인 확인에서 401이라 **삭제는 됐는데 응답을 못 받고 다시 부르면 401** — 앱은 이 401을 '이미 지워졌을 수 있음'으로 보고 기기를 비운 뒤 로그인 화면으로. 요청의 `userId` 외 다른 이름의 칸은 무시(삭제 대상은 늘 로그인한 사람)
  - 이 PR에 없는 것: 반복 공동 약속을 만든 사람이 탈퇴했을 때 '반복이 멈췄어요'(12-13) — 반복 공동 약속이 아직 없어 그 PR 때, 앱 [계정 삭제] 화면 · 웹 삭제 요청 안내 페이지(S2), 탈퇴 뒤 보관 기간(개인정보 13장)
- 친구 13장 개인정보 (`20261109040000_friend_record_purge.sql`, 이슈 #422)
  - `private.purge_old_friend_records()`: 7일 지난 서버 기록을 지우고 지운 수를 `(rate_limit_deleted, push_sends_deleted, push_tickets_deleted, alarm_proposals_deleted)`로 돌려줌 — `rate_limit_events`(검색 · 친구 요청 · 그룹 코드 실패 제한 기록) · `push_sends`(깨우기 발송 기록) · `push_tickets`(푸시 영수증, 영수증 배치가 15분 뒤 확인하고 24시간 뒤엔 포기하지만 남은 줄이 없도록 하는 마지막 안전망) · 끝난 `alarm_proposals`(적용 · 무시 · 대체 · 만료된 지 7일이면서 알람 시각도 7일 넘게 지난 것, 또는 대기 중인데 알람 시각이 7일 넘게 지난 것 — 알람이 아직 안 지난 줄은 보낸 친구의 '제안함' · '반영됨' 근거라 남김. 13장 보관 표에 없던 표라 같은 7일로 맞춤). 기상 기록(`daily_records` · `alarm_events`)은 계정이 있는 동안 남김. 앱 · 서버 함수 · 서버 역할 모두 못 부르고(실행 권한 없음) DB 예약만 부름
  - pg_cron이 있는 곳(실제 Supabase)에서만 `friend-records-purge`로 매일 UTC 18:00(한국 새벽 3시)에 예약 — `friend-requests-expire`와 같은 모양(서버 함수 없이 SQL 한 줄), 같은 이름으로 다시 예약하면 갈아끼움. 실서버에서 도는지는 머지 · 적용 뒤 `cron.job` / `cron.job_run_details`로 확인
  - 이 장의 나머지는 규칙 확인뿐이라 DB 변경 없음: 친구는 상대 프로필을 직접 못 읽고(공개 프로필 함수는 아이디 · 닉네임 · 사진만), 알람 조회가 없으면 알람 · 약속 · 참여 조건(출발지) · 수면 기록이 0행, 알람 조회가 있어도 약속 제목 · 장소 · 시각만 받으며 위치로 잡은 실제 출발 · 도착 시각 · 미루기 · 해제 기록(`alarm_events`)은 0행이고, 그룹 기상 응답에는 미루기 · 해제 시각 칸이 없으며, 열람 기록은 남기지 않음 — 시험 `supabase/tests/friend/ch13.mjs`
- 친구 15장 남용 · 보안 (`20261109050000_friend_abuse_closing.sql`, 이슈 #431)
  - 직접 insert 정책 2개를 닫음: `friends_insert_request`(친구 요청) · `group_members_insert_invite`(그룹 초대). 앱이 함수 밖에서 바로 넣으면 1분 10회 · 하루 50회 제한(3-사)과 차단 검사를 우회하므로, 정책이 없으면 RLS가 모든 직접 insert를 42501로 거절하고 `send_friend_request` · `invite_to_group`(둘 다 `security definer`)만 넣음. 앱은 이미 함수로만 보냄(PR #385 · #394)
  - 4장 직접 insert 가드(`guard_friend_insert` 트리거 · 함수)는 같이 지움 — 정책이 닫히면 모든 직접 insert가 같은 거절(42501)이라, 남겨 두면 오히려 차단당한 쪽의 insert만 다른 모양(23503)으로 거절돼 차단당했음이 드러남(4-가)
  - 시험 계정 초기화 `dev_reset_my_data()`가 친구 · 그룹 참여 · 공유 권한 · 내가 건 차단 · 숨긴 기상도 지움(아래 항목). 새 비공개 함수 `private.dev_reset_friend_data(uuid)`(앱 · 서버 모두 못 부름)가 정리 본체
  - 이 장의 나머지(계정 단위 제한 · 익명 접근 · 함수 입력 길이 · 남의 행 읽기 · 쓰기 · 권한 없는 알람 조회 · 새 표 RLS)는 규칙 확인뿐이라 DB 변경 없이 시험(`tests/friend/ch15.mjs`)만 붙음
  - 이 PR에 없는 것(빈 곳): `groups_insert_owner`(그룹 만들기 직접 insert — 앱이 아직 그 길로 만듦, 이름 길이 · 10개 상한 · 코드 서버 발급은 트리거가 막음) · `profiles.wake_ping_enabled` 직접 update 거절(15-08, 앱 PR #417이 그 길로 스위치를 바꿈) · 알림 서버 함수 15-09 ~ 15-11 · 15-24(기존 `notify` 시험)
- 친구 4장 꼬리 신고 처리 · 팀원 표 (`20261109060000_friend_report_handling.sql`, 이슈 #431)
  - `team_members`(서버 전용 표 — RLS만 켜고 앱 권한 없음): 운영 화면(웹 신고 처리)을 열 수 있는 팀원 계정. 추가 · 삭제는 서버 키(service_role)로 `insert into public.team_members (user_id) values ('…')`. 탈퇴하면 같이 지워짐. 판정은 비공개 함수 `private.is_team_member(uuid)` 한 곳
  - `list_reports(p_status default 'OPEN', p_limit default 50)`: 팀원만. `OK{total, reports}` · `FORBIDDEN`(팀원 아님) · `INVALID`(상태 `OPEN` · `DONE` · `ALL` 밖, 개수 1~100 밖). 최신 순. 줄마다 신고자 · 대상(사람이면 지금 닉네임 · 사진, 그룹이면 지금 이름) · 사유 · 메모 · 상태 · 처리 결과 · 처리한 사람 · 시각 · 근거(`evidence`)
  - `resolve_report(p_report_id, p_action)`: 팀원만. `HIDE`(대상 사람의 닉네임을 '사용자'로 · 사진을 비움, 그룹이면 이름을 '이름 없는 그룹'으로) · `DISMISS`(대상 그대로) → 신고를 `DONE`으로 하고 결과 `resolution`(`HIDDEN` · `DISMISSED`) · 처리한 사람 · 시각을 남김. `HIDDEN` · `DISMISSED` · `ALREADY_DONE`(이미 처리된 신고는 다시 안 바꿈) · `NOT_FOUND` · `INVALID` · `FORBIDDEN`. 신고한 사람에게 알림 없음. 팀원 확인이 먼저라 팀원 아니면 신고가 있는지도 알 수 없음
  - `reports`에 `resolution` · `evidence` 칸 추가, 처리 중이면 결과 없음 · 처리됨이면 결과 있음을 표 규칙으로(`reports_resolution_shape`)
  - 근거 보관(13장 후속): `submit_report`는 사람 대상 괴롭힘(`HARASSMENT`) 신고가 들어온 순간 두 사람 사이(양쪽 방향)의 7일 안 깨우기(`push_sends`) · 알람 제안(`alarm_proposals`) 기록을 각각 50건까지 `reports.evidence`로 복사 — 원본은 7일 뒤 정리 배치(`friend-records-purge`)가 지우지만 신고 줄에 남은 근거는 안 지워짐. 괴롭힘이 아닌 신고 · 그룹 신고에는 근거를 안 모음(필요한 만큼만 모으기). 앱 호출 모양은 그대로
  - 근거 창과 정리 배치 기준은 조금 다름: 근거는 만든 지 7일 안 기록만 복사하고, 정리 배치는 알람 시각이 아직 안 지난 끝난 제안을 7일이 넘어도 남겼다가 나중에 지움 — 그런 기록은 신고 때 근거로 안 들어감(문서의 '7일 안' 규칙과는 같음)
  - 숨김은 신고 때가 아니라 처리하는 때의 닉네임 · 사진 · 그룹 이름에 작용하고, 신고된 시점의 값은 어디에도 안 남음(그사이 바꿨으면 바뀐 값이 초기화됨). 필요하면 신고 시점 값을 `evidence`에 스냅샷하는 방법이 있음(빈 곳)
  - `list_reports`는 최신 100건까지(`total`은 전체 개수, 쪽 이동 없음)
  - 이 PR에 없는 것: 웹 운영 화면(앱 S2 몫), 신고 줄 보관 기간(지금은 계속 남음 — 정리 규칙은 개인정보 정책이 정하면)
- 친구 7 · 8장 보정 (`20261109061000_friend_wake_hardening.sql`, 이슈 #431)
  - 기상 조회(`get_group_wake` · `get_group_wake_status`)의 날짜는 호출자 시간대 기준 어제 · 오늘 · 내일만 — 그 밖은 줄 없음(약속이 없는 날과 같은 모양, 날짜를 안 주면 오늘). 친구의 지난 기상 이력을 날짜를 바꿔 가며 거슬러 읽는 길을 막음. 판정은 비공개 함수 `private.wake_date_in_range(date)`. 서버 쪽 계산(`private.group_wake_rows`)은 그대로라 서버 함수 · 시험은 제한 없이 같은 날을 읽음
  - 깨우기 판정(`plan_wake_ping`)에서 자동 판정(폰 사용) 기상이 아직 20분 안이라 친구에게 안 보이는 동안(D61)의 응답을 `ALREADY_UP` 대신 `OFF`로 — 앱이 이미 `OFF`를 '지금은 깨울 수 없어요'로 보여 주므로 앱 수정 없음. 숨기던 확인이 깨우기 응답으로 먼저 드러나지 않음. 확인이 친구에게 보인 뒤의 `ALREADY_UP`은 그대로
  - 미확인 '깨워 볼까요?'(`claim_wake_nudges`)는 깨우기 받기를 끈 사람(`wake_ping_enabled = false`)에 대해서는 정하지 않음. 끈 사람이 다시 켜면 다음 배치부터
  - 7장 한계(문서만): 기상을 숨기거나 차단한 상대에게도 기상 신호(날짜뿐)는 가므로 2명 그룹에서는 신호가 도착하는 때로 상대가 움직였음을 짐작할 수 있음 — 막지 않음(`친구_논리설계.md` 7장)
- `dev_reset_my_data()` (`20261030220000_dev_reset_my_data.sql`) — **개발용**. 이메일이 `@example.com`인 시드 · 시험 계정만 부를 수 있음(카카오 · 구글 일반 계정이 부르면 42501 '시험 계정만 쓸 수 있음', 11/9 탐색 시험 X-SEED-03). 부른 사람 본인의 시험 데이터(일정 · 알람 · 울림 기록 · 기록 · 일기 · AI 대화 · 고친 값 기록 · 제안)를 지우고 프로필을 온보딩 전으로 되돌림. 인자 없음 — `auth.uid()` 본인 줄만 건드림. 그룹 일정(`group_id` 있음, 그룹원 누구나 조회)과 다른 사람이 참여 중인 일정은 내 참여 행(과 내 알람)만 지우고 일정은 둠 — 일정째 지우는 건 내가 만든 개인 일정 중 혼자인 것뿐. 11/9부터(`20261109050000_friend_abuse_closing.sql`, 15장) 친구 쪽도 지움: 그룹 참여(나가기와 같은 정리 — 앞으로 약속 참여 · 알람, 만든 사람 칸 비움, 마지막 참여 멤버면 그룹 삭제, 초대받은 것 포함) · 친구 관계(받은 · 보낸 요청 포함)와 그 공유 권한(내가 준 것 · 받은 것) · 내가 건 차단 · 내가 숨긴 기상. 남이 나를 건 차단은 그대로. 결과 JSON에 `friend_data`(`groups_left` · `sharing_permissions` · `friends` · `blocks` · `wake_hides` 지운 수)가 붙음. 옛 본체는 `private.dev_reset_my_data_core()`로 옮겨 이름만 바뀌고 앱 이름 `dev_reset_my_data()`는 친구 정리 → 본체 순서로 부르는 껍데기. 푸시 토큰 · 친구 제한 기록 · `ai_calls` · `user_questions`(AI 상한 · 질문 예산을 세는 기록) · 루틴 · 할 일은 그대로. 앱은 개발 화면(`/dev/screens`)에서만 부르고 출시 빌드에서는 안 부름

## 반복 다음 회차 (`20261029075743_alarm_roll.sql`, 이슈 #209)

반복 약속 · 일정 없는 반복 알람은 **회차마다 한 줄**씩 지금 ~ 14일 뒤까지 미리 만들고, 지난 회차는 기록으로 남김 (D4 A). 이 마이그레이션은 그 저장 모양과 DB 함수만 — 회차를 만드는 서버 함수 `alarm-roll`(3a-2)과 앱 맞추기(3b)가 머지돼야 실제로 회차가 생김. 그 전에는 모든 약속이 묶음 1개짜리라 지금 동작은 그대로.

- 칸: `appointments` · `alarms`(일정 없는 알람만)의 `series_id`(같은 반복의 묶음 번호, 첫 회차는 자기 id) · `occurrence_on`(회차 날짜 = 만든 사람 `profiles.timezone`, 없으면 Asia/Seoul의 0시 기준 — 새벽 1시 약속은 UTC로는 전날이어도 한국 날짜). insert 전에 DB가 채움(`private.fill_series`)
- (만든 사람, 묶음, 날짜)가 유일(`appointments_series_occurrence_key` · `alarms_series_occurrence_key`) → 같은 회차를 두 번 안 만듦. 묶음 · 날짜는 열쇠 칸(`keep_keys`)이라 service_role도 못 바꿈 → "이번만 시각 바꾸기"를 해도 날짜는 그대로
- 앱은 남의 묶음에 회차를 못 넣음: `appointments_insert`는 `series_id = appointment_id`(새 묶음)만 받음. 회차를 이어 붙이는 건 service_role(`roll_insert_occurrence`)뿐
- `travel_source`에 `ESTIMATE` (회차 길찾기가 첫 알람 12시간 전까지 안 될 때의 근사값, H03에서 "대략")
- `roll_attempts`: 회차 길찾기 실패 재시도 기록 — 날짜마다 한 줄, RLS만 켜고 정책 없음(service_role 전용)
- DB 함수 `roll_insert_occurrence` · `roll_due_series`는 위 "서버 함수가 쓰는 DB 함수" 표. pg_cron 예약은 "배치"
- 반복 규칙은 `FREQ=DAILY` · `FREQ=WEEKLY;BYDAY=MO,…` 두 모양만 받음(`_shared/draft.ts` `RRULE_PATTERN`, 그 밖은 400) — 해석은 `_shared/calc/recur.ts`

## 자주 가는 곳 (`user_places`, `20261030210000_user_places.sql`, 이슈 #31)

학교 · 회사 · 알바 등 한 사람 **최대 5개** (헤드 설계 10/30 "집 · 회사 위치를 지도로"). 집은 `profiles.home_*` 그대로.

- 칸: `label`(이름표 1~20자, 사람 안에서 유일 — 같은 이름표로 저장하면 덮어씀) · `name` · `address` · `lat` · `lng`(`numeric(9,6)`, ±90 · ±180) · `radius_m`(100~500, NULL = 앱 기본값)
- 5개 제한은 BEFORE INSERT 트리거(`private.enforce_user_places_limit`): 6번째 새 이름표는 `54000`. 이미 있는 이름표를 덮어쓰는 upsert는 개수가 늘지 않아 통과
- RLS는 본인만 읽고 쓰기. 친구 · 그룹 읽기 정책 없음 (위치는 공유 안 함, Q13 · D59). 앱은 `features/location/api.ts`의 `listUserPlaces` · `saveUserPlace` · `deleteUserPlace`

## 그룹 기상 신호 (Realtime)

`alarm_events`는 본인만 읽을 수 있어서 남의 기상 기록은 Realtime으로 직접 못 받음 → 기상 기록이 들어오면 DB가 그룹 채널에 "새로 고침" 신호만 보내고, 받은 앱이 `get_group_wake`(옛 앱은 `get_group_wake_status`)를 다시 부름 (권한은 그 함수가 봄).

- 채널 `group:<group_id>:wake` (비공개 채널), 이벤트 `refresh`, 내용 `{"date": "2026-10-15"}` — 누구의 기록인지는 안 담음. 실제 Realtime은 payload에 `id`(uuid)를 덧붙이므로 앱은 payload 전체를 비교하지 말고 `date`만 읽음
- 보내는 때: 기상 알람의 울림 · 미루기 · 해제 · 미확인, 기상 확인. 기록한 사람이 참여 중(JOINED)이고 **그 그룹에서 기상 공유에 동의(`wake_share_opt_in`)했고** 그날 약속이 있는 그룹에만 감 (동의 조건은 D19 결정 전 보수 기본값 — 정해지면 트리거 함수의 한 줄만 고침. 친구 권한으로만 보는 사람은 실시간 새로 고침을 못 받고 직접 조회하면 보임)
- 받는 쪽: `supabase.channel('group:<id>:wake', { config: { private: true } })` — 그 그룹에 참여 중인 사람만 받을 수 있음 (`realtime.messages` 정책). 앱에서 이 채널로 보내는 것은 막혀 있음
- `realtime` 스키마가 없는 DB(PGlite 같은 검사용 DB)에서는 트리거 · 정책을 건너뜀 → 검사는 흉내(`tests/db-check.mjs`)로 확인
- 적용 뒤 확인: `select polname from pg_policy where polrelid = 'realtime.messages'::regclass;`에 `wake_signal_receive`가 있어야 하고, `select tgname from pg_trigger where tgrelid = 'public.alarm_events'::regclass and not tgisinternal;`에 `send_wake_signal`이 있어야 함. 없으면 아래를 SQL 편집기에서 직접 실행 (정책은 마이그레이션이 "권한이 없음" 경고를 남겼을 때, 트리거는 마이그레이션이 Realtime 스키마가 없다고 건너뛰었을 때. 이미 있으면 "already exists" 오류가 나고 그대로 두면 됨)

트리거 (마이그레이션 `20261015000100_group_wake.sql`의 `create trigger`와 같은 문장):

```sql
create trigger send_wake_signal after insert on public.alarm_events
  for each row execute function private.send_wake_signal();
```

받는 쪽 정책:

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

## 서버 함수 (Edge Functions)

`functions/<이름>/index.ts`. 앱은 `supabase.functions.invoke('<이름>', { body })`로 부름 (로그인 토큰이 자동으로 실림). 계산 · 외부 API(카카오 · Expo) · 여러 테이블을 한 번에 쓰는 일만 함수로 하고 나머지는 앱이 DB에 직접 함 (`docs/screen-data-map.md`).

| 함수 | 하는 일 | 부르는 곳 | `verify_jwt` | 외부 |
|---|---|---|---|---|
| `alarm-suggest` | 이동시간 · 기상 · 준비 · 출발 · 도착 시각 · 강도 미리 보기 (DB에 안 씀). 요청은 `alarm-commit`과 같은 초안 모양. 직접 입력 이동은 이어받음 | 앱 H05 · H03 | 켬 | 카카오 길찾기 |
| `alarm-commit` | 약속 · 참여 조건 · 알람을 한 번에 저장 → 예약 꾸러미 + 취소할 알람 id. 일정 없는 알람도 여기서 만듦. 요청은 `alarm-suggest`와 같은 초안 모양 + `title` · `replace_existing` · `edits`. 직접 입력 이동은 이어받음 | 앱 H05 · H03 · S01 | 켬 | 카카오 길찾기 |
| `place-search` | 장소 검색 | 앱 H05 · 온보딩 | 켬 | 카카오 로컬 |
| `place-reverse` | 지도 핀 좌표 → 주소 | 앱 지도 핀 | 켬 | 카카오 로컬 |
| `notify` | 다른 사람 폰에 푸시 (종류별 고정 문구 · 권한은 `can_send_push` · 그룹은 `plan_group_push`) | 앱 G04 · G03 · F01 · G02 | 켬 | Expo Push |
| `account-delete` | 계정 삭제 (친구 12장): 본인만, `prepare_account_delete`(개인 약속 삭제 · 그룹 나가기 · 토큰 삭제) → `auth.admin.deleteUser`. 공동 약속은 만든 사람 칸만 비어 남음 | 앱 설정 > [계정 삭제] (두 번 확인 뒤) | 켬 | — |
| `appointment-edit` | 일정 수정 · 삭제 (N6, D41): 한 번짜리와 반복의 **이번만 / 이후 모두** 고치기 · 지우기, 이번만 지운 회차 되돌리기, 공동 약속에서 나만 빠지기(만든 사람이 시각 · 장소를 고치면 참여자 알람도 다시 계산하고 푸시 — 친구 9장). 알람은 다시 계산해 `ring_packages` · `canceled_alarm_ids`를 `alarm-commit`과 같은 모양으로 돌려줌(앱이 `applyCommit`에 그대로). 7장 7.1.3: 앞 일정이 바뀌거나 지워지면 같은 날 다른 일정의 기상을 다시 판정. 요청 `{ action: UPDATE|DELETE|RESTORE|LEAVE, appointment_id, scope?: this|following, patch?, confirmed? }`. 이번만 고친 / 지운 회차는 `appointments.exception_kind`(EDITED / CANCELED)로 표시 — alarm-roll이 다시 안 만들고 기준 회차에서 뺌. **배포는 `20261030150000_appointment_edit.sql` 적용 뒤, `alarm-roll` 재배포도 같이** | 앱 H03 편집 시트 (4c 뒤) | 켬 | 카카오 길찾기 (장소를 바꿀 때) |
| `suggestion-apply` | 알람 조정 제안 적용 · 고쳐 적용 · 무시 · 되돌리기 (지금은 준비 알람 당김만, 안건 D111 · D23 A). 그 일정의 이번 회차와 이후 회차의 당김 분(`prepare_advance_minutes`)을 바꾸고, 알람은 다시 계산하지 않고 당김 차이만큼만 옮김(준비 알람 = 차이, 기상 = 준비 전 활동을 넘는 차이) → `ring_packages`. 되돌리면 제안은 대기로. 본문 `_shared/suggest-apply.ts` |
| `wake-check` | 기상 미확인(MISSED) 기록 | pg_cron 5분마다 (서비스 키) | 끔 (코드에서 키 비교) | — |
| `alarm-roll` | 반복 약속 · 일정 없는 반복 알람의 다음 회차를 앞으로 14일치 미리 만들고(회차마다 약속 · 참여 · 알람 새 행, 회차마다 길찾기 1번), 루틴 알람 시각을 다음 발생으로 옮김. 길찾기가 안 되면 1 · 3 · 6시간 뒤 재시도 → 첫 알람 12시간 전까지 안 되면 내 실측 중앙값(`CACHED`) → 직선 근사(`ESTIMATE`). 응답 `{ created, moved_alarm_ids, pending, ring_packages, canceled_alarm_ids, kakao_calls }` (`pending`은 `{ series_id, occurrence_on, reason }` 목록, `reason`은 `ROUTE_RETRY`(길찾기 재시도 대기) · `DAILY_BUDGET`(하루 길찾기 몫) · `ALARM_CAP`(앞으로 켜진 알람 상한) · `RUN_LIMIT`(이번 실행 한도 · 시간)). 길찾기를 쓴 뒤 계산 · 저장이 던져도 재시도 기록(1 · 3 · 6시간)을 남겨서 다음 5분 실행이 같은 회차로 카카오를 또 부르지 않음. **배포는 앱 맞추기(3b) 머지 뒤** | 배치: pg_cron 5분마다 (서비스 키, 길찾기 20번 · 50묶음 · 40초) / 본인: 앱 `syncNow`·반복 일정 저장 직후 (로그인 토큰, 길찾기 최대 4회차) | 끔 (코드에서 길을 가름) | 카카오 길찾기 |
| `voice-session` | 자기 전 대화 시작 · 이어 받기(텍스트, 첫 마디는 서버 템플릿 — 모델 호출 없어 `ANTHROPIC_API_KEY` 없이도 동작). 오늘 안 끝난 세션은 그대로(resume), 하루 5대화 넘으면 `session_id: null` + `limits.reached: DAY`. L4 AI 묶음 — **첫 배포 전 헤드에 알림** | 앱 A02 | 켬 | — |
| `voice-turn` | 자기 전 대화 한 턴(`text` · `results` · `card_action`). 빠른 추출(T2F) ∥ 대화 답(T1) → 턴 처리 → 가드, 모델 호출마다 `ai_calls` 한 줄. `rev` 비교(`CONFLICT`) · `client_turn_id` 재시도, 키 없으면 `NOT_CONFIGURED`, T1 실패는 `LLM_UNAVAILABLE`(`details: { cards, fixes }`), 서버 마감 18초(앱 25초). 비밀값 `ANTHROPIC_API_KEY` · `ANTHROPIC_MODEL`(선택) · `AI_LOG_IO_USER_IDS`(선택, 호출 입력 · 출력 글을 `ai_calls.io`에 남길 사용자 id 쉼표 목록 — 비면 아무도 안 남김). L4 AI 묶음 — **첫 배포 전 헤드에 알림** | 앱 A02 | 켬 | Claude |
| `voice-live-token` | 실시간 음성 대화(Gemini Live) 1회용 토큰 발급 → `{ token, model }`. 모델 · 지침을 토큰에 잠금, 1회용 · 1분 안에 연결 · 대화 최대 10분(토큰 만료). 키 없으면 `NOT_CONFIGURED`, Google 실패는 `VOICE_UNAVAILABLE`. 비밀값 `GEMINI_API_KEY` | 앱 A02 [말하기] | 켬 | Gemini Live 토큰 |
| `timetable-extract` | 시간표 사진(base64, 원본 4MB 이하 jpeg · png · webp) → Claude(Haiku 5.5 사진 읽기) → `{ rows: [{ title, weekdays[], start, end, place }], confidence, left_today }`. 출력은 스키마로 다시 검사하고 이름 · 시각 · 요일을 정리(버린 줄이 있고 `confidence`가 HIGH였으면 MEDIUM으로, 읽은 수업이 없으면 LOW). **사진은 저장하지 않음** — `ai_calls`에 지점 `TT` 한 줄(토큰 · 비용 · 지연)만, `io`는 늘 NULL. 하루 10번(성공 · 실패 모두 셈, `RATE_LIMITED`) + 전체 AI 호출 상한. 키 없으면 `NOT_CONFIGURED`, 모델 실패는 `LLM_UNAVAILABLE`, 서버 마감 28초(앱 35초). 비밀값은 `voice-turn`과 같은 `ANTHROPIC_API_KEY` · `ANTHROPIC_MODEL`(선택). L9 시간표 채우기 — 마이그레이션 `ai_calls_point_timetable`(지점 `TT` 허용)을 **먼저** 적용한 뒤 배포 | 앱 온보딩 · 설정 시간표 캡처 길(뒤 PR) | 켬 | Claude |

공통 틀은 `functions/_shared/`: `http.ts`(CORS · `X-Request-Id` · 오류. 앱이 보낸 `X-Request-Id`는 영문 · 숫자 · `_` · `-` 64자 이하일 때만 쓰고 아니면 서버가 새로 만듦) · `auth.ts` · `read.ts`(요청 검사) · `supabase.ts` · `env.ts`. 계산은 `_shared/calc/` ("공용 계산").

### 오류 모양

모든 실패는 `{ "error": { "code", "message", "details"? } }` (5장 5.2.1). `message`는 화면에 그대로 보여도 되는 짧은 한국어, 앱은 `code`로 처리를 고름.

| HTTP | code | 언제 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | 필드 누락 · 형식 오류. `details.issues[{ path, message }]` |
| 401 | `AUTH_REQUIRED` | 토큰 없음 · 만료 · 서비스 키 틀림 |
| 403 | `FORBIDDEN` | 권한 없음 (그룹 비참여, `notify` 권한 없음 등) |
| 404 | `NOT_FOUND` | 일정 · 알람 없음 (남의 일정도 같게 보임) |
| 405 | `METHOD_NOT_ALLOWED` | POST가 아님 |
| 422 | `UNPROCESSABLE` | 출발 시각까지 지남 · 알람 순서 어긋남 · 지난 시각. `details.reason`: `DEPARTURE_PASSED` · `ORDER` · `PAST_TIME` |
| 429 | `RATE_LIMITED` | 카카오 호출 한도 |
| 500 | `INTERNAL` | 그 밖 (원문은 로그에만) |
| 502 | `ROUTE_UNAVAILABLE` | 이동시간을 구할 길이 없음(좌표가 없고 직접 입력도 없음). `details.manual_required` = 직접 입력으로 이어 가기 (`alarm-suggest`는 이때 오류 대신 200 + `travel.manual_required`). `alarm-commit`은 `details.fallback`에 근사값 · 실측 중앙값을 줌 |
| 502 | `PLACE_UNAVAILABLE` | 장소 검색 API 장애 |
| 503 | `NOT_CONFIGURED` | 비밀값이 아직 없음 (카카오 키 등) |

5.2.1 표에 없는 `METHOD_NOT_ALLOWED` · `PLACE_UNAVAILABLE` · `NOT_CONFIGURED`만 더함. 시각은 ISO 8601 + 오프셋. `Idempotency-Key`(5.2)는 아직 안 받음.

### alarm-suggest

요청 — **`alarm-commit`과 같은 초안 모양**이라 앱은 H05 · H03 초안 하나를 두 함수에 그대로 보냄 (계획 7절). 새 약속은 `appointment`, 기존 약속은 `appointment_id` (둘 다 쓰면 400). 기존 약속이면 시각 · 장소 · 중요도는 DB 값을 씀 (D41). 미리 보기에는 `title` · `group_id` · `recurrence_rule` · `replace_existing` · `edits`가 필요 없어 읽기만 하고 안 씀. 예전 모양(루트의 `appointment_at` · `destination` · `travel_minutes_override` · `prepare_minutes_override`)은 받지 않음. 앱은 `place-search`가 준 좌표를 초안의 `destination` · `origin`에 담아 보냄 (좌표가 없으면 길찾기를 못 함). 새 약속의 `destination`에는 선택 칸 `radius_m`(정수 100~500, 목적지 감지 반경)을 더 담을 수 있고 `alarm-commit`이 `appointments.dest_radius_m`에 저장함 (없으면 NULL, 기존 약속에 참여할 때 · 출발지의 `radius_m`은 무시, 미리 보기 계산에는 안 씀).

```jsonc
{
  "appointment_id": "uuid",                  // 기존 약속 기준 (H03). 새 일정이면 아래 appointment
  "appointment": { "appointment_at": "2026-10-20T10:00:00+09:00",   // 새 일정이면 필수 (title은 저장할 때만 필수)
                   "destination": { "name": "세종대학교", "lat": 37.55, "lng": 127.07 },   // 필수. 앱은 place-search로 고른 장소의 좌표(lat · lng)를 담아 보냄
                   "importance": "NORMAL" },
  "participant": {
    "origin": { "name": "집", "lat": 37.5, "lng": 127.0 },   // 없으면 저장된 출발지 → 프로필 집. 앱은 좌표도 같이 보냄
    "transport_type": "TRANSIT", "buffer_minutes": 10,
    "est_travel_minutes": 70, "travel_source": "MANUAL",      // 선택: 직접 입력한 이동 (MANUAL), 이미 보여 준 길찾기 값이면 "API" — 둘은 같이 보냄
    "prepare_minutes": 40,                                    // 선택: 직접 고른 준비(기상~출발)
    "before_prepare_minutes": 20, "with_wake": true           // 선택: 기상 뒤 준비 전 활동 / 그날 첫 일정 여부 (없으면 서버가 정함)
  },
  "kinds": ["WAKE", "PREPARE", "DEPARTURE"], // 선택: 만들 알람 종류. 없으면 지금 있는 종류(없으면 전부), [] = 알람 없는 일정
  "enabled": { "WAKE": true },               // 선택: 종류별 켜기 · 끄기
  "manual_times": { "WAKE": "2026-10-20T07:30:00+09:00", "PREPARE": null },   // 직접 고른 알람 시각. 이 칸이 없으면 저장된 직접 값 유지, null = 자동으로 되돌림
  "levels": { "sound": 0, "voice": null, "vibration": 2 }   // 축별로 직접 고른 강도 단계(0 약 · 1 중 · 2 강). sound → alarms.sound_key, voice → voice_tone, vibration → alarms.vibration (null = 그 축만 자동). intensity는 늘 자동 전체 세기(볼륨 · 다시 울림). 이 칸이 없으면 저장된 직접 값 유지
}
```

응답: `appointment_at` · `wake_at` · `prepare_at` · `departure_at` · `arrive_at` · `alarms[{ alarm_type, scheduled_at, auto_scheduled_at, time_source, is_enabled, disabled_reason }]` · `check{ ok, reason? }` · `travel{ minutes, source(API · CACHED · ESTIMATE · MANUAL), manual_required, needs_confirmation, auto_minutes, note, sample_count }` · `prepare{ minutes, auto_minutes, source, common_p80, correction, sample_count, prior, weight, residual_p80, before_prepare_minutes }` · `intensity{ level(전체 세기), voice_tone, sound_key, vibration(직접 고른 진동만, 자동이면 null), source, reason, auto_level, axes }` · `with_wake` · `confidence` · `warnings[{ code, message }]`. 시각은 `Z`(UTC) ISO 8601.

- 이동시간 순서 (7장 7.1.2): 직접 입력(요청의 값, 없으면 기존 약속에 저장된 `MANUAL` 값) → 카카오(대중교통 · 도보 · 자동차) → 같은 경로(300m) 실측 3건 이상 중앙값 `CACHED` → 좌표 직선거리 근사 `ESTIMATE`(`needs_confirmation`) → 직접 입력. 중앙값은 내 출발 · 도착 기록을 읽기만 하고 `CACHED`로 저장하지 않음 (D5). 길찾기 · 중앙값 · 근사는 모두 출발지 · 목적지 **좌표가 있어야** 해서, 좌표가 없으면 바로 마지막 단계(직접 입력)로 감
- 좌표가 없고 직접 입력도 없으면 오류 대신 **200** + `travel{ minutes: null, source: null, manual_required: true }` + `check{ ok: false, reason: "TRAVEL_REQUIRED" }` + `alarms: []`로 "이동시간을 직접 입력해 주세요"를 알림 (준비 · 강도 칸은 채워 줌, `warnings`에 `NO_COORDINATES`). 앱은 입력 칸을 보인 뒤 `participant.est_travel_minutes` + `travel_source: "MANUAL"`로 다시 부름. `alarm-commit`은 같은 상황에서 502 `ROUTE_UNAVAILABLE`(`details.manual_required`)을 그대로 돌려줌
- 키가 없으면 `warnings`에 `KAKAO_NOT_CONFIGURED`를 남기고 다음 단계로 넘어감
- 출발 시각까지 지났으면 `UNPROCESSABLE`(`details.suggestion`에 계산 결과), 기상 · 준비만 지났으면 그 알림을 `is_enabled: false` · `disabled_reason: PASSED`로 돌려줌 (8장 8.2.1: 지금 + 5분보다 앞이면). `warnings`의 `PAST_ALARM_DISABLED` 문구는 미리 보기라 "이미 지난 알림은 저장할 때 꺼져요", `alarm-commit` 응답은 "…끄고 저장했어요" (코드는 같음). 순서가 어긋나면 200 + `check.ok: false`
- `alarms[].is_enabled`는 저장될 값과 같음: 요청의 `enabled`가 먼저, 없으면 사용자가 H02에서 끈 상태를 유지 (같은 규칙을 `alarm-commit`이 씀)

### alarm-commit

요청 (5.4.2). 새 약속은 `appointment`, 기존 약속은 `appointment_id` (둘 다 쓰면 400 — 기존 약속의 제목 · 시각 · 장소는 못 고침, D41). 공동 약속은 멤버가 각자 `appointment_id`로 불러 자기 몫을 저장함.

```jsonc
{
  "appointment": { "title": "팀 주간회의", "appointment_at": "…+09:00", "destination": { "name": "…", "lat": 0, "lng": 0 },
                   "importance": "NORMAL", "recurrence_rule": "FREQ=WEEKLY;BYDAY=TH", "group_id": "uuid" },   // 새 약속 (rule · group_id 선택. rule은 FREQ=DAILY 또는 FREQ=WEEKLY;BYDAY=… 두 모양만)
  "appointment_id": "uuid",                  // 또는 기존 약속
  "participant": { "origin": {…}, "transport_type": "TRANSIT", "est_travel_minutes": 50, "travel_source": "API",   // API | MANUAL
                   "prepare_minutes": 60, "buffer_minutes": 10, "before_prepare_minutes": 30, "with_wake": true },
  "kinds": ["WAKE", "PREPARE", "DEPARTURE"], "enabled": {…}, "manual_times": {…}, "levels": {…},   // alarm-suggest와 같음
  "replace_existing": true,                  // 기본 true: 고르지 않은 종류의 옛 알람을 지움
  "edits": [{ "screen": "H05", "field": "scheduled_at", "alarm_type": "WAKE", "auto_value": "…", "edited_value": "…" }]   // user_edit_logs로. edited_value null = 자동으로 되돌림
}
```

- `est_travel_minutes` · `travel_source`를 보내면 그 값을 그대로 저장함 (미리 보기와 같은 시각). **직접 입력한 이동은 이어받음**: 이 칸이 없고 기존 약속에 저장된 `travel_source`가 `MANUAL`이면 저장된 `est_travel_minutes`를 `MANUAL`로 그대로 씀 (길찾기를 다시 안 부르고, 시각 · 강도의 직접 값과 같은 규칙. 미리 보기는 "자동으로 되돌리기" 값만 따로 구함). `API`로 저장된 값은 D5 때문에 이어받지 않고 다시 구함. 이 칸이 없고 이어받을 값도 없으면 서버가 `alarm-suggest`와 같은 순서로 구하고, `API`가 아닌 값(`CACHED` · `ESTIMATE`)이면 저장하지 않고 `ROUTE_UNAVAILABLE`(`details.fallback`)으로 돌려줌 → 사용자가 확인한 값을 `MANUAL`로 다시 보냄 (7장 7.1.2 단계 4, `CACHED`는 D5)
- 일정 없는 알람: `{ "type": "STANDALONE", "alarm": { "alarm_id"?, "scheduled_at", "recurrence_rule"?, "is_enabled"?, "levels"? } }` — 약속 · 루틴 없는 기상 알람 하나 (D46 · Q10 B). `alarm_id`가 있으면 고침. 이름은 `알람` 고정
- 응답: `appointment_id` · `participant_id` · `alarms[]` · **`ring_packages[]`**(알람 코어 `RingPackage` 그대로 — `alarmId · type · atMillis · title · subtitle · intensity · snoozeLimit · soundKey · vibration · departAt` (`soundKey` · `vibration`은 해석된 값을 늘 실음: `sound_key ?? 강도에서` · `vibration ?? 강도에서`) + 약속 알람은 `notice`(준비 · 출발 알림 한 줄) · `voiceText`(기상 음성 문장), 켜진 알람만. 문구 규칙은 `docs/alarm-core.md` "알림 문구") · **`canceled_alarm_ids[]`**(폰에서 `cancel()`할 id: 지워졌거나 꺼진 알람) · `warnings`
- 반복(D44)은 `appointments.recurrence_rule`에 저장하고 알람은 첫 회차만 만듦. 다음 회차는 `alarm-roll`이 14일치를 미리 만듦 (D4 A, 위 "반복 다음 회차" — `alarm-roll` 배포 전까지는 첫 회차만). 규칙은 `FREQ=DAILY` · `FREQ=WEEKLY;BYDAY=…` 두 모양만 받고 그 밖(MONTHLY · INTERVAL · COUNT …)은 400 `VALIDATION_FAILED`
- 트랜잭션이 아님: 약속 → 참여 조건 → 알람 → 고친 값 기록 순으로 쓰고, 이번 호출이 새로 만든 약속 · 참여 조건은 중간에 실패하면 지움. 같은 요청을 다시 보냈을 때 같은 상태가 되는 건 **기존 약속(`appointment_id`)일 때만** (고친 값 기록만 한 번 더 쌓임). 새 약속(`appointment`)은 응답만 잃고 다시 보내면 약속 · 알람이 두 벌 생기고, 일정 없는 알람도 `alarm_id` 없이 다시 보내면 하나 더 생김 (`Idempotency-Key` 같은 요청 키는 아직 안 받음)

### place-search · place-reverse · notify · wake-check

- `place-search`: `{ query, lat?, lng?, limit? }` → `{ places: [{ id, name, address, lat, lng, category? }] }`. 정확도순이고 `lat · lng`는 가까운 쪽으로 치우치게만 씀("…역"이면 지하철역이 맨 위, 같은 이름의 여러 지점은 가까운 순)
- `place-reverse`: `{ lat, lng }`(필수) → `{ place: { address, roadAddress, buildingName } | null }`. `address`는 도로명이 있으면 도로명, 없으면 지번. 주소가 없는 곳(바다 · 국외)은 `place: null`. 카카오 응답은 저장하지 않고 좌표도 로그에 안 남김. 비밀값은 `place-search`와 같은 `KAKAO_REST_API_KEY`
- `notify`: `{ kind, targetUserId?, groupId?, appointmentId?, alarmId?, previousAt?, newAt? }` → `{ sent, failed, reason? }`. `kind`는 한 사람에게(`targetUserId`) `WAKE_PING`(G03 깨우기 — `groupId`도 받음(어느 그룹 화면에서 눌렀는지, 그 그룹에서 보일 때만 되고, 푸시를 받은 사람이 누르면 자기 기상 확인 화면 `/wake`(H08, 8-02)로 감 — 보낸 사람이 본 그룹 화면으로 가지 않음). 기상이 보이는 사람에게만, 아니면 403. 응답에 `ping: { status, count?, limit?, next_at?, resets_at? }`가 더해짐: `OK`(보냄) · `NOT_RINGING` · `ALREADY_UP` · `WAIT` · `DAILY_LIMIT` · `OFF` · `NO_TOKENS`(횟수 안 셈 — 토큰이 없거나 센 뒤 푸시가 한 건도 못 나가 되돌렸을 때). 순서는 판정(`plan_wake_ping`, 권한 포함) → 토큰 확인 → 횟수 세기 → 발송이고 `OK`가 아니면 푸시가 안 나감) · `ALARM_CHANGED`(G04 — 방금 보낸 대기 중 제안이 있을 때만, 문구의 시각은 그 제안 기록에서; `alarmId`가 있으면 그 제안으로 좁힘) · `FRIEND_REQUEST` · `FRIEND_ACCEPTED`, 그룹에(`groupId`만 — 받는 사람은 서버가 고름) `GROUP_MEMBER_JOINED` · `GROUP_APPT_CHANGED`(+ `appointmentId`). 제목 · 본문 · 알림 데이터는 서버가 종류별로 정하고 (옛 앱이 보낸 `title` · `body` · `data`는 무시) 알림 데이터에 `kind` · `recipientUserId`(앱이 계정 대조) · `path`가 실림. 안드로이드 채널은 `friend_v1` · `alarm_change_v1` · `request_v1` · `group_v1` · `missed_v1`. Expo가 안 될 때는 한 번 더 보내 보고, 접수 번호는 `push_tickets`에 남겨 15분 뒤 `wake-check`가 영수증을 확인. 토큰이 없으면 `{ sent: 0, reason: 'NO_TOKENS' }`. 권한 판정(`can_send_push`, 깨우기는 `plan_wake_ping`)이 먼저라 없는 · 탈퇴한 · 권한 없는 · 차단된 대상은 모두 같은 403(사용자 존재 여부를 응답으로 알 수 없음, 형식이 틀린 id만 400). `alarmId`는 `ALARM_CHANGED`에서만 읽음. 보내지 못한 이유(`reason`)와 영수증의 기타 오류는 서버 로그(`console.error`)에도 남음. 푸시 설정이 없으면 `PUSH_NOT_CONFIGURED`, Expo 장애면 `PUSH_UNAVAILABLE`(요청 자체는 성공)
- `wake-check`: 서비스 키만. `find_missed_wake_alarms` 결과를 `alarm_events`에 `MISSED`로 기록 (`client_event_id = event_key`, `ON CONFLICT DO NOTHING`이라 두 번 안 들어감). 응답 `{ checked, recorded, pushed, claimed, nudged }`(`pushed` = 본인 알림을 받은 기기 수, `claimed` = 이번에 친구 알림 대상으로 정한 (받는 사람, 안 일어난 사람) 쌍 수, `nudged` = 친구 알림을 받은 기기 수 — `claimed`보다 적으면 토큰이 없거나 전송이 실패한 몫이라 로그에 남고, 기록이 먼저라 다시 보내지는 않음). 새로 기록된 미확인의 주인에게 본인 알림('기상 확인 / 기상 확인이 안 됐어요', `missed_v1`)을 보내고, 매번 `claim_wake_nudges`가 정한 받는 사람에게 친구 알림('깨워 볼까요? / ○○님이 아직 안 일어났어요', 후속 '일어났어요 / ○○님이 일어났어요' — `friend_v1`, 눌러 `/group`, 알림 데이터에 `groupId` · `subjectUserId`)을 보냄. 받는 사람은 DB가 정하고 그 기록이 보내기보다 먼저라 배치가 겹쳐도 한 번만 나가고, 푸시가 실패해도 MISSED 기록은 그대로 성공(서버 로그에만). 같은 배치에서 푸시 영수증도 확인(응답에 `receipts: { checked, tokensRemoved, expired }`) — 앱이 지워진 기기의 토큰(`DeviceNotRegistered`)을 `push_tokens`에서 지우고 `push_tickets`를 정리(영수증이 없으면 24시간 뒤 포기)

### 공용 계산 (`functions/_shared/calc/`)

기상 시각 역산 · 강도 · 준비 P80 · 순서 확인 · 저장 검증 · 이동시간 폴백 계산 · 반복 규칙 읽기 · 다음 회차 날짜(`recur.ts`: 두 모양만, 요일은 내 시간대 날짜 기준, 창 지금 ~ 14일) · 출발 여유(`departSlack` · `departNow`: 약속 − 이동으로 구한 출발 한계와 지금 + 남은 준비를 비교해 여유 · 빠듯 · 지각 위험, 7장 7.5.2. 출발 알림 글자의 도착 · 여유도 이 계산) · 그날 첫 일정 판정(`hasEarlierWake`: 약속 시각이 이 약속보다 앞선 같은 날 약속에 켜진 기상 알람이 있으면 이 약속은 기상 없이 준비부터. 알람이 울리는 시각이 아니라 약속 시각 기준이고, 같은 시각 두 약속은 둘 다 기상을 가짐) · 알람 조정 제안(`suggest.ts` `suggestPrepareAdvance`: 최근 3번 준비가 예측보다 길면 준비 알람을 5분 단위로 당김, 준비 전 시간이 모자라면 그만큼 기상도. 아직 부르는 곳 없음 — #49) · 저녁 기상 예외(`isEveningWake`: 첫 일정이어도 계산된 기상 시각이 내 시간대 낮 12시 이후면 기상 알람 없이 준비 · 출발 · 도착만, 12:00 정각은 이후. `with_wake` 직접 지정 · 직접 고른 기상 시각은 존중. #320). Deno · Node API를 안 쓰는 순수 TS고 import는 상대 경로 + `.ts`라서 앱(P6)이 경로 별칭으로 같은 파일을 가져다 씀 (앱 `tsconfig`에 `allowImportingTsExtensions`, Metro에 `watchFolders` 필요). 규칙은 앱 목업 계산(`mobile/src/mocks/calc.ts` · `features/alarm/adjust.ts`)을 그대로 옮김 — 문서(4장 · 7장)와 다른 곳(낮은 중요도 강도 · 도착 알람 시각 · 준비시간 · 7장의 개인 보정 ±30분 / 예측 15~240분 clamp)은 D56이 정할 때까지 목업을 따름 — 앱이 이 계산을 그대로 가져다 쓰므로 목업과 한 줄도 다르면 안 됨.

### 시험

Deno 없이 Node(24 이상)가 `.ts`를 바로 읽어서 `node --test`로 돌림 (계산 · 요청 검사 · 오류 · 카카오 응답 읽기 · 이동시간 순서 · 푸시 · 저장 내용 정하기 · `alarm-commit`의 쓰기 순서와 되돌리기 · `notify`(권한 거절 · 허용 · 만료 토큰) · `wake-check`(MISSED 중복 무시 · 이름 인자) · 같은 초안의 미리 보기 = 저장 대조는 메모리 가짜 DB `fake-db.ts`로 — `rpc` · `upsert`도 흉내).

```bash
# 레포 맨 위에서
node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "supabase/functions/**/*.test.ts"
```

- 가짜 DB는 쿼리 빌더의 모양만 흉내 내서, 진짜 PostgREST에서의 동작(임베드 `!inner`, 뷰 조회, `upsert … RETURNING`)과 `index.ts`의 연결(로그인 확인 · `Deno.serve`)은 이 시험에 안 들어감. Docker · Deno가 생기면 `supabase functions serve` + 로컬 DB로 확인할 것
- `deno check`는 이 PC에 Deno가 없어 못 돌림. 대신 `tsc --strict`로 `functions/**` 전체(Deno 전역 · `npm:` · `jsr:` 지정자는 임시 선언으로 대체)를 타입 검사해 통과함
- 시험 수 (10/29 반복 다음 회차 3a-1 기준): node 시험 229개(`calc/recur.test.ts` 23 · `tz.test.ts` 4 새로 늘림) · DB 검사 111줄(`supabase/tests`, 마이그레이션 적용 11줄 포함, 반복 다음 회차 새 묶음 10항목)

### 배포 (터미널, Actions 안 씀)

처음 한 번: `npx supabase@2.119.0 login`(또는 `SUPABASE_ACCESS_TOKEN` 환경 변수). 비밀값 먼저 (`functions/.env.example` 참고):

```bash
npx supabase@2.119.0 secrets set KAKAO_REST_API_KEY=<키> --project-ref gomrhctwjvttoqifxktt
npx supabase@2.119.0 secrets set EXPO_ACCESS_TOKEN=<토큰> --project-ref gomrhctwjvttoqifxktt   # 선택
```

함수는 하나씩 (Docker 없이 서버에서 묶는 `--use-api`):

```bash
npx supabase@2.119.0 functions deploy alarm-suggest --project-ref gomrhctwjvttoqifxktt --use-api
npx supabase@2.119.0 functions deploy alarm-commit  --project-ref gomrhctwjvttoqifxktt --use-api
npx supabase@2.119.0 functions deploy place-search  --project-ref gomrhctwjvttoqifxktt --use-api
npx supabase@2.119.0 functions deploy place-reverse --project-ref gomrhctwjvttoqifxktt --use-api
npx supabase@2.119.0 functions deploy notify        --project-ref gomrhctwjvttoqifxktt --use-api
npx supabase@2.119.0 functions deploy wake-check    --project-ref gomrhctwjvttoqifxktt --use-api
npx supabase@2.119.0 functions deploy alarm-roll    --project-ref gomrhctwjvttoqifxktt --use-api   # 앱 맞추기(3b) 머지 뒤에. appointment_edit 마이그레이션 적용 뒤에 다시 배포
npx supabase@2.119.0 functions deploy account-delete --project-ref gomrhctwjvttoqifxktt --use-api   # friend_account_delete 마이그레이션 적용 뒤에 (그 전에는 prepare_account_delete가 없어 500)
npx supabase@2.119.0 functions deploy appointment-edit --project-ref gomrhctwjvttoqifxktt --use-api   # appointment_edit 마이그레이션 적용 뒤에
npx supabase@2.119.0 functions deploy timetable-extract --project-ref gomrhctwjvttoqifxktt --use-api   # ai_calls_point_timetable 마이그레이션 적용 뒤에 — 먼저 배포하면 호출 기록(TT)이 제약에 걸려 안 쌓이고 하루 한도가 풀림
```

- `verify_jwt`는 `config.toml`의 `[functions.<이름>]`이 정함 (`wake-check` · `alarm-roll` · `suggestion-generate`만 끔). 배포 때 따라감
- `_shared/`는 함수 폴더 밖이어도 상대 import라 같이 묶임. 공용 파일을 고치면 쓰는 함수를 다시 배포해야 함
- 배치 키(Vault `project_url` · `service_role_key`)를 만든 뒤 `wake-check`를 배포하면 5분마다 돔. 배포 전에는 404가 나도 정상 ("배치"). `alarm-roll`도 같지만 **앱 맞추기(3b) 머지 뒤에 배포**함

### 확인 못 한 것 (이 PC에 Deno · Docker · 카카오 키가 없음)

- Deno에서 `deno check` · 실제 배포 · `Deno.serve` 동작 (타입은 tsc로 확인, 실행은 못 함)
- 카카오 응답이 공식 문서 모양과 같은지 — 대중교통 · 도보 · 로컬은 2026-10-15 공식 문서(카카오 디벨로퍼스 카카오맵 REST API)에 맞춰 만들었고, 자동차 길찾기(`summary.duration` 단위)는 문서를 못 열어 샘플 값(초)으로 읽음. 키가 오면 한 번 불러서 `kakao-parse.ts` 샘플과 대조
- PostgREST 임베드(`appointment_participants!inner(...)`, 그날 첫 일정 판정의 `appointments!inner` · `alarms!inner` + 임베드 칸 필터), `upsert(..., ignoreDuplicates)` 같은 supabase-js 호출이 실제 DB에서 도는지 (DB 함수 · 시드 데이터는 PGlite로 확인함)
- Expo Push 응답 처리, 카카오 키 권한(카카오맵 사용 설정 · 자동차 길찾기 권한)

## 데모 시드 (`seed/`)

로컬 `.env`의 서비스 키로 이메일 데모 계정 4명 + 친구 · 그룹 · 약속 · 알람 · 지난 4주 기록을 넣거나 지움 (#100). Node 24 이상.

```bash
cd supabase/seed
npm ci
cp .env.example .env          # SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · SEED_PASSWORD 채움, SEED_PROJECT_REF는 예시 그대로 (깃에 안 올라감)
npm run seed:demo -- --dry-run    # 네트워크 없이 넣을 개수만 보기
npm run seed:demo -- --yes        # 기존 데모 계정을 지우고 다시 넣음. 어느 프로젝트인지 출력하고 SEED_PROJECT_REF와 맞는지 확인한 뒤 실행
npm run seed:reset -- --yes       # 데모 계정만 지움 (그 계정의 모든 데이터가 CASCADE로 같이 지워짐)
npm test                          # 데이터 모양 확인 (제약 · 외래키 · 상황) + 프로젝트 ref 확인
```

- 프로젝트 확인: `.env`의 `SEED_PROJECT_REF`(주소 `https://<ref>.supabase.co`의 `<ref>`, `.env.example`에 dev 프로젝트 값이 들어 있음)가 `SUPABASE_URL`의 ref와 다르면 `--yes`가 있어도 아무것도 하기 전에 멈춤. 값을 비우면 확인하지 않고 프로젝트를 보여 주기만 함 (이때도 `--yes` 필요)
- 계정: `demo-me` · `demo-suyeon` · `demo-jihyeong` · `demo-junseong` `@example.com` (비밀번호 = `SEED_PASSWORD`). 이메일 로그인이 켜져 있어야 로그인됨 (Auth Providers)
- 로그인 설정은 그대로 둠: 이메일 공급자만 켬(10/27 켜짐), 전체 가입 스위치는 끄지 않음(끄면 구글 · 카카오 첫 로그인도 막힘), Confirm email은 켜 둠(공개 키로 가입해도 메일 확인 전엔 못 씀 — 시드 계정은 서버 키로 만들어 상관없음). 10/27 `/auth/v1/settings`: `disable_signup` false · `mailer_autoconfirm` false
- 오늘(D57): 지형이 만든 그룹 `캡스톤팀`(기상 공유 동의: 나 · 수연 · 지형 켬, 준성 끔)의 `팀 주간회의` 10시 + 나의 저녁약속 · 알람 없는 치과 예약 · 내일 수업 · 일정 없는 평일 기상 알람
- 나의 지난 4주: 생활 기록 28일 + 평일 20일의 약속 · 알람 · 울림 기록(지난 회차에는 반복 규칙을 달지 않음 — 반복 일정은 앞으로 올 두 건뿐), 늦잠 지각 3번 (`v_prepare_time_stats`에 20건, 최근 4주 지각 3회 → 자동 강도 한 단계 위)
- 알람 시각은 서버 함수와 같은 `_shared/calc`로 만들어 서버 계산과 같은 숫자. 날짜는 한국 시각 오늘 기준 (`--date YYYY-MM-DD`로 바꿈)
- 나의 오늘 기상 알람 시각이 지난 뒤에 시드하면 다음 `wake-check`가 그 알람을 `MISSED`로 기록함 (실제 동작과 같음)
- 알람 조정 제안(`alarm_suggestions`, "늦잠 지각 3번 → 10분 앞당김")은 시각 조정 종류가 enum에 없어(D6) 안 넣음
