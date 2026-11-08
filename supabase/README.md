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
- `wake-check`는 `config.toml`에서 `verify_jwt = false`로 두고, 코드(`_shared/auth.ts` `requireServiceCall`)가 `apikey` · `Authorization` 머리글의 키를 `SUPABASE_SERVICE_ROLE_KEY`(legacy JWT) 또는 `SUPABASE_SECRET_KEYS`(`sb_secret_…`)와 직접 비교함 → Vault에 어느 형식을 넣어도 됨

## 서버 함수가 쓰는 DB 함수 (service_role 전용)

앱(authenticated · anon)은 못 부름. 서버 함수가 `supabase.rpc(...)`로 부름.

| 함수 | 쓰는 곳 | 하는 일 |
|---|---|---|
| `can_send_push(sender, target, kind)` | `notify` | 푸시를 보내도 되는지. `ALARM_CHANGED`(G04)는 보내는 사람이 받는 사람 알람의 설정 권한(조회도 함께 가진 같은 권한 행, 친구 6장)을 가졌을 때만 true, `WAKE_PING`(G03 깨우기)은 D19 결정 뒤까지 false. 보내는 사람과 받는 사람이 차단 쌍이면(어느 쪽이 걸었든, 친구 4장) 종류와 상관없이 false |
| `find_missed_wake_alarms(p_now, p_lookback_hours)` | `wake-check` | 기상 미확인(MISSED)으로 기록할 알람 목록 (7장 7.9.2: 마지막으로 울리기 시작한 때 + 다시 울림 총 소요 + 30분. 총 소요는 첫 울림 시작부터 마지막 울림 끝까지로 약 11 · 보통 19 · 강 21분 — 알람 코어와 같은 끝난 뒤 간격 기준. 폰은 미루면 다시 울림 묶음을 처음부터 새로 시작하므로, 마지막 울림 시작 = 마지막 미루기 시각 + 미루기 시간(미루기가 없으면 알람 시각). 돌려주는 `snooze_minutes`는 미루기 합이라 참고용이고 `missed_at`은 이 합으로 구하지 않음). 기상 확인은 같은 사람의 `WAKE_CONFIRMED`(어느 기상 알람이든) 또는 `daily_records.wake_confirmed_at`이면 인정 — 그룹 현황판이 '기상'으로 세는 기준과 같음. 기록은 알람 시각 6시간 전 ~ 18시간 뒤만 봄. 돌려주는 `event_key`를 `alarm_events.client_event_id`로 넣고 `on conflict do nothing`하면 같은 알람이 두 번 기록되지 않음 |
| `roll_insert_occurrence(p_appointment, p_participant, p_alarms, p_items)` | `alarm-roll` (다음 PR) | 반복 회차 하나를 약속 · 참여 조건 · 알람 · 준비물(`todos` ITEM)까지 **한 트랜잭션**으로 씀. 같은 (만든 사람, 묶음, 날짜)가 이미 있으면 아무것도 안 쓰고 `null`(같은 요청 두 번 = 같은 결과), 새로 만들면 `appointment_id`. 넣는 칸은 `alarm-commit`(`_shared/commit.ts` persistAppointment)과 같고 (알람의 `vibration`은 `20261030200000_alarm_vibration.sql`부터 — 직접 고른 진동을 다음 회차가 이어받음) 약속에 `memo` · `dest_radius_m`만 더 이어받음. 입력은 jsonb(`series_id` · `occurrence_on` 필수) |
| `roll_due_series(p_now, p_limit)` | `alarm-roll` 배치 (다음 PR) | 회차를 넘길 후보 묶음 `(user_id, series_id, kind, template_id)`, 다음 회차가 급한 순 (정말 만들 날짜가 있는지는 `alarm-roll`이 다시 봄). `APPOINTMENT`: 묶음의 **기준 회차**(예외 아닌 회차 중 날짜가 가장 늦은 것, 없으면 이번만 고친 회차 중, 이번만 지운 회차는 기준이 아님)에 읽을 수 있는 `recurrence_rule`(두 모양)이 있고 개인 약속이며 **다음 회차** 시각이 `p_now + 14일` 앞(14일치가 차 있으면 안 줌) · 재시도 대기 아님(`roll_attempts.next_try_at`이 안 온 줄 없음) · 미뤄 둔 날짜의 재시도 때가 지났으면 창 밖이어도 포함. `STANDALONE`: 일정 없는 반복 알람(같은 기준). `ROUTINE`: 켜 둔 루틴(읽을 수 있는 요일)의 켜진 단계 알람 시각이 지난 것. 못 읽는 규칙 · 요일(예전 MONTHLY · INTERVAL 등)은 빼서 매번 앞자리를 차지하지 않게 |

