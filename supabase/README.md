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
- `wake-check`는 `config.toml`에서 `verify_jwt = false`로 두고, 코드(`_shared/auth.ts` `requireServiceCall`)가 `apikey` · `Authorization` 머리글의 키를 `SUPABASE_SERVICE_ROLE_KEY`(legacy JWT) 또는 `SUPABASE_SECRET_KEYS`(`sb_secret_…`)와 직접 비교함 → Vault에 어느 형식을 넣어도 됨

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

## 서버 함수 (Edge Functions)

`functions/<이름>/index.ts`. 앱은 `supabase.functions.invoke('<이름>', { body })`로 부름 (로그인 토큰이 자동으로 실림). 계산 · 외부 API(카카오 · Expo) · 여러 테이블을 한 번에 쓰는 일만 함수로 하고 나머지는 앱이 DB에 직접 함 (`docs/screen-data-map.md`).

| 함수 | 하는 일 | 부르는 곳 | `verify_jwt` | 외부 |
|---|---|---|---|---|
| `alarm-suggest` | 이동시간 · 기상 · 준비 · 출발 · 도착 시각 · 강도 미리 보기 (DB에 안 씀) | 앱 H05 · H03 | 켬 | 카카오 길찾기 |
| `alarm-commit` | 약속 · 참여 조건 · 알람을 한 번에 저장 → 예약 꾸러미 + 취소할 알람 id. 일정 없는 알람도 여기서 만듦 | 앱 H05 · H03 · S01 | 켬 | 카카오 길찾기 |
| `place-search` | 장소 검색 | 앱 H05 · 온보딩 | 켬 | 카카오 로컬 |
| `notify` | 다른 사람 폰에 푸시 (권한은 `can_send_push`) | 앱 G04 · G03 | 켬 | Expo Push |
| `wake-check` | 기상 미확인(MISSED) 기록 | pg_cron 5분마다 (서비스 키) | 끔 (코드에서 키 비교) | — |

공통 틀은 `functions/_shared/`: `http.ts`(CORS · `X-Request-Id` · 오류) · `auth.ts` · `read.ts`(요청 검사) · `supabase.ts` · `env.ts`. 계산은 `_shared/calc/` ("공용 계산").

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
| 502 | `ROUTE_UNAVAILABLE` | 이동시간을 구할 길이 없음. `details.manual_required` = 직접 입력으로 이어 가기. `alarm-commit`은 `details.fallback`에 근사값 · 실측 중앙값을 줌 |
| 502 | `PLACE_UNAVAILABLE` | 장소 검색 API 장애 |
| 503 | `NOT_CONFIGURED` | 비밀값이 아직 없음 (카카오 키 등) |

5.2.1 표에 없는 `METHOD_NOT_ALLOWED` · `PLACE_UNAVAILABLE` · `NOT_CONFIGURED`만 더함. 시각은 ISO 8601 + 오프셋. `Idempotency-Key`(5.2)는 아직 안 받음.

### alarm-suggest

요청 (5.4.1). `appointment_id`가 있으면 시각 · 장소 · 중요도는 DB 값을 쓰고 요청 값은 읽지 않음 (D41).

```jsonc
{
  "appointment_id": "uuid",                  // 선택: 기존 약속 기준 (H03)
  "appointment_at": "2026-10-20T10:00:00+09:00",   // 새 일정이면 필수
  "destination": { "name": "세종대학교", "lat": 37.55, "lng": 127.07 },   // 새 일정이면 필수, 좌표는 선택(없으면 길찾기를 못 함)
  "origin": { "name": "집", "lat": 37.5, "lng": 127.0 },   // 없으면 저장된 출발지 → 프로필 집
  "transport_type": "TRANSIT", "importance": "NORMAL", "buffer_minutes": 10,
  "travel_minutes_override": 70,             // 직접 입력한 이동 → source MANUAL
  "prepare_minutes_override": 40,            // 직접 고른 준비(기상~출발)
  "before_prepare_minutes": 20, "with_wake": true,   // 선택: 기상 뒤 준비 전 활동 / 그날 첫 일정 여부 (없으면 서버가 정함)
  "kinds": ["WAKE", "PREPARE", "DEPARTURE"], // 선택: 만들 알람 종류. 없으면 지금 있는 종류(없으면 전부), [] = 알람 없는 일정
  "enabled": { "WAKE": true },               // 선택: 종류별 켜기 · 끄기
  "manual_times": { "WAKE": "2026-10-20T07:30:00+09:00", "PREPARE": null },   // 직접 고른 알람 시각. 이 칸이 없으면 저장된 직접 값 유지, null = 자동으로 되돌림
  "levels": { "sound": 0, "voice": null, "vibration": 2 }   // 직접 고른 강도 단계(0 약 · 1 중 · 2 강). 이 칸이 없으면 저장된 직접 값 유지
}
```

