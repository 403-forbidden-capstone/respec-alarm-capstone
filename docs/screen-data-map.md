# 화면 ↔ 데이터 ↔ API

화면마다 무엇을 읽고 쓰는지, 어디로 부르는지 정리함. 목업 화면을 진짜 데이터로 바꿀 때 이 표를 따라감.

- 화면 기준: 클릭 목업 `mobile/public/mockup.html`의 화면 번호
- 데이터 기준: `supabase/migrations` (상세설계서 4장 이름 그대로)
- 앱에서 데이터는 `mobile/src/features/*/api.ts`에서만 부름 (지금은 목업 데이터, 하나씩 바꿈)

| 표기 | 뜻 |
|---|---|
| **DB** | 앱이 supabase-js로 바로 읽고 씀. 남의 데이터는 RLS가 막음 |
| **RPC** | DB 함수 호출 (`supabase.rpc`) — 공개 범위를 줄여서 줘야 할 때 |
| **Edge** | Edge Function — 계산, 외부 API(카카오 · Gemini · 푸시), 비밀 키가 필요할 때 |
| **폰** | 알람 코어(`@capstone/alarm-core`) · 알림 — 예약 · 울림은 폰에서만 |

## 화면 목록

| 번호 | 화면 | 경로 | 이슈 |
|---|---|---|---|
| H01 | 홈 | `(tabs)/index` | #30 |
| H02 | 알람 목록 | `alarms` | #30 |
| H03 | 알람 설정 | `alarm/[id]` | #30 · #32 |
| H05 | 새 일정 | `schedule/new` | #31 · #32 |
| H07 | 알람 울림 | 네이티브 화면 (알람 코어) | #33 |
| H08 | 기상 확인 | `wake` | #35 · #40 |
| F01 · G01 | 친구와 그룹 | `(tabs)/group` | #43 · #44 |
| F02 | 친구 권한 | `friends/[id]` | #44 |
| F03 | 공유 권한 설정 | `permissions` | #44 |
| G02 | 그룹 상세 | `groups/[id]` | #44 · #45 |
| G03 | 그룹원 기상 상태 | `groups/[id]/members/[userId]` | #45 |
| G04 | 공유받은 알람 | `friends/[id]/alarms` | #46 |
| A02 | AI 대화 | `(tabs)/ai` | #39 · #42 (AI 대기) |
| A03 | 하루 기록 · 일기 | `journal/[date]` | #48 (AI 대기) |
| A04 | 루틴 편집 | `routine/[id]` | #48 |
| R02 | 나의 기록 | `(tabs)/records` | #38 · #41 |
| S01 | 알람 조정 제안 | `suggestion/[id]` | #49 |
| — | 로그인 · 온보딩 · 권한 안내 · 설정 | `login` · `onboarding` · `settings` | #25 |

## 화면별 데이터

### H01 홈
- 다음 알람: `alarms`(내 것, 켜짐, 지금 이후 가장 이른 것) → `appointment_participants` → `appointments`(제목 · 장소 · 시각) — DB. 루틴 알람이면 `participant_id`가 NULL이라 `routines.title`을 씀
- 오늘 일정(저녁엔 내일): `appointment_participants`(나) + `appointments.appointment_at` 날짜 — DB
- 오늘 루틴 · 진행: `routines`(켜짐, 오늘 요일) + 오늘 `alarm_events` ACKNOWLEDGED(단계 알람) — DB
- 내일 준비물(저녁): `todos`(ITEM, 내일) 읽기 · 체크(`is_done` · `done_at`) — DB
- 제안 카드: `alarm_suggestions`(PENDING) — DB. `suppress_until`은 "이 시각 전엔 같은 종류 제안을 만들지 않음"이라 `suggestion-generate`에서만 봄
- 그룹 기상 요약: `get_group_wake_status(group_id)` — RPC

### H02 알람 목록
- 날짜별 알람: `alarms` + `appointment_participants` + `appointments` — DB
- 켜기 · 끄기: `alarms.is_enabled` — DB → 예약 취소 · 다시 예약 — 폰

### H03 알람 설정
- 연결 일정 · 이동 조건 · 준비 시간: `appointments` + `appointment_participants`(출발지 · 이동 수단 · 예상 이동 · 출처 · 준비 · 여유) — DB
- 예측 준비(P80) 근거: `v_prepare_time_stats` — DB
- 여유 시간을 바꾸면 다시 계산: `alarm-suggest` — Edge → 저장 `alarm-commit` — Edge → 다시 예약 — 폰
- 강도 직접 고르기: `alarms.intensity` · `voice_tone` · `sound_key` — DB → 다시 예약 — 폰