앱(authenticated)이 부르는 DB 함수 추가분:

- `get_shared_alarm_appointments(p_owner_id)` (G04) — 조회 권한(친구 ∪ 그룹)을 받은 사람 알람의 약속 제목 · 장소 · 시각. 본인 알람과 약속 없는 알람(일정 없는 알람 · 루틴)은 안 나옴
- `get_group_wake_status`는 그 그룹에 그날 약속이 있을 때만 행을 줌 (D57)
- 친구 2장 아이디 · 찾기 (`20261108062757_friend_handle_search.sql`, 이슈 #366) — 새 함수는 jsonb `status`로 돌려주고 앱이 문구로 바꿈
  - `change_my_handle(p_handle)` — 아이디 바꾸기(`OK` · `SAME` · `INVALID` · `RESERVED` · `TAKEN` · `LIMIT`). `respec_`로 시작하는 아이디와 예약어 10개(admin · respec · support · help · official · system · root · operator · manager · null, 정확히 같을 때만)는 `RESERVED`. 30일 1번, 자동 아이디 첫 변경 · 온보딩 중 변경은 안 셈(`LIMIT` + `next_change_at`). 바꾸기 시도도 검색과 같은 1분 10회 + 하루 100회에 셈(`LIMIT` + `retry_after_seconds`). 앱이 `profiles.handle`을 직접 update하거나 채워진 `onboarded_at`을 바꾸면 42501(`onboarded_at`은 비어 있을 때 한 번 채우기만)
  - `search_by_handle(p_query)` — 아이디 정확 일치(`FOUND` · `SELF` · `NOT_FOUND` · `LIMIT`), 1분 10회 + 하루 100회(바꾸기 시도와 합쳐서). 차단 · 탈퇴 · 온보딩 전은 없는 아이디와 같은 응답. `find_profile_by_handle`은 이걸 거치는 옛 모양(앱이 옮기면 지움)
  - `search_related_by_name(p_query)` — 친구 · 같은 그룹 안 닉네임 부분 일치
  - `my_friend_link(p_renew)` · `open_friend_link(p_token)` — 친구 링크(7일, 다시 만들면 옛 링크 무효). 표 `friend_links` · 제한 기록 `rate_limit_events`는 서버 전용(정책 없음)
  - 가입하면 아이디가 `respec_` + 4자로 자동으로 생기고 빈 아이디는 채움(NOT NULL은 앱 타입이 옮긴 뒤). 닉네임은 앞뒤 공백(탭 · 줄바꿈 포함)을 떼고 1~30자, 가입 때 이름이 공백뿐이면 이메일 앞부분 · '사용자'
- 친구 3장 친구 관계 (`20261108180042_friend_relations.sql`, 이슈 #372) — 상태 값으로 돌려주고 앱이 문구로 바꿈. 푸시는 11장
  - `send_friend_request(p_target_id)`(`REQUESTED` · `ACCEPTED`(맞요청 자동 수락) · `ALREADY_REQUESTED` · `ALREADY_FRIEND` · `SELF` · `NOT_FOUND` · `LIMIT` · `FRIEND_LIMIT`) — 1분 10회 + 하루 50회(행을 만든 요청만, 취소해도 안 줄어듦), 친구 100명 상한
  - `accept_friend_request(p_requester_id)`(`ACCEPTED` · `ALREADY_FRIEND` · `GONE` · `FRIEND_LIMIT`) · `decline_friend_request(p_requester_id)`(`DECLINED` · `GONE`) · `cancel_friend_request(p_addressee_id)`(`CANCELED` · `GONE`) · `remove_friend(p_user_id)`(`REMOVED` · `GONE`) — 거절 · 취소 · 끊기는 행 삭제, 끊기는 친구 출처 권한만 지움
  - `friends` 상태는 대기 → 친구로만 바뀌고(수락 되돌리기 · 차단으로 바꾸기는 42501) 수락 시각은 서버가 넣음. 같은 사람이 끼는 동작은 사람별 잠금(`private.lock_friend_pair`)으로 한 줄씩. 받은 요청은 30일 뒤 5분 배치(`friend-requests-expire`)가 지움
  - 앱이 `friends`를 직접 insert · update · delete 하는 옛 길은 15장까지 열려 있고 그 길은 요청 제한 · 100명 상한을 안 거침
- 친구 4장 차단 · 신고 (`20261108181556_friend_blocks.sql`, 이슈 #375) — 상태 값으로 돌려줌
  - `block_user(p_user_id)`(`BLOCKED` · `ALREADY_BLOCKED` · `SELF` · `NOT_FOUND`) · `unblock_user(p_user_id)`(`UNBLOCKED` · `GONE`) · `my_blocks()` — 누구나 차단, 친구 끊김 + 양쪽 방향 대기 요청 삭제 + 두 사람 사이 공유 권한 삭제, 풀어도 친구 · 권한은 복구 안 됨. 표 `user_blocks`는 차단한 사람 본인만 읽고 쓰기는 함수로만
  - 차단 판정은 `private.is_blocked_pair` 한 곳: 검색 · 이름 검색 · 친구 링크 · 친구 요청이 없는 사람과 같은 응답, 권한 판정(`is_valid_permission_source`)이 끝나서 알람 조회 · 설정 · 기상 · 푸시(`can_send_push`)도 끊김, `get_public_profiles`는 같은 그룹의 차단 쌍에게 닉네임만(사진 · 아이디 `null`), `friends` 직접 insert는 없는 사람과 같은 외래 키 위반(23503)으로 거절
  - `submit_report(p_target_type, p_target_id, p_reason, p_note)`(`REPORTED` · `ALREADY_REPORTED` · `INVALID` · `SELF` · `NOT_FOUND`) — 같은 대상 하루 1번(신고하는 사람 시간대). 표 `reports`는 서버 전용(운영 화면용 조회 · 처리 함수는 '팀원 계정' 판별 방법이 정해진 뒤)
- 친구 5장 그룹 · 초대, 그룹장 없음 (`20261108183700_friend_groups.sql`, 이슈 #384) — 상태 값으로 돌려줌
  - `preview_group_by_code(p_code)`(`FOUND` · `NOT_FOUND` · `EXPIRED` · `LIMIT`) · `join_group(p_code, p_wake_share)`(`JOINED` · `ALREADY_JOINED` · `NOT_FOUND` · `EXPIRED` · `LIMIT` · `FULL` · `TOO_MANY_GROUPS`) — 코드는 공백 제거 · 대문자(O/0 보정 없음), 틀린 코드는 계정별 1시간 10번까지 기록(반환값이라 되돌려지지 않음)하고 막힌 동안은 맞는 코드도 `LIMIT`. 그룹 20명 · 한 사람 10개 상한은 그룹 잠금 → 사람 잠금으로 한 명씩 셈
  - `accept_group_invite(p_group_id, p_wake_share)` · `invite_to_group(p_group_id, p_user_id)`(친구 사이 · 차단 아님만) · `my_group_invites()`(초대 카드: 이름 · 인원 · 초대한 사람까지만) · `my_group_code(p_group_id)`(시트를 열 때 만료면 새 코드 + 7일)
  - 그룹장 없음: 이름 바꾸기(`groups` update) · `regenerate_invite_code` · 초대 · 내보내기(다른 사람의 `group_members` 행 삭제)는 참여 중 멤버 누구나, 그룹 삭제 길은 없음. 마지막 참여 멤버가 나가거나 탈퇴하면 그룹 · 공동 약속 · 초대 · 코드가 지워지고(각자 `daily_records`는 남음) 나가는 사람의 그 그룹 공동 약속 참여 · 알람도 지워짐. `groups.owner_id`는 '만든 사람' 기록(탈퇴하면 비어 있음)
  - 앱이 `group_members`를 직접 고칠 수 있는 건 나가기(`JOINED → LEFT`) · 기상 공유 동의 · 알림 끄기(`notifications_off`)뿐, 초대 수락 · 다시 참여는 함수로만(그 밖은 42501). 초대만 받은 사람은 `groups` · 멤버 목록 · 공개 프로필을 못 읽음
  - 초대 코드는 8자(0 O 1 I 뺀 글자표), 만료 칸 `groups.invite_code_expires_at`(마지막 발급 + 7일, 기존 그룹은 마이그레이션 시각 + 7일). 지금 앱이 쓰는 `join_group_by_invite_code`는 옛 모양으로 남김(실패는 예외라 틀린 코드 횟수는 못 셈)
  - 읽기 예외·상한 (1번째 리뷰 반영): 방금 만든 사람이 `insert ... returning`으로 돌려받을 수 있는 예외는 만든 시각 = 그 트랜잭션 시각일 때만(`created_at`은 트리거가 `now()`로 못 박고 못 바꿈) — 내보내진 · 나간 만든 사람은 새 코드를 못 읽음. 10개 상한은 앱이 직접 그룹을 만들 때도 참여 · 수락과 같은 사람 잠금을 건 채로 셈. 참여 · 수락은 그룹 행을 키 공유로 잡아 마지막 멤버가 나가며 그룹이 지워지는 일과 겹쳐도 `GONE` · `NOT_FOUND`
  - 앱 쪽 주의: 직접 만들기 한도는 `54000` 예외로 옴 · `my_group_invites`의 `invited_by` · `invited_by_nickname` · `invited_at`은 비어 있을 수 있음(마이그레이션 전 초대 행 · 초대한 사람 탈퇴, 생성 타입은 `string`). 12장 탈퇴 연쇄를 함수로 순회하면 그룹 번호 순서로 잠글 것(같은 그룹 여러 개에 함께 속한 두 사람이 반대 순서로 지우면 교착 가능)
- 친구 6장 공유 권한 (`20261108190500_friend_permissions.sql`, 이슈 #388)
  - `save_group_permissions(p_group_id, p_can_view_alarm, p_can_edit_alarm)` → `OK`(`saved` = 참여 중인 다른 멤버 수) · `NO_MEMBERS`(혼자인 그룹) · `NOT_FOUND`(참여 중 멤버가 아님) — 그룹 권한 저장을 함수 하나(한 트랜잭션)로: 참여 중 멤버 전원(나 빼고)에게 같은 값 한 벌, 설정을 켜면 조회도 켜짐, 값이 그대로여도 update가 실행되어 수정 시각이 새로 찍힘. 차단 쌍은 오류 없이 행만 안 쓰고 응답은 같은 모양. 그룹 잠금(5장)을 건 채로 일함
  - '설정이면 조회': `sharing_permissions`에 제약 `sharing_permissions_edit_needs_view`, 조회만 끄면(설정 값을 그대로 보내도) 트리거가 설정도 끔. 친구 출처 `can_view_wake`는 써 넣어도 꺼진 채 저장(F03 친구 스위치 3개 → 2개). 마이그레이션이 옛 행을 정리: 그룹 권한은 (준 사람, 그룹) 한 벌로 맞추고(멤버마다 값이 다르거나 일부 멤버 행이 없으면 모두 꺼짐), 설정만 켠 옛 행은 설정을 끔
  - 권한을 준 뒤 참여 중이 된 사람(코드 참여 · 초대 수락)에게는 이미 그 그룹에 조회를 준 멤버들의 조회 행만 자동으로 생김(설정은 준 사람이 다시 저장해야, 차단 쌍은 건너뜀)
  - `private.granted_owner_ids_for`는 이제 `VIEW_ALARM` · `EDIT_ALARM`만 — 설정은 조회를 함께 가진 같은 행만 인정(알림 판정 `can_send_push`도 이 집합을 그대로 써서 설정과 조회를 둘 다 봄). 알람 조회는 일정에 붙은 알람만(`alarms_select_shared`: 개인 일정 포함, 루틴 · 일정 없는 알람 제외) — 수정 정책은 조회 정책도 같이 통과해야 해서 따로 안 바꿈
  - 기상 보기는 권한 행 없이 그 그룹의 기상 공유 동의(`group_members.wake_share_opt_in`)로만: `get_group_wake_status`가 그룹마다 따로 판정(참여 중 멤버 · 차단 쌍 제외). `sharing_permissions.can_view_wake` 칸은 판정에 안 쓰임(칸 정리는 15장). 사람별 기상 숨기기는 7장
- `dev_reset_my_data()` (`20261030220000_dev_reset_my_data.sql`) — **개발용**. 부른 사람 본인의 시험 데이터(일정 · 알람 · 울림 기록 · 기록 · 일기 · AI 대화 · 고친 값 기록 · 제안)를 지우고 프로필을 온보딩 전으로 되돌림. 인자 없음 — `auth.uid()` 본인 줄만 건드림. 그룹 일정(`group_id` 있음, 그룹원 누구나 조회)과 다른 사람이 참여 중인 일정은 내 참여 행(과 내 알람)만 지우고 일정은 둠 — 일정째 지우는 건 내가 만든 개인 일정 중 혼자인 것뿐. 친구 · 그룹 · 공유 권한 · 푸시 토큰 · `ai_calls` · `user_questions`(AI 상한 · 질문 예산을 세는 기록) · 루틴 · 할 일은 그대로. 앱은 개발 화면(`/dev/screens`)에서만 부르고 출시 빌드에서는 안 부름

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

`alarm_events`는 본인만 읽을 수 있어서 남의 기상 기록은 Realtime으로 직접 못 받음 → 기상 기록이 들어오면 DB가 그룹 채널에 "새로 고침" 신호만 보내고, 받은 앱이 `get_group_wake_status`를 다시 부름 (권한은 그 함수가 봄).

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
| `notify` | 다른 사람 폰에 푸시 (권한은 `can_send_push`) | 앱 G04 · G03 | 켬 | Expo Push |
| `appointment-edit` | 일정 수정 · 삭제 (N6, D41): 한 번짜리와 반복의 **이번만 / 이후 모두** 고치기 · 지우기, 이번만 지운 회차 되돌리기, 공동 약속에서 나만 빠지기. 알람은 다시 계산해 `ring_packages` · `canceled_alarm_ids`를 `alarm-commit`과 같은 모양으로 돌려줌(앱이 `applyCommit`에 그대로). 7장 7.1.3: 앞 일정이 바뀌거나 지워지면 같은 날 다른 일정의 기상을 다시 판정. 요청 `{ action: UPDATE|DELETE|RESTORE|LEAVE, appointment_id, scope?: this|following, patch?, confirmed? }`. 이번만 고친 / 지운 회차는 `appointments.exception_kind`(EDITED / CANCELED)로 표시 — alarm-roll이 다시 안 만들고 기준 회차에서 뺌. **배포는 `20261030150000_appointment_edit.sql` 적용 뒤, `alarm-roll` 재배포도 같이** | 앱 H03 편집 시트 (4c 뒤) | 켬 | 카카오 길찾기 (장소를 바꿀 때) |
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
- `notify`: `{ kind, targetUserId, alarmId?, title, body, data? }` → `{ sent, failed, reason? }`. `kind`는 `ALARM_CHANGED`(G04) · `WAKE_PING`(G03, D19까지 403). 권한은 `can_send_push`(DB 함수). 푸시 토큰이 없으면 `reason: "NO_TOKENS"`, FCM 키가 없거나 `EXPO_ACCESS_TOKEN`이 틀려 Expo가 401 · 403을 주면 `reason: "PUSH_NOT_CONFIGURED"`, Expo 서버 장애면 `"PUSH_UNAVAILABLE"` — 오류가 아니라 `sent: 0`. 만료된 토큰(`DeviceNotRegistered`)은 `push_tokens`에서 지움
- `wake-check`: 서비스 키만. `find_missed_wake_alarms` 결과를 `alarm_events`에 `MISSED`로 기록 (`client_event_id = event_key`, `ON CONFLICT DO NOTHING`이라 두 번 안 들어감). 응답 `{ checked, recorded, pushed }`. 그룹 미확인 푸시는 D19가 정해질 때까지 안 보냄(`_shared/wake.ts`의 `PUSH_MISSED_TO_GROUP = false` — 그 전에는 구성원 조회도 `can_send_push` 호출도 안 함). D19 뒤에는 받을 사람 후보를 그룹 참여 구성원(사실)으로만 뽑고 보내도 되는지는 `can_send_push('WAKE_MISSED')` 하나에 맡김 (TS에서 권한 표를 다시 해석하지 않음)

### 공용 계산 (`functions/_shared/calc/`)

기상 시각 역산 · 강도 · 준비 P80 · 순서 확인 · 저장 검증 · 이동시간 폴백 계산 · 반복 규칙 읽기 · 다음 회차 날짜(`recur.ts`: 두 모양만, 요일은 내 시간대 날짜 기준, 창 지금 ~ 14일) · 출발 여유(`departSlack` · `departNow`: 약속 − 이동으로 구한 출발 한계와 지금 + 남은 준비를 비교해 여유 · 빠듯 · 지각 위험, 7장 7.5.2. 출발 알림 글자의 도착 · 여유도 이 계산) · 그날 첫 일정 판정(`hasEarlierWake`: 약속 시각이 이 약속보다 앞선 같은 날 약속에 켜진 기상 알람이 있으면 이 약속은 기상 없이 준비부터. 알람이 울리는 시각이 아니라 약속 시각 기준이고, 같은 시각 두 약속은 둘 다 기상을 가짐) · 저녁 기상 예외(`isEveningWake`: 첫 일정이어도 계산된 기상 시각이 내 시간대 낮 12시 이후면 기상 알람 없이 준비 · 출발 · 도착만, 12:00 정각은 이후. `with_wake` 직접 지정 · 직접 고른 기상 시각은 존중. #320). Deno · Node API를 안 쓰는 순수 TS고 import는 상대 경로 + `.ts`라서 앱(P6)이 경로 별칭으로 같은 파일을 가져다 씀 (앱 `tsconfig`에 `allowImportingTsExtensions`, Metro에 `watchFolders` 필요). 규칙은 앱 목업 계산(`mobile/src/mocks/calc.ts` · `features/alarm/adjust.ts`)을 그대로 옮김 — 문서(4장 · 7장)와 다른 곳(낮은 중요도 강도 · 도착 알람 시각 · 준비시간 · 7장의 개인 보정 ±30분 / 예측 15~240분 clamp)은 D56이 정할 때까지 목업을 따름 — 앱이 이 계산을 그대로 가져다 쓰므로 목업과 한 줄도 다르면 안 됨.

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
npx supabase@2.119.0 functions deploy appointment-edit --project-ref gomrhctwjvttoqifxktt --use-api   # appointment_edit 마이그레이션 적용 뒤에
npx supabase@2.119.0 functions deploy timetable-extract --project-ref gomrhctwjvttoqifxktt --use-api   # ai_calls_point_timetable 마이그레이션 적용 뒤에 — 먼저 배포하면 호출 기록(TT)이 제약에 걸려 안 쌓이고 하루 한도가 풀림
```

- `verify_jwt`는 `config.toml`의 `[functions.<이름>]`이 정함 (`wake-check` · `alarm-roll` 둘만 끔). 배포 때 따라감
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