응답: `appointment_at` · `wake_at` · `prepare_at` · `departure_at` · `arrive_at` · `alarms[{ alarm_type, scheduled_at, auto_scheduled_at, time_source, is_enabled, disabled_reason }]` · `check{ ok, reason? }` · `travel{ minutes, source(API · CACHED · ESTIMATE · MANUAL), needs_confirmation, auto_minutes, note, sample_count }` · `prepare{ minutes, auto_minutes, source, common_p80, correction, sample_count, prior, weight, residual_p80, before_prepare_minutes }` · `intensity{ level, voice_tone, sound_key, source, reason, auto_level, axes }` · `with_wake` · `confidence` · `warnings[{ code, message }]`.

- 이동시간 순서 (7장 7.1.2): 직접 입력 → 카카오(대중교통 · 도보 · 자동차) → 같은 경로(300m) 실측 3건 이상 중앙값 `CACHED` → 좌표 직선거리 근사 `ESTIMATE`(`needs_confirmation`) → 없으면 `ROUTE_UNAVAILABLE`. 중앙값은 내 출발 · 도착 기록을 읽기만 하고 `CACHED`로 저장하지 않음 (D5)
- 키가 없으면 `warnings`에 `KAKAO_NOT_CONFIGURED`를 남기고 다음 단계로 넘어감
- 출발 시각까지 지났으면 `UNPROCESSABLE`(`details.suggestion`에 계산 결과), 기상 · 준비만 지났으면 그 알림을 `is_enabled: false` · `disabled_reason: PASSED`로 돌려줌 (8장 8.2.1: 지금 + 5분보다 앞이면). 순서가 어긋나면 200 + `check.ok: false`

### alarm-commit

요청 (5.4.2). 새 약속은 `appointment`, 기존 약속은 `appointment_id` (둘 다 쓰면 400 — 기존 약속의 제목 · 시각 · 장소는 못 고침, D41). 공동 약속은 멤버가 각자 `appointment_id`로 불러 자기 몫을 저장함.

```jsonc
{
  "appointment": { "title": "팀 주간회의", "appointment_at": "…+09:00", "destination": { "name": "…", "lat": 0, "lng": 0 },
                   "importance": "NORMAL", "recurrence_rule": "FREQ=WEEKLY;BYDAY=TH", "group_id": "uuid" },   // 새 약속 (rule · group_id 선택)
  "appointment_id": "uuid",                  // 또는 기존 약속
  "participant": { "origin": {…}, "transport_type": "TRANSIT", "est_travel_minutes": 50, "travel_source": "API",   // API | MANUAL
                   "prepare_minutes": 60, "buffer_minutes": 10, "before_prepare_minutes": 30, "with_wake": true },
  "kinds": ["WAKE", "PREPARE", "DEPARTURE"], "enabled": {…}, "manual_times": {…}, "levels": {…},   // alarm-suggest와 같음
  "replace_existing": true,                  // 기본 true: 고르지 않은 종류의 옛 알람을 지움
  "edits": [{ "screen": "H05", "field": "scheduled_at", "alarm_type": "WAKE", "auto_value": "…", "edited_value": "…" }]   // user_edit_logs로. edited_value null = 자동으로 되돌림
}
```