### H05 새 일정
- 장소 검색: `place-search`(카카오 키워드) — Edge
- 이동시간 · 알람 시각 · 강도 미리 보기: `alarm-suggest`(카카오 대중교통 포함) — Edge
- 저장: `appointments` + `appointment_participants` + `alarms` 4개(WAKE · PREPARE · DEPARTURE · ARRIVE)를 한 번에 `alarm-commit` — Edge, 준비물 `todos`(ITEM) — DB → 예약 — 폰

### H07 알람 울림
- 소리 · 강도 · 미루기 · 해제 — 폰
- 기록: `alarm_events` TRIGGERED · SNOOZED(`snooze_minutes`) · DISMISSED — DB (오프라인이면 폰에 보관 후 다시 보냄)
- 무음 알림 원탭("준비 시작" · "출발했어요" · "도착했어요"): `alarm_events` ACKNOWLEDGED(PREPARE · DEPARTURE) · ARRIVAL_CONFIRMED(ARRIVE) + `appointment_participants.departed_at` · `arrived_at` — DB. 도착 때 `is_late` · `late_minutes`(`arrived_at` − `appointment_at`)는 앱이 계산해 같이 저장. 지오펜스 자동 수집(#40) · 지각 판정(#41)도 같은 자리에 씀

### H08 기상 확인
- 판정(폰 사용 · 버튼) → `alarm_events` WAKE_CONFIRMED + `daily_records.wake_confirmed_at` — DB
- 확인 알림 원탭 → ACKNOWLEDGED — DB, 끝까지 안 깨면 MISSED 기록 + 미확인 푸시 — `wake-check` 배치(아래 표)

### F01 · G01 친구와 그룹
- 친구 목록: `friends`(ACCEPTED) + 이름 · 사진 `get_public_profiles` — DB · RPC
- 받은 요청: `friends`(PENDING, 받는 사람 = 나) — DB, 수락 → ACCEPTED — DB
- 아이디 검색 · 요청: `find_profile_by_handle` — RPC → `friends` PENDING 추가 — DB
- 그룹 목록 · 만들기: `groups` + `group_members`(JOINED) — DB (만든 사람은 자동 JOINED)
- 초대 코드로 참여: `join_group_by_invite_code` — RPC
- 오늘 기상 n명: `get_group_wake_status` — RPC

### F02 친구 권한
- 관계별 받은 권한: `sharing_permissions`(주는 사람 = 친구, 받는 사람 = 나, 출처 FRIEND · GROUP) — DB → 최종 = 항목별 OR (앱에서 합침)

### F03 공유 권한 설정
- 내가 주는 권한: `sharing_permissions`(주는 사람 = 나, 출처 = 고른 관계) `can_view_alarm` · `can_edit_alarm` · `can_view_wake` 저장 — DB
- 받은 권한 보기: `sharing_permissions`(받는 사람 = 나) — DB
- 설정 권한은 조회 권한이 있어야 실제로 고칠 수 있음 → 화면에서 설정을 켜면 조회도 같이 켬

### G02 그룹 상세
- 그룹 · 멤버: `groups` + `group_members` — DB, 기상 공유 동의 `wake_share_opt_in` — DB
- 연결 일정: `appointments`(`group_id`) — DB
- 멤버 기상 상태: `get_group_wake_status` — RPC
- 초대: `groups.invite_code` 공유, 다시 만들기 `regenerate_invite_code` — RPC

### G03 그룹원 기상 상태
- 오늘 기상 흐름: `get_group_wake_status` — RPC (기상 관련 값만, 준비 · 출발 · 도착은 본인만)
- 깨우기 알림: `notify` — Edge → `push_tokens`

### G04 공유받은 알람
- 친구 알람: `alarms`(주인 = 친구) — DB, 조회 권한은 RLS가 확인. 약속 제목 · 장소까지 보여 주려면 RPC 하나 더 필요(`appointments` RLS는 본인 · 그룹원만) — #46에서
- 설정 권한이면 켜기 · 끄기 · ±5분: `alarms` — DB → 주인에게 알림 `notify` — Edge → 주인 폰이 다시 예약. RLS는 설정 권한이면 강도 · 소리까지 허용하므로 ±5분 제한은 화면에서 지킴(#46에서 확정)

### A02 AI 대화 (AI 대기)
- 대화 기록: `conversation_sessions`(`transcript` · `extracted_data` · `apply_status`) — Edge
- 찾은 일정 · 준비물 저장: `appointments` · `todos` — Edge

### A03 하루 기록 · 일기 (AI 대기)
- 일기: `daily_journals`(AI 글 · 고친 글 · 코칭 · 격려 · 루틴 제안) 읽기 · 고치기 — DB, 만들기 — Edge
- 오늘의 사실: `alarm_events` · `appointment_participants`(출발 · 도착 · 지각) · `todos` — DB

### A04 루틴 편집
- 루틴: `routines`(이름 · 목표 · 요일 · 단계 `steps` · 켜짐) — DB
- 단계 알람: `alarms`(`routine_id` · `step_order`) — DB → 예약 — 폰

### R02 나의 기록
- 월간: `daily_records`(그 달) — DB
- 주간: `daily_records.wake_confirmed_at` + `appointment_participants.is_late` — DB → 평균 기상 · 목표 기상률은 앱에서 계산
- 일간: 설정값 `alarms` + 실제 `alarm_events` — DB

### S01 알람 조정 제안
- 제안: `alarm_suggestions`(PENDING) — DB
- 적용 · 직접 수정 · 무시: `status` · `result_value` · `responded_at` — DB, 시각이 바뀌면 `alarm-commit` — Edge → 다시 예약 — 폰
- 제안 만들기: `suggestion-generate`(매일 배치) — Edge

### 로그인 · 온보딩 · 설정 (#25)
- 로그인: Supabase Auth 카카오 · 구글 → 가입하면 `profiles` 자동 생성
- 온보딩: `profiles` 아이디(`handle`) · 집(`home_name` · `home_lat` · `home_lng`) · 기본 준비 · 여유 시간 · 이동 수단 — DB, 집 검색 `place-search` — Edge
- 권한 안내: 알림 · 정확한 알람 · 잠금화면 알람 화면 — 폰
- 푸시 토큰: 앱 켤 때 `register_push_token` — RPC

## Edge Function — 만들 것만

| 이름 | 하는 일 | 외부 | 화면 |
|---|---|---|---|
| `place-search` | 장소 검색 | 카카오 로컬 | H05 · 온보딩 |
| `alarm-suggest` | 이동시간 · 기상 · 준비 · 출발 · 도착 시각 · 강도 계산 (저장 안 함) | 카카오 대중교통 | H05 · H03 |
| `alarm-commit` | 약속 · 참여 조건 · 알람을 한 번에 저장 | — | H05 · H03 · S01 |
| `notify` | 다른 사람 폰에 푸시. 보내기 전에 권한 확인: G03은 같은 그룹 + `wake_share_opt_in`, G04는 `can_edit_alarm`일 때만 | Expo Push | G03 · G04 · 미확인 알림 |
| `wake-check` | 5분마다 기상 미확인 알람을 MISSED로 기록하고 미확인 푸시(`notify`) — pg_cron 배치 | — | H08 · G03 |
| `suggestion-generate` | 매일 03:00 제안 만들기, 반복 알람 다음 회차 메우기 (배치) | — | S01 |
| `voice-*` · `journal-*` | AI 대화 · 일기 | Gemini | A02 · A03 (AI 대기) |

나머지(목록 · 체크 · 권한 · 기록 화면)는 Edge 없이 DB · RPC로 함.

## 스키마에 더 필요한 것 (그 기능을 만들 때 마이그레이션)

| | 목업 | 지금 DB | 할 때 |
|---|---|---|---|
| 1 | S01 "다음 알람 10분 앞당김" | `alarm_suggestion_type`이 VOICE_TONE · SOUND · INTENSITY뿐 | #49에서 시각 조정 종류 추가 |
| 2 | H03 강도를 배경음 · 말소리 · 진동 따로 고름 | `intensity` 하나 + `voice_tone` · `sound_key`, 진동 칸 없음 | #29에서 축별로 둘지 정함 |
| 3 | G04 "변경 기록" | 저장 자리 없음 | 처음엔 주인에게 푸시만 |
| 4 | — | 카카오 응답은 저장 · 재사용 불가인데 `est_travel_minutes` · `travel_source` CACHED가 있음 | #27에서 계산에 쓴 값만 남기는지 정함 |
