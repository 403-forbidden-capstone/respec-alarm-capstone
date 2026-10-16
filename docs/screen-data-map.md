# 화면 ↔ 데이터 ↔ API

화면마다 무엇을 읽고 쓰는지, 어디로 부르는지 정리함. 목업 화면을 진짜 데이터로 바꿀 때 이 표를 따라감.

- 화면 기준: 클릭 목업 `mobile/public/mockup.html`의 화면 번호
- 데이터 기준: `supabase/migrations` (상세설계서 4장 이름 그대로). (#160) 표시는 PR #160(DB 보완)에서 더하는 칸 · 표 · 함수 — 머지 전엔 아직 없음 (아래 "스키마에 더 필요한 것" 6)
- 앱에서 데이터는 `mobile/src/features/*/api.ts`에서만 부름 (지금은 목업 데이터, 하나씩 바꿈)
- 목업 데이터는 `mobile/src/mocks` (목업 기본 상태: 5월 22일 오전 7:55 · 10시 팀 주간회의). 화면 목록은 `/dev/screens`

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
| H07 | 알람 울림 | 네이티브 화면 (알람 코어). `ring`은 디자인 · 웹 미리 보기용 | #33 |
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
- 다음 알람: `alarms`(내 것, 켜짐, 지금 이후 가장 이른 것) → `appointment_participants` → `appointments`(제목 · 장소 · 시각) — DB. 루틴 알람이면 `participant_id`가 NULL이라 `routines.title`을 씀. 일정 없는 알람(D46)은 둘 다 NULL(#160) → 제목 "알람"
- 오늘 일정(저녁엔 내일): `appointment_participants`(나) + `appointments.appointment_at` 날짜 — DB
- 오늘 루틴 · 진행: `routines`(켜짐, 오늘 요일) + 오늘 `alarm_events` ACKNOWLEDGED(단계 알람) — DB
- 내일 준비물(저녁): `todos`(ITEM, 내일) 읽기 · 체크(`is_done` · `done_at`) — DB
- 제안 카드: `alarm_suggestions`(PENDING) — DB. `suppress_until`은 "이 시각 전엔 같은 종류 제안을 만들지 않음"이라 `suggestion-generate`에서만 봄
- 그룹 기상 요약: `get_group_wake_status(group_id)` — RPC. 그 그룹 일정이 있는 날만 (D57)

### H02 알람 목록
- 날짜별 알람: `alarms` + `appointment_participants` + `appointments` — DB
- 켜기 · 끄기: `alarms.is_enabled` — DB → 예약 취소 · 다시 예약 — 폰
- 일정 없는 알람(D46): 반복은 `alarms.recurrence_rule`(#160), 만들기는 `alarm-commit` — 입력 화면(목록 "+")은 새 UI

### H03 알람 설정
- 연결 일정 · 이동 조건 · 준비 시간: `appointments` + `appointment_participants`(출발지 · 이동 수단 · 예상 이동 · 출처 · 준비 · 여유) — DB. 출발지 · 이동 수단 · 예상 이동 · 준비 시간도 고침 (D42 C) → 다시 계산 `alarm-suggest` → 저장 `alarm-commit`
- 알람 시각 직접 고르기 (D42 C): `alarms.scheduled_at` + `time_source` MANUAL(#160), "자동으로 되돌리기" = AUTO. 강도도 같은 규칙(`intensity_source`, #160)
- 고친 값 기록 (D42 · D43): `user_edit_logs`(#160, 화면 · 칸 · 자동값 → 고친 값 · 시각) — DB, 다음 계산 · 제안의 개인화 입력
- 예측 준비(P80) 근거: `v_prepare_time_stats` — DB
- 여유 시간을 바꾸면 다시 계산: `alarm-suggest` — Edge → 저장 `alarm-commit` — Edge → 다시 예약 — 폰
- 강도 직접 고르기: `alarms.intensity` · `voice_tone` · `sound_key` — DB → 다시 예약 — 폰

### H05 새 일정
- 장소 검색: `place-search`(카카오 키워드) — Edge
- 이동시간 · 알람 시각 · 강도 미리 보기: `alarm-suggest`(카카오 대중교통 포함) — Edge
- 저장: `appointments` + `appointment_participants` + `alarms`("알람" 줄에서 고른 종류 — 기상 · 준비 · 출발, 다 끄면 알람 없는 일정, D46)를 한 번에 `alarm-commit` — Edge, 준비물 `todos`(ITEM) — DB → 예약 — 폰
- 반복: 요일 칩 · 매일 · 평일 → `appointments.recurrence_rule` RRULE (D44). 다음 회차 만들기는 D4
- 확인 시트에서 시각 고치기 (D43): 기상을 옮기면 나머지도 따라 움직이되 순서가 뒤집히면 막음, 고친 값은 `user_edit_logs`

### H07 알람 울림
- 소리 · 강도 · 미루기 · 해제 — 폰
- 기록: `alarm_events` TRIGGERED · SNOOZED(`snooze_minutes`) · DISMISSED — DB (오프라인이면 폰에 보관 후 다시 보냄). 기록마다 앱이 만든 번호 `client_event_id`(유니크 — 같으면 무시) · 출처 `input_source` (둘 다 #160)
- 무음 알림 원탭("준비 시작" · "출발했어요" · "도착했어요"): `alarm_events` ACKNOWLEDGED(PREPARE · DEPARTURE) · ARRIVAL_CONFIRMED(ARRIVE) + `appointment_participants.departed_at` · `arrived_at` — DB. 지각 판정 (D58 · #41): 약속 +5분 넘으면 지각(`is_late` · `late_minutes`), −2~+5분은 원탭으로 확인. 위치를 끈 사용자는 원탭 기준, 지오펜스 자동 수집(#40)은 나중에 같은 자리에 씀

### H08 기상 확인
- 판정(폰 사용 · 버튼) → `alarm_events` WAKE_CONFIRMED + `daily_records.wake_confirmed_at` — DB
- 확정 시각 = 해제 뒤 누적 화면 사용이 θ를 넘은 시각 (D14) — 판정은 관찰 10분이 끝나야 되고 기록만 그 시각으로 남김. 확인 알림에 직접 응답하면 응답 시각
- 확인 알림 원탭 → WAKE_CONFIRMED(알림 응답) — DB, 끝까지 안 깨면 MISSED 기록 + 미확인 푸시 — `wake-check` 배치(아래 표, 기준은 상세설계서 7장 7.9.2)

### F01 · G01 친구와 그룹
- 친구 목록: `friends`(ACCEPTED) + 이름 · 사진 `get_public_profiles` — DB · RPC
- 받은 요청: `friends`(PENDING, 받는 사람 = 나) — DB, 수락 → ACCEPTED — DB
- 아이디 검색 · 요청: `find_profile_by_handle` — RPC → `friends` PENDING 추가 — DB
- 그룹 목록 · 만들기: `groups` + `group_members`(JOINED) — DB (만든 사람은 자동 JOINED)
- 초대 코드로 참여: `join_group_by_invite_code` — RPC
- 오늘 기상 n명: `get_group_wake_status` — RPC. 그 그룹 일정이 있는 날만 (D57)

### F02 친구 권한
- 관계별 받은 권한: `sharing_permissions`(주는 사람 = 친구, 받는 사람 = 나, 출처 FRIEND · GROUP) — DB → 최종 = 항목별 OR (앱에서 합침)

### F03 공유 권한 설정
- 내가 주는 권한: `sharing_permissions`(주는 사람 = 나, 출처 = 고른 관계) `can_view_alarm` · `can_edit_alarm` · `can_view_wake` 저장 — DB
- 받은 권한 보기: `sharing_permissions`(받는 사람 = 나) — DB
- 설정 권한은 조회 권한이 있어야 실제로 고칠 수 있음 → 화면에서 설정을 켜면 조회도 같이 켬

### G02 그룹 상세
- 그룹 · 멤버: `groups` + `group_members` — DB, 기상 공유 동의 `wake_share_opt_in` — DB
- 연결 일정: `appointments`(`group_id`) — DB
- 멤버 기상 상태: `get_group_wake_status` — RPC. 그 그룹 일정이 있는 날만 (D57). 누가 일어나면 DB가 그룹 채널에 새로 고침 신호(Realtime 방송, #160) → 앱이 다시 부름 (지형님 10/15 기술 결정 — `capstone/전체작업계획_v1.md` 8절 Q3, 레포 밖)
- 초대: `groups.invite_code` 공유, 다시 만들기 `regenerate_invite_code` — RPC

### G03 그룹원 기상 상태
- 오늘 기상 흐름: `get_group_wake_status` — RPC (기상 관련 값만, 준비 · 출발 · 도착은 본인만 — D59). 그 그룹 일정이 있는 날만 (D57)
- 깨우기 알림: `notify` — Edge → `push_tokens`

### G04 공유받은 알람
- 친구 알람: `alarms`(주인 = 친구) — DB, 조회 권한은 RLS가 확인. 약속 제목 · 장소까지 보여 주려면 RPC 하나 더 필요(`appointments` RLS는 본인 · 그룹원만) — #46에서
- 설정 권한이면 켜기 · 끄기 · ±5분: `alarms` — DB → 주인에게 알림 `notify` — Edge → 주인 폰이 다시 예약. RLS는 설정 권한이면 강도 · 소리까지 허용하므로 ±5분 제한은 화면에서 지킴(#46에서 확정)

### A02 AI 대화 (AI 대기)
- 대화: Gemini Live 단말 직결 (D7) — 임시 토큰 `voice-session` · 결과 반영 `voice-commit` — Edge
- 대화 기록: `conversation_sessions`(`transcript` · `extracted_data` · `apply_status`) — Edge
- 찾은 일정 · 준비물 저장: `appointments` · `todos` — Edge. 일정을 여러 개 찾으면 다 받음 (D36) — 기상과 이어지는 첫 일정만 자세히, 나머지는 시간에 맞춰 가벼운 알림. 카드별 상태 저장 자리는 D32와 같이 정함

### A03 하루 기록 · 일기 (AI 대기)
- 일기: `daily_journals`(AI 글 · 고친 글 · 코칭 · 격려 · 루틴 제안) 읽기 · 고치기 — DB, 만들기 — Edge. 날짜별로 엶 (R02 일간에서, D48)
- 오늘의 사실: `alarm_events` · `appointment_participants`(출발 · 도착 · 지각) · `todos` — DB

### A04 루틴 편집
- 루틴: `routines`(이름 · 목표 · 요일 · 단계 `steps` · 켜짐) — DB
- 단계 알람: `alarms`(`routine_id` · `step_order`) — DB → 예약 — 폰

### R02 나의 기록
- 월간: `daily_records`(그 달) — DB
- 주간: `daily_records.wake_confirmed_at` + `appointment_participants.is_late` — DB → 평균 기상 · 목표 기상률은 앱에서 계산
- 일간: 설정값 `alarms` + 실제 `alarm_events` — DB
- 날짜 이동 (D48): 월간 · 주간 날짜를 누르면 그날 일간, 일간 이전 · 다음 · 오늘, 일간에서 그날 일기(A03). 점수 · 달력 점 규칙은 D26 · D27

### S01 알람 조정 제안
- 제안: `alarm_suggestions`(PENDING) — DB
- 적용 · 직접 수정 · 무시: `status` · `result_value` · `responded_at` — DB, 시각이 바뀌면 `alarm-commit` — Edge → 다시 예약 — 폰
- 직접 수정 (D53): 앞 · 뒤 1분 단위, 준비 · 출발까지 미리 보기, 적용한 뒤에도 다시 고침 (EDITED · `result_value`). 저장 모양은 D6 · D23 · D25, 고친 값은 `user_edit_logs`(S01)
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
| `notify` | 다른 사람 폰에 푸시. 보내기 전에 권한 확인: G03은 같은 그룹 + `wake_share_opt_in`(D19에서 확정), G04는 `can_edit_alarm`일 때만 | Expo Push | G03 · G04 · 미확인 알림 |
| `wake-check` | 5분마다 기상 미확인 알람을 MISSED로 기록하고 미확인 푸시(`notify`) — pg_cron 배치 | — | H08 · G03 |
| `suggestion-generate` | 매일 03:00 제안 만들기, 반복 알람 다음 회차 메우기 (배치) | — | S01 |
| `voice-session` · `voice-commit` · `journal-*` | AI 대화(Gemini Live 단말 직결용 임시 토큰 · 결과 반영) · 일기 | Gemini | A02 · A03 (AI 대기) |

나머지(목록 · 체크 · 권한 · 기록 화면)는 Edge 없이 DB · RPC로 함.

## 스키마에 더 필요한 것 (그 기능을 만들 때 마이그레이션)

| | 목업 | 지금 DB | 할 때 |
|---|---|---|---|
| 1 | S01 "다음 알람 10분 앞당김" | `alarm_suggestion_type`이 VOICE_TONE · SOUND · INTENSITY뿐 | #49에서 시각 조정 종류 추가 |
| 2 | H03 강도를 배경음 · 말소리 · 진동 따로 고름 | `intensity` 하나 + `voice_tone` · `sound_key`, 진동 칸 없음 | #29에서 축별로 둘지 정함 |
| 3 | G04 "변경 기록" | 저장 자리 없음 | 처음엔 주인에게 푸시만 |
| 4 | — | 카카오 응답은 저장 · 재사용 불가인데 `est_travel_minutes` · `travel_source` CACHED가 있음 | #27에서 계산에 쓴 값만 남기는지 정함 |
| 5 | G02 · H01 그룹원 상태에 준비 시작 · 출발 · 도착까지 보임 | `get_group_wake_status`는 기상 상태(`wake_status`)와 시각만 돌려줌, MISSED는 목업에 없음 | 기상까지만으로 정함 (D59) — 화면을 실데이터로 바꿀 때 준비 · 출발 · 도착 줄을 뺌 (목업 api는 글자 `WakeState`, 실데이터는 상태 값 + 시각) |
| 6 | 일정 없는 알람 (D46) · H03 직접 고름 (D42) · 고친 값 기록 (D42 · D43) · 울림 기록 중복 | `alarms_one_source`가 둘 다 NULL을 막음, `alarms.recurrence_rule` · `time_source` · `intensity_source` · `user_edit_logs` · `alarm_events.client_event_id` · `input_source` 없음 | PR #160에서 더함 (제약 풀기 · 칸 · 표 + RLS · `client_event_id` 유니크) |