- `est_travel_minutes` · `travel_source`를 보내면 그 값을 그대로 저장함 (미리 보기와 같은 시각). 없으면 서버가 `alarm-suggest`와 같은 순서로 구하고, `API`가 아닌 값(`CACHED` · `ESTIMATE`)이면 저장하지 않고 `ROUTE_UNAVAILABLE`(`details.fallback`)으로 돌려줌 → 사용자가 확인한 값을 `MANUAL`로 다시 보냄 (7장 7.1.2 단계 4, `CACHED`는 D5)
- 일정 없는 알람: `{ "type": "STANDALONE", "alarm": { "alarm_id"?, "scheduled_at", "recurrence_rule"?, "is_enabled"?, "levels"? } }` — 약속 · 루틴 없는 기상 알람 하나 (D46 · Q10 B). `alarm_id`가 있으면 고침. 이름은 `알람` 고정
- 응답: `appointment_id` · `participant_id` · `alarms[]` · **`ring_packages[]`**(알람 코어 `RingPackage` 그대로 — `alarmId · type · atMillis · title · subtitle · intensity · snoozeLimit · soundKey · departAt`, 켜진 알람만) · **`canceled_alarm_ids[]`**(폰에서 `cancel()`할 id: 지워졌거나 꺼진 알람) · `warnings`
- 반복(D44)은 `appointments.recurrence_rule`에 저장만 하고 알람은 첫 회차만 만듦 (D4)
- 트랜잭션이 아님: 약속 → 참여 조건 → 알람 → 고친 값 기록 순으로 쓰고, 이번 호출이 새로 만든 약속 · 참여 조건은 중간에 실패하면 지움. 같은 요청을 다시 보내면 같은 상태가 됨 (고친 값 기록만 한 번 더 쌓임)

### place-search · notify · wake-check

- `place-search`: `{ query, lat?, lng?, limit? }` → `{ places: [{ id, name, address, lat, lng, category? }] }`. `lat · lng`를 주면 가까운 순
- `notify`: `{ kind, targetUserId, alarmId?, title, body, data? }` → `{ sent, failed, reason? }`. `kind`는 `ALARM_CHANGED`(G04) · `WAKE_PING`(G03, D19까지 403). 권한은 `can_send_push`(DB 함수). 푸시 토큰이 없으면 `reason: "NO_TOKENS"`, FCM 키가 없으면 `reason: "PUSH_NOT_CONFIGURED"`, Expo 서버 장애면 `"PUSH_UNAVAILABLE"` — 오류가 아니라 `sent: 0`. 만료된 토큰(`DeviceNotRegistered`)은 `push_tokens`에서 지움
- `wake-check`: 서비스 키만. `find_missed_wake_alarms` 결과를 `alarm_events`에 `MISSED`로 기록 (`client_event_id = event_key`, `ON CONFLICT DO NOTHING`이라 두 번 안 들어감). 응답 `{ checked, recorded, pushed }`. 그룹 미확인 푸시는 `can_send_push('WAKE_MISSED')`가 거절하는 동안(D19) 안 보냄

### 공용 계산 (`functions/_shared/calc/`)

기상 시각 역산 · 강도 · 준비 P80 · 순서 확인 · 저장 검증 · 이동시간 폴백 계산. Deno · Node API를 안 쓰는 순수 TS고 import는 상대 경로 + `.ts`라서 앱(P6)이 경로 별칭으로 같은 파일을 가져다 씀 (앱 `tsconfig`에 `allowImportingTsExtensions`, Metro에 `watchFolders` 필요). 규칙은 앱 목업 계산(`mobile/src/mocks/calc.ts` · `features/alarm/adjust.ts`)을 그대로 옮김 — 문서(4장 · 7장)와 다른 곳(낮은 중요도 강도 · 도착 알람 시각 · 준비시간)은 D56이 정할 때까지 목업을 따름.

### 시험

Deno 없이 Node(24 이상)가 `.ts`를 바로 읽어서 순수 부분은 `node --test`로 돌림 (계산 · 요청 검사 · 오류 · 카카오 응답 읽기 · 이동시간 순서 · 푸시 · 저장 내용 정하기).

```bash
# 레포 맨 위에서
node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "supabase/functions/**/*.test.ts"
```

- DB를 부르는 부분(`plan.ts` · `index.ts`)은 이 시험에 안 들어감. Docker · Deno가 생기면 `supabase functions serve` + 로컬 DB로 확인할 것
- `deno check`는 이 PC에 Deno가 없어 못 돌림. 대신 `tsc --strict`로 `functions/**` 전체(Deno 전역 · `npm:` · `jsr:` 지정자는 임시 선언으로 대체)를 타입 검사해 통과함

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
npx supabase@2.119.0 functions deploy notify        --project-ref gomrhctwjvttoqifxktt --use-api
npx supabase@2.119.0 functions deploy wake-check    --project-ref gomrhctwjvttoqifxktt --use-api
```

- `verify_jwt`는 `config.toml`의 `[functions.<이름>]`이 정함 (`wake-check`만 끔). 배포 때 따라감
- `_shared/`는 함수 폴더 밖이어도 상대 import라 같이 묶임. 공용 파일을 고치면 쓰는 함수를 다시 배포해야 함
- 배치 키(Vault `project_url` · `service_role_key`)를 만든 뒤 `wake-check`를 배포하면 5분마다 돔. 배포 전에는 404가 나도 정상 ("배치")

### 확인 못 한 것 (이 PC에 Deno · Docker · 카카오 키가 없음)

- Deno에서 `deno check` · 실제 배포 · `Deno.serve` 동작 (타입은 tsc로 확인, 실행은 못 함)
- 카카오 응답이 공식 문서 모양과 같은지 — 대중교통 · 도보 · 로컬은 2026-10-15 공식 문서(카카오 디벨로퍼스 카카오맵 REST API)에 맞춰 만들었고, 자동차 길찾기(`summary.duration` 단위)는 문서를 못 열어 샘플 값(초)으로 읽음. 키가 오면 한 번 불러서 `kakao-parse.ts` 샘플과 대조
- PostgREST 임베드(`appointment_participants!inner(...)`), `upsert(..., ignoreDuplicates)` 같은 supabase-js 호출이 실제 DB에서 도는지 (DB 함수 · 시드 데이터는 PGlite로 확인함)
- Expo Push 응답 처리, 카카오 키 권한(카카오맵 사용 설정 · 자동차 길찾기 권한)

## 데모 시드 (`seed/`)

로컬 `.env`의 서비스 키로 이메일 데모 계정 4명 + 친구 · 그룹 · 약속 · 알람 · 지난 4주 기록을 넣거나 지움 (#100). Node 24 이상.

```bash
cd supabase/seed
npm ci
cp .env.example .env          # SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · SEED_PASSWORD 채움 (깃에 안 올라감)
npm run seed:demo -- --dry-run    # 네트워크 없이 넣을 개수만 보기
npm run seed:demo -- --yes        # 기존 데모 계정을 지우고 다시 넣음. 어느 프로젝트인지 출력한 뒤 실행
npm run seed:reset -- --yes       # 데모 계정만 지움 (그 계정의 모든 데이터가 CASCADE로 같이 지워짐)
npm test                          # 데이터 모양 확인 (제약 · 외래키 · 상황)
```

- 계정: `demo-me` · `demo-suyeon` · `demo-jihyeong` · `demo-junseong` `@example.com` (비밀번호 = `SEED_PASSWORD`). 이메일 로그인이 켜져 있어야 로그인됨 (Auth Providers)
- 오늘(D57): 지형이 만든 그룹 `캡스톤팀`(기상 공유 동의: 나 · 수연 · 지형 켬, 준성 끔)의 `팀 주간회의` 10시 + 나의 저녁약속 · 알람 없는 치과 예약 · 내일 수업 · 일정 없는 평일 기상 알람
- 나의 지난 4주: 생활 기록 28일 + 평일 20일의 약속 · 알람 · 울림 기록, 늦잠 지각 3번 (`v_prepare_time_stats`에 20건, 최근 4주 지각 3회 → 자동 강도 한 단계 위)
- 알람 시각은 서버 함수와 같은 `_shared/calc`로 만들어 서버 계산과 같은 숫자. 날짜는 한국 시각 오늘 기준 (`--date YYYY-MM-DD`로 바꿈)
- 나의 오늘 기상 알람 시각이 지난 뒤에 시드하면 다음 `wake-check`가 그 알람을 `MISSED`로 기록함 (실제 동작과 같음)
- 알람 조정 제안(`alarm_suggestions`, "늦잠 지각 3번 → 10분 앞당김")은 시각 조정 종류가 enum에 없어(D6) 안 넣음
