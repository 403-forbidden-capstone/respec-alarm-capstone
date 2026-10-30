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

## 실데이터 연결 규칙 (P6, #166)

화면은 그대로 두고 `features/*/api.ts` 안에서만 가짜 데이터와 실데이터를 나눔. 아래 화면별 표(읽고 쓰는 곳)가 실데이터 구현의 명세.

**스위치** (`lib/modePolicy.ts`가 표로 정하고 `lib/mode.ts`가 읽음, `lib/flags` `REAL_DATA_READY = true`)

| 빌드 | 모드 | 로그인 | 그 밖 |
|---|---|---|---|
| 폰 출시용 (`__DEV__` false) | 실데이터 고정, 가짜로 못 바꿈 | 필수 | Supabase 값이 없으면 가짜로 돌지 않고 "앱 설정이 빠져 있어요" 화면 |
| 폰 개발용 (`__DEV__` true) | 바꿀 수 있음, 기본 실데이터 | 실데이터 모드에서만 | 값이 없으면 가짜만 |
| 웹 | 바꿀 수 있음, **기본 가짜**, 주소 `?mode=real`이면 실데이터 | 실데이터 모드에서만 | 값이 없으면 가짜만 |

`/dev/screens` 맨 위 · 설정 "개발" 절의 토글은 모드를 바꿀 수 있는 빌드에서만 보임. 실데이터 모드에서 로그인 전이면 `/dev/screens`에 시드 계정용 이메일 로그인(웹 · 폰 개발용)이 있음.

**첫 화면** (`lib/flags` `ONBOARDING_IN_FLOW = true`, #25) — 앱을 처음 켜면 로그인 화면 하나만 나오고, 로그인한 뒤 프로필의 `onboarded_at`이 비어 있으면 단계 온보딩(`onboarding`)이 먼저, 끝내면 홈. 켜진 단계는 `lib/flags` `ONBOARDING_STEPS`. 로그인 화면 아래에 "알람 테스트" 바로 가기가 있어 로그인 전에도 `/dev/alarm-test`로 갈 수 있음 (출시용 APK에도 보임 — D16이 정해지면 같이 정리).

**읽기** — 함수 맨 앞에서 `if (!isMock()) return real.<함수>(...)`. 쿼리는 `features/<x>/real.ts`에 얇게, DB 행 → 화면 타입(`types.ts`) 변환은 `map.ts`의 순수 함수로 빼서 jest로 시험 (본보기: `features/alarm`의 `getNextAlarm`). "내 것"은 `lib/user`의 `requireUserId()`로 `user_id`를 한 번 더 좁힘(RLS는 친구에게 받은 알람도 보여 줌). DB · 네트워크 원문은 화면에 안 보이고, 이유를 보여 줄 때만 `UserError`.

**쓰기 경로** (위 화면별 표의 DB · Edge 표기와 같음)

| 무엇 | 길 | 폰 |
|---|---|---|
| 새 일정 알람 만들기 (H05) | `callEdge('alarm-commit')` (`lib/edge`) | 응답을 `applyCommit`: `canceled_alarm_ids` → cancel, `ring_packages` → scheduleAll |
| H03 저장 — 이동 · 준비 · 여유 · 알람 시각 · **종류별 켜기 · 끄기 · 강도**까지 한 번에 | `callEdge('alarm-commit')` (본문의 `enabled` · `levels`). 길찾기를 못 해 서버가 어림값만 가지면(`ROUTE_UNAVAILABLE` + `details.fallback`) 저장을 멈추고 확인 시트 → 확인한 분을 직접 입력(MANUAL)으로 다시 보냄 | `applyCommit` + 도착 목표를 울리는 알람에 맞추는 `mirrorArrive`(DB 직접) 뒤 그 알람만 `reconcile`. 이 뒤처리가 실패해도 저장은 성공으로 (다음 맞추기에서 다시) |
| 반복 회차 넘기기 (앱이 앞에 올 때 · 반복 일정 저장 직후) | `callEdge('alarm-roll')` — `syncNow`가 기록 올리기 뒤 · 맞추기 앞에서 부름 (10분에 한 번, 8초, 실패는 삼킴) | 응답 꾸러미는 안 쓰고 이어서 도는 `reconcile`이 DB에서 읽어 걺. 맞춘 뒤 `onAlarmsSynced` 훅 |
| 일정 전체 켜기 · 끄기 (H01 · H02 카드) | DB 직접 (`alarms.is_enabled`, 도착 목표는 `mirrorArrive`) | `reconcile({ alarmIds })`로 그 알람만 |
| S01 제안 적용 · 되돌리기 | DB 직접 — `alarms`(말소리 · 배경음 · 진동 칸) → `alarm_suggestions` → `user_edit_logs` insert. `alarm-commit`은 안 씀 (제안 종류에 시각이 없음) | `reconcile({ alarmIds })`로 그 알람만 |
| 루틴 저장 (A04) | DB 직접 — `routines` + 단계 알람 `alarms`(없어진 단계는 지우지 않고 `is_enabled` false) | `reconcile({ alarmIds })` — 저장이 중간에 실패해도 바뀌었을 수 있는 알람은 맞춤 |
| G04 켜기 · 끄기 · ±5분 | DB 직접 — 상대의 `alarms`(설정 권한이면 RLS가 허용) → 주인에게 `notify` (Edge). 앞당길 때 옮긴 시각이 지금 + 5분보다 이르게 되는 켜진 알람이 있으면 거절 | 주인 폰이 푸시를 받거나 앱이 앞에 올 때 맞춤 (내 폰에서 걸지 않음) |
| 울림 기록 (해제 · 미루기 · 원탭) | 폰이 쌓아 둠 → `uploadEvents`가 `alarm_events`에 upsert (`client_event_id`가 같으면 무시) | 올린 것만 폰에서 지움 |
| 홈 "미루기 취소" (기상 알람) | `alarm_events`에 `DISMISSED`(`MANUAL`) upsert → `AlarmCore.cancel` → H08. 기록이 먼저 (폰 `cancel`은 해제 기록을 안 남김) | 예약 취소 |
| 기상 확정 (H08 · 앱이 앞에 올 때 다시 판정) | `alarm_events` `WAKE_CONFIRMED` + `daily_records.wake_confirmed_at` | — |
| 출발 · 도착 (원탭 · 위치) | 한 함수 `recordParticipantTimes({ participantId, departedAt?, arrivedAt?, source })` → `appointment_participants.departed_at` · `arrived_at`과 출처 칸 `departed_source` · `arrived_source`, `is_late` · `late_minutes`, 둘 다 있으면 `actual_travel_minutes`, 출발이 들어오면 `daily_records.actual_prepare_minutes`. 위치(`LOCATION`)면 `alarm_events`(`input_source LOCATION`)도. 원탭은 위 기록을 올린 뒤 `onEventsUploaded` 훅이 `source: BUTTON`으로 부름. 위치 값 [아니에요]는 `features/location/api.ts`(`rejectDetection`)가 `features/alarm/participantTimes.ts`의 `clearLocationTime`으로 지움 + `user_edit_logs`(H01 · NTF) — 지운 뒤는 다음 자동 감지를 기다림. 귀가 뒤 다시 나간 출발은 같은 함수가 더 늦은 위치 출발로 바꾸고, 앞 출발의 `alarm_events` 줄은 '확인할 기록'으로 남김 → `listEarlierDepartures(day)`가 읽음 | — |
| 고친 값 (F5 · F9) | 저장이 성공한 뒤 `user_edit_logs` (`alarm-commit`의 `edits` 또는 DB insert) | — |

`realWrite.setAlarmEnabled` · `setIntensity`(종류별 켜기 · 강도를 DB에 직접 쓰는 함수)는 부르는 화면이 없음 — H03의 켜기 · 강도는 위처럼 `alarm-commit`에 실려 감 (가짜 모드의 `saveAlarmSettings`만 이 이름으로 부름).

**길찾기 값은 다시 보내지 않음 (D5)** — H03 미리 보기 · 저장 요청(`alarm-suggest` · `alarm-commit`)은 이동시간을 직접 입력(MANUAL)한 값만 `est_travel_minutes`로 보내고, 저장돼 있던 길찾기(API) 값은 출발 위치 · 수단이 그대로여도 다시 보내지 않음. 카카오 응답은 저장 · 재사용이 안 돼서 서버가 길찾기를 새로 구함 (서버도 `API`로 저장된 값은 이어받지 않음). 방금 확인 시트(H05)에서 계산해 보여 준 값을 그대로 저장하는 경우만 `API`로 보냄.

**맞추는 시점** (`lib/alarmSync`, 실데이터 모드 + 로그인 상태에서만)

- 로그인 직후 · 앱이 앞에 올 때(AppState) — 기록 올리기 → `reconcile()` (루트 레이아웃의 `useAlarmSync`)
- 기상 확인(H08)에 들어올 때 — `uploadEvents()` (해제 기록이 기상 확인보다 먼저 들어가게)
- 같은 때(로그인 직후 · 앱이 앞에 올 때) — 최근 12시간에 끈 기상 알람 중 확정이 없는 것을 H08과 같은 판정으로 다시 보고 조건을 채웠으면 확정 기록 (`useWakeRecheck`, 자세히는 `alarm-core.md`)
- 저장 직후 — `applyCommit(응답)`
- 로그아웃 — `signOutAndCleanup()` (`lib/session`): 로그아웃 중 표시 켜기(`setSigningOut`) → 기록 올려 보기 → 맞추기와 같은 줄에서 `AlarmCore.cancelAll()`(`cancelAllPhoneAlarms`) → 남은 기록 버림 → 푸시 토큰 지우기 자리 → 실시간 구독 끊기 · 기능 메모리 정리(`onSignOut`) → `signOut`. 데이터 모드 저장값은 그대로
  - 로그아웃 중 표시가 켜져 있는 동안 `reconcile`은 서버 알람을 폰에 걸지 않고 건너뜀 (로그인 상태가 남은 사이에 맞추기가 끼어 앞 계정 알람을 다시 거는 것을 막음). `cancelAll`이 실패하면 로그아웃을 멈추고 표시를 끔. 로그아웃이 끝까지 가면 켜 둔 채로 두고, 다시 로그인할 때 `useAlarmSync`가 끔
  - `signOut`은 서버에 알리다 네트워크로 실패해도 이 기기의 로그인이 지워졌으면 끝난 것으로 봄

`reconcile`은 내 켜진 알람(지금 이후)을 읽어 서버와 같은 조립(`_shared/ring-package.ts`, 앱은 경로 별칭 `@shared/*`)으로 꾸러미를 만들고 폰 `list()`와 `alarmId` + 시각 + 강도로 비교함. 폰에 없으면 걸고(앞으로 14일 안만), 다르면 다시 걸고, 서버에 없으면 지움. 지난 시각은 건너뜀. `deferred`(울리거나 미룬 중이라 새 꾸러미를 못 받음)는 다음 맞추기에서 다시.

첫 울림이 이미 지난 폰 예약(울리는 중 · 미룸 · 다시 울림 대기)은 서버 목록(지금 이후)에 없어도 바로 지우지 않음 — 울린 뒤 서버 행의 시각이 과거가 되어 목록에서 빠지는 것이 정상이기 때문. 대신 **서버에 켜진 행이 없다고 확인된 것만** 지움 (끈 알람이 미룸 중이어도 · 다른 기기나 G04에서 꺼졌거나 지워졌어도, 시각은 안 보고 `is_enabled = true` 행이 있는지만 물음). 끄기 직후의 `reconcile({ alarmIds })`와 전체 맞추기가 같은 규칙이고, 확인 쿼리가 실패하면 전체 맞추기는 안 지움(조심 쪽, 다음 맞추기에서 다시). 서버 알람을 한 번에 읽는 줄 수(500)에서 목록이 잘렸으면 이 확인을 거친 것만 지움.

**서버 함수** — 앱은 `callEdge<T>(이름, 본문)`으로만 부름. 오류는 `EdgeError`(= `UserError`)로 오고 문구는 서버 `code`로 고름 (표: `lib/edge.ts`). **그룹 기상 신호** — `subscribeGroupWake(groupId, 콜백)` (`lib/realtime`), 신호의 `date`를 `get_group_wake_status`의 `p_date`로 넘김.

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
- **아침 카드** (기상 알람 시각 ~ 출발 + 30분, 이슈 #230): `getMorningPlan()` — 오늘(저녁엔 내일) 첫 일정 = 켜진 기상 알람이 붙은 가장 이른 약속(서버 `calc/wake.ts` `hasEarlierWake`와 같은 기준). 하루 일정과 **같은 읽기**(`realRows loadDayRows`, 동시에 부르면 쿼리 한 번)에서 약속 · 알람(준비 · 출발 · 도착 목표 시각, 꺼진 알람은 빈 값) · `est_travel_minutes` · `travel_source` · `departed_at`을 읽고, 기상 확인은 그 기상 알람의 `alarm_events` `WAKE_CONFIRMED` — DB. 가짜 모드는 `db.wakeConfirmations` · `db.me.departAt`
  - 보이는 때 (`features/alarm/morning.ts` `morningCardVisible`): 저녁(18시~)이 아님 · 기상 알람 시각이 지남(기상 확정을 기다리지 않음 — 원탭 확인 줄이기, #240) · 출발 알람 시각 + 30분까지(출발 알람이 없으면 약속 − 이동) · 출발 기록(`departed_at`)이 없음. 못 읽으면 카드만 없음(홈 전체는 그대로)
  - 글자: 첫 일정 · "출발까지 1시간 10분" · "지금 나가면 오전 9:47 도착 · 여유 13분" · 여유 / 빠듯 / 지각 위험 · 이동 출처. 도착 · 여유는 늘 지금 시각 기준으로 다시 셈 (`departNow`, 7장 7.5.2). 카드를 누르면 H03
  - [다시 확인]: `checkDepartNow(appointmentId)` — **Edge** `alarm-suggest { appointment_id }` 미리 보기에서 이동시간만 새로 구함 (저장 안 함, 출발 시각이 지나 `UNPROCESSABLE`이어도 `details.suggestion`을 씀). 카카오 응답은 DB · 앱 메모리에 담지 않음(D5) — 숫자(이동분 · 출처)만 화면 상태로 들고 있고 같은 요청이 겹치면 한 번만. 가짜 모드는 일정에 적힌 이동분
- 오늘 루틴 · 진행: `routines`(켜짐, 오늘 요일) + 오늘 `alarm_events` ACKNOWLEDGED(단계 알람) — DB
- 내일 준비물(저녁): `todos`(ITEM, 내일) 읽기 · 체크(`is_done` · `done_at`) — DB
- 제안 카드: `alarm_suggestions`(PENDING) — DB. `suppress_until`은 "이 시각 전엔 같은 종류 제안을 만들지 않음"이라 `suggestion-generate`에서만 봄
- 그룹 기상 요약: `get_group_wake_status(group_id)` — RPC. 그 그룹 일정이 있는 날만 (D57)
- 미룬 알람 줄의 "취소": 폰 예약을 지움 — 폰. 기상 알람이면 먼저 `alarm_events` `DISMISSED`(`MANUAL`)를 남기고 기상 확인(H08)으로 이어감 (해제로 봄 — 작성자 판단). 기록이 막히면(오프라인) 예약을 그대로 두고 "미루기를 취소하지 못했어요"
- 오늘 루틴은 알람 단계가 하나라도 있는 루틴만 보임 (확인을 달 알람이 없으면 홈에서 끝낼 수 없음). 마지막 알람 단계까지 확인하면 뒤의 알람 없는 단계도 끝난 것("오늘 루틴을 모두 마쳤어요")

### H02 알람 목록
- 날짜별 알람: `alarms` + `appointment_participants` + `appointments` — DB
- 카드의 켜기 · 끄기(일정 전체): `alarms.is_enabled` — DB → 예약 취소 · 다시 예약 — 폰
- 일정 없는 알람(D46): 반복은 `alarms.recurrence_rule`(#160), 만들기는 `alarm-commit` — 입력 화면(목록 "+")은 새 UI
- 반복 일정 · 반복 알람은 묶음(`series_id`)당 한 장 — 지금 이후 가장 가까운 회차 하나 (서버가 14일치 회차를 미리 만들어 둠, 지난 회차는 안 보임). 묶음이 전부 지났으면 가장 최근 지난 회차 하나. 반복이 아닌 약속은 그대로. H01 · R02 · H03은 회차 행 그대로
  - 카드에는 한 줄 "다음 회차 5월 26일 (월) 오전 9:00 · 매주 월 · 수"(`seriesInfo`)만 더하고, 앞으로 회차가 둘 이상 걸려 있으면 작은 글자 "2주치 알람 걸림"(`upcomingCount` ≥ 2). 회차 목록은 목록 · 홈에 안 나오고 H03에서만
  - 홈 "오늘 일정"(`getDaySchedule`)은 그날 회차만, "다음 알람"(`getNextAlarm`)은 가장 가까운 켜진 알람 하나만 (회차 줄줄이 없음). G04 친구 카드는 그대로 (L3 2차)

### H03 알람 설정
- 반복 일정의 앞으로 회차: `listOccurrences(id)` — 이 약속의 `series_id`를 읽고 같은 묶음의 내 참여 조건 중 지금 이후 · 날짜순 (`appointment_participants` + `appointments` + `alarms`) — DB. 둘 이상일 때만 "앞으로 회차" 카드가 뜨고, 다음 3회만 보이고 나머지는 "더 보기"(누르면 펼침, 화면 상태). 읽지 못해도 화면은 그대로
- 연결 일정 · 이동 조건 · 준비 시간: `appointments` + `appointment_participants`(출발지 · 이동 수단 · 예상 이동 · 출처 · 준비 · 여유) — DB. 출발지 · 이동 수단 · 예상 이동 · 준비 시간도 고침 (D42 C) → 다시 계산 `alarm-suggest` → 저장 `alarm-commit`
- 알람 시각 직접 고르기 (D42 C): `alarms.scheduled_at` + `time_source` MANUAL(#160), "자동으로 되돌리기" = AUTO. 강도도 같은 규칙(`intensity_source`, #160)
- 자동 강도 (D69, `_shared/calc/intensity.ts`): 기본 보통 — 매우 중요(HIGH)면 한 단계 올림 · 최근 4주 늦잠 지각 2회 이상이면 한 단계 올림 · 잠귀 무거움이면 강(`profiles.wake_sensitivity` 칸이 생기면, 지금은 안 읽음) · 상한 강. 약은 직접 고를 때만. 이미 저장된 자동 약은 `20261030130000_intensity_default.sql`이 보통으로 올림
- 고친 값 기록 (D42 · D43): `user_edit_logs`(#160, 화면 · 칸 · 자동값 → 고친 값 · 시각) — DB, 다음 계산 · 제안의 개인화 입력
- 예측 준비(P80) 근거: `v_prepare_time_stats` — DB
- 여유 시간을 바꾸면 다시 계산: `alarm-suggest` — Edge → 저장 `alarm-commit` — Edge → 다시 예약 — 폰
- 종류별 켜기 · 끄기, 강도 직접 고르기(`alarms.is_enabled` · `intensity` · `voice_tone` · `sound_key`)도 저장 때 `alarm-commit`의 `enabled` · `levels`로 — Edge → 다시 예약 — 폰 (DB에 바로 쓰는 길은 없음)
- 일정 편집 · 삭제 함수 (이슈 #211, D41 A · N6): `updateAppointment(id, patch, scope, { confirmed? })` → `{ changes, needsConfirm }`(앞당김은 바로 저장 + 토스트 [되돌리기] = 이전 값을 `confirmed: true`로 같은 함수에, 5분 이상 늦춤은 저장 전에 `needsConfirm`으로 돌려줘 기존 확인 시트 뒤 `confirmed: true`로 저장, D67) · `deleteAppointment(id, scope)` · `restoreAppointment(id)`(삭제 토스트 [되돌리기]) · `leaveSharedAppointment(id)`([나는 빠지기]) — 공동 약속은 만든 사람만(`UserError`). **가짜 모드만 구현**, 실서버는 4b(`appointment-edit`)까지 `UserError('아직 실서버에서는 쓸 수 없어요')`
  - 삭제 되돌리기 계약: 화면은 삭제 확인 뒤 5초 토스트를 띄우고, **5초가 지나거나 화면을 떠날 때** `deleteAppointment`를 부름. 5초 안에 [되돌리기]를 누르면 아무것도 부르지 않음. 가짜 모드는 부르는 즉시 숨기고 `restoreAppointment`로 되살리지만, 실서버(4b)는 5초 안에는 서버로 안 보내므로 L5는 "5초 안 = 부르지 않음" 기준으로 짬 (`restoreAppointment`는 이미 지운 뒤의 되돌리기)
- 길찾기를 못 했을 때 (7장 7.1.2): 미리 보기가 어림값(`ESTIMATE` · `CACHED`)이거나 직접 입력이 필요하면(`manual_required`) 이동 조건 칸에 안내가 뜸. 저장 때 서버가 어림값만 있으면(`ROUTE_UNAVAILABLE` + `details.fallback`) "길찾기를 못 해 이동시간을 대략 N분으로 잡았어요. 이 값으로 저장할까요?" → "이 값으로 저장"(그 분을 직접 입력 `MANUAL`로 다시 보냄) / "예상 이동을 직접 고칠게요". 좌표가 없어 어림값도 없으면 예상 이동에 직접 입력

### H05 새 일정
- 장소 검색 시트("장소" 줄을 누르면 열림): 0.3초 입력이 멈추면 `listPlaces(query, near)` → `place-search`(카카오 키워드) — Edge. `near` = 프로필 집 좌표(`profiles.home_lat` · `home_lng`)가 있으면 가까운 순, 검색어가 비면 최근 장소(최근 90일 약속의 도착지 · 출발지, `near` 안 씀). 줄 아래 글자는 주소 · 분류(`category`, 카카오 값 그대로 통과 — 저장 안 함, 카카오 약관 "응답 저장 · 재사용 불가"는 D5 참고). 가짜 모드는 목업 대학가 장소에서 거름
- 이동시간 · 알람 시각 · 강도 미리 보기: `alarm-suggest`(카카오 대중교통 포함) — Edge
- 저장: `appointments` + `appointment_participants` + `alarms`("알람" 줄에서 고른 종류 — 기상 · 준비 · 출발, 다 끄면 알람 없는 일정, D46)를 한 번에 `alarm-commit` — Edge, 준비물 `todos`(ITEM) — DB → 예약 — 폰
- 반복: 요일 칩 · 매일 · 평일 → `appointments.recurrence_rule` RRULE (D44, `FREQ=DAILY` · `FREQ=WEEKLY;BYDAY=…` 두 모양만). 저장은 첫 회차만 만들고, 다음 회차는 `alarm-roll`이 앞으로 14일치를 회차마다 새 행(약속 · 참여 · 알람 · 준비물)으로 미리 만듦 (D4 A, 5분마다 보충 · 앱 맞추기 때 본인 몫). 공동 약속은 첫 회차만 · 저장 직후 앱이 `syncNow({ rollSeriesId })`로 바로 넘기고(준비물 저장 뒤), 평소엔 앱이 앞에 올 때 10분에 한 번
- 확인 시트에서 시각 고치기 (D43): 기상을 옮기면 나머지도 따라 움직이되 순서가 뒤집히면 막음, 고친 값은 `user_edit_logs`

### H07 알람 울림
- 소리 · 강도 · 미루기 · 해제 — 폰
- 알림 글자 (이슈 #230): 준비 = `오전 8:40 출발까지 30분`, 출발 = `지금 나가면 오전 9:50 도착 · 여유 10분`을 새 알림 없이 기존 준비 · 출발 알림 한 줄에 합침(D65 기본안) — 서버 `_shared/ring-package.ts`가 만들어 꾸러미 `notice`로 줌. 웹 미리 보기 `ring`은 같은 함수(`features/alarm/notice.ts`)로 머리글을 그림. 기상 알람의 음성 문장(`voiceText`)은 읽어 주기(D8)가 붙기 전까지 폰이 저장만 함
- 기록: `alarm_events` TRIGGERED · SNOOZED(`snooze_minutes`) · DISMISSED — DB (오프라인이면 폰에 보관 후 다시 보냄). 기록마다 앱이 만든 번호 `client_event_id`(유니크 — 같으면 무시) · 출처 `input_source` (둘 다 #160)
- 알림 원탭("준비 시작" · "출발했어요" · "도착했어요"): `alarm_events` ACKNOWLEDGED(PREPARE · DEPARTURE) · ARRIVAL_CONFIRMED(ARRIVE) + `appointment_participants.departed_at` · `arrived_at` — DB. 쓰는 곳은 `recordParticipantTimes` 하나이고 지오펜스 자동 수집(#40)도 같은 함수를 `source: LOCATION`으로 부름
  - 위치 자동 우선 (지형님 10/29 흐름 확인 #240 + 7장 A~F 자동 수집 우선): 자동으로 잡은 값은 그대로 확정('확인 중' 상태 없음), 경계가 애매하면 사용자에게 유리한 쪽, 원탭은 자동 값이 없을 때 대신 쓰는 길(원탭 알림 건너뛰기는 PR 6), [아니에요]는 틀렸을 때만 누르는 정정
  - 출처 우선순위: 사용자 응답(원탭 `BUTTON` · 직접 입력 `MANUAL`) > 위치(`LOCATION`). 위치 값이 먼저 있어도 원탭이 덮고(출처도 응답 것으로 바뀜), 응답 값이 있으면 위치는 못 덮음 (응답끼리는 먼저 쓴 값). 위치 출발끼리는 더 늦은 출발로 바꿈 — 귀가 뒤 다시 나가면 그쪽이 출발(7.13.7 "약속 전 마지막 출발"), 앞 출발의 위치 기록 줄은 지우지 않고 '확인할 기록'으로 남겨 자기 전 대화(L4)가 확인. 위치 도착끼리는 먼저 쓴 값. 출발 · 도착이 바뀌면 그 값으로 셈한 `actual_travel_minutes`를 같은 줄에서 비우고 다시 셈. 출발 · 도착이 둘 다 위치(`LOCATION`)로 잰 값이면 도착 − 출발에 반경 보정 4분을 더함(7장 7.13.7 반경 보정, `TRAVEL_CORRECTION_MINUTES`, 실기기 측정으로 조정) — 한쪽이라도 응답이면 안 더함. 지금 값의 출처는 출처 칸 `departed_source` · `arrived_source`로 읽음 — 시각만 있고 출처가 비면 옛 앱 원탭 값이라 `BUTTON`. 위치 값을 쓰면 그 출발 · 도착 알람에 `alarm_events`(`input_source LOCATION`, 번호 고정)를 같이 남겨 기록 화면 "자동 · 지오펜스" 줄이 됨 (알람 행이 없으면 안 남김)
  - 지각(`is_late` · `late_minutes`, D58 · #41): 응답으로 받은 도착은 약속 + 5분 초과면 지각. 위치로 잡은 도착은 바로 판정(보류 없음) — +11분(응답 경계 5분 + 감지 지연 최대 6분) 초과면 지각, 지각 분은 감지 지연 6분을 뺀 값 (D61 감지 지연만큼 넓힘, 지연 빼기는 작성자 판단). 둘 다 NULL은 약속 시각을 못 읽었을 때뿐
  - 500m 안 가까운 약속: 출발 · 도착 감지는 그대로, `actual_travel_minutes`만 안 씀 (D68 "500m 안이면 이동 측정을 끄고 기본값" — 끄는 것은 이동시간만, 안건후보 D78 정리)
  - 준비 실측(`daily_records.actual_prepare_minutes`) = 출발 − max(실제 기상 `wake_confirmed_at`, 예정 기상 = 그날 켜 둔 기상 알람 중 가장 이른 시각). 출처와 상관없이 출발이 들어올 때, 기상 기록이 둘 다 없으면 비움, 이미 값이 있으면 덮지 않음(같은 날 두 번째 약속의 출발은 준비 실측이 아님). 예외: 같은 참여 조건의 출발이 바뀌어(응답이 덮음 · 더 늦은 위치 출발) 그 출발로 셈한 값이면 새 출발로 다시 셈

### H08 기상 확인
- 판정(폰 사용 · 버튼) → `alarm_events` WAKE_CONFIRMED + `daily_records.wake_confirmed_at` — DB
- 확정 시각 = 해제 뒤 누적 화면 사용이 θ를 넘은 시각 (D14) — 판정은 관찰 10분이 끝나야 되고 기록만 그 시각으로 남김. 확인 알림에 직접 응답하면 응답 시각
- 해제 뒤 H08을 안 열어도 앱이 앞에 올 때 최근 12시간에 끈 기상 알람 중 확정이 없는 것을 같은 판정으로 다시 보고 확정 기록 (`useWakeRecheck`). 네이티브가 해제 + 10분에 스스로 판정하는 길은 확인 필요
- 확인 알림 원탭 → WAKE_CONFIRMED(알림 응답) — DB, 끝까지 안 깨면 MISSED 기록 + 미확인 푸시 — `wake-check` 배치(아래 표, 기준은 상세설계서 7장 7.9.2). **다시 울림 없음** (D2 = B) — 앱의 가짜 시연 `missWake` · "응답 없이 5분 지나기"는 뺌
- 기상 확정 뒤 "오늘 첫 일정" 한 줄 (이슈 #230): `getMorningPlan()`(H01 아침 카드와 같은 함수) — "오늘 첫 일정 오전 10:00 전공 수업 · 세종대학교" · "오전 8:40에 나가면 돼요" · "다음 알림 · 준비 오전 8:10 · 출발 오전 8:40"(아직 안 울린 것만). 일정 줄을 누르면 H03. 켜진 기상 알람이 붙은 일정이 없으면 "오늘은 기상 알람이 걸린 일정이 없어요". 못 읽어도 확정 화면은 그대로 (덧붙임 줄)

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
- 설정 권한이면 켜기 · 끄기 · ±5분: `alarms` — DB → 주인에게 알림 `notify` — Edge → 주인 폰이 다시 예약. RLS는 설정 권한이면 강도 · 소리까지 허용하므로 ±5분 제한은 앱(`shiftSharedAlarm`)에서 지킴: 앞당길 때 옮긴 시각이 지금 + 5분(서버 `PAST_GRACE_MINUTES`)보다 이르게 되는 켜진 알람이 있으면 "곧 울릴 알람이라 앞당길 수 없어요"로 거절 (이미 지난 알람 · 꺼 둔 알람 · 늦추기는 검사 안 함)

### A02 AI 대화 (실데이터는 텍스트 대화 — 서버 함수 voice-session · voice-turn과 같이 배포돼야 동작)
- 실패 · 한도 안내 부품 `ChatNotice`(값 · 콜백) — `ai.tsx`가 실패(`unavailable`) · 한도(`limits.reached`)일 때 마지막 말풍선 아래에 붙임
- 가짜 데이터: 목업 대본(`mocks/ai.ts`) 그대로. 카드는 찾은 일정 한 장(`cards[0]`, 번호 c1)
- 실데이터(`features/voice/real.ts`, 설계 `L4_자기전_설계메모.md` 1 · 2 · 5절): 글로만 대화 — 말하기 버튼 없음("키보드 마이크로 말해도 돼요")
  - 시작: `voice-session {session_type: BEFORE_SLEEP, input_mode: TEXT, resume: true}` — 오늘 안 끝난 세션이 있으면 이어서(A02를 다시 열어도 대화 유지), 첫 마디는 서버 템플릿. 하루 한도면 `session_id: null` · `limits.reached: DAY`
  - 말: `voice-turn {session_id, rev, client_turn_id, text}` (25초 timeout, `lib/edge`). 응답 `next: APP_TASKS`면 앱이 카드마다 일을 하고 `voice-turn {results}`(같은 client_turn_id · rev는 응답의 rev)로 돌려준 뒤 마지막 `reply`를 받음
  - 앱 일: 새 약속 카드(`APPT_NEW`) = 장소 이름이 `listPlaces(이름)`에 똑같이 하나면 그 좌표로 `estimateAppointment`, 아니면 `NEEDS_PLACE`(카드의 [장소 고르기] = 장소 검색 시트) · 시각 고침 `adjustEstimate` / 알람 고치기(`ALARM_EDIT`) = `getAppointment` + `previewAlarms`(시각 · 준비가 바뀔 때만) / 정정 `fixes` = `features/voice/fixes.ts` — 새 시각 `recordParticipantTimes(MANUAL)` + 고친 값 기록(user_edit_logs, 화면 A02) 한 줄, 부정(위치 값 지우기)은 L2 PR 6 뒤 연결
  - 카드 버튼: [저장] = `createAppointment(estimate, '자기 전 대화')`(준비물 같이) · 약속 없는 알람 = `createStandaloneAlarm` · [바꾸기] = `saveAlarmSettings` · 준비 ±N(줄이기 · 0 = 자동으로) · 강도(null = 보통으로 → 자동)는 **실제로 바뀐 때만** 저장 뒤 `saveAlarmSettings` 한 번 더(alarm-commit이 길찾기를 또 부르므로) → `voice-turn {card_action: SAVED, appointment_id, alarms}` / [저장 안 함] = `card_action: REJECTED`(서버는 답 없음)
  - 완료: 대화를 그대로 남기고 홈으로 (대화 끝 정리 `voice-commit` · 할 일 · 준비물 · 일기는 이번 범위 밖)
  - 대화 상태(세션 · rev · 카드 · 계산한 Estimate)는 앱 메모리. 앱을 다시 열면 voice-session resume으로 말 · 카드 상태를 받고, 저장 전 Estimate는 다시 계산 (D5 — 이동 분을 서버에 안 남김)
- 오류 · 상태 (화면 문구는 `lib/edge`의 code → 문구):

| 상황 | 앱이 하는 일 |
|---|---|
| `LLM_UNAVAILABLE` · `NOT_CONFIGURED` · `NETWORK` · `TIMEOUT` · `INTERNAL` | 던지지 않음. 대화 · 카드는 남기고 마지막 말풍선 아래에 "AI가 지금 답하지 못해요" + [다시 시도](같은 요청 · 같은 client_turn_id) · [직접 일정 만들기] · [대화 마치기]. `details`의 `cards` · `rev` · `limits`로 상태를 복원. 키가 없으면 `voice-session`은 첫 마디까지 주고 `voice-turn`만 `NOT_CONFIGURED`(보낸 말은 서버에 안 쌓이고 같은 요청을 다시 보내면 됨) |
| `CONFLICT` (rev 어긋남) | `voice-session` resume으로 다시 읽고 오류 안내(보낸 말은 입력칸으로). 앱에서 이미 저장한 카드는 서버가 몰라도 저장으로 둠 |
| `NOT_FOUND` (세션 · 카드 · 정정 번호) | 같은 방식으로 세션을 다시 읽음 |
| `limits.reached` TURN · DAY | 오류가 아님 — 20번째 답은 정상 reply로 보이고 그 뒤 입력만 막음. "오늘 대화는 여기까지예요" + [대화 마치기] · [직접 일정 만들기] |
| 그 밖 (`VALIDATION_FAILED` · `AUTH_REQUIRED` …) | 던짐 → 토스트, 보낸 말은 입력칸으로 |

- 대화 기록: `conversation_sessions`(`turns` · `server_state`) — 서버만 씀(앱은 읽기만)
- 일정 · 알람 저장: 앱이 L1 함수로(`appointments` · `alarms`), 준비물은 카드와 같이. 대화 끝 정리의 할 일 · 준비물(`todos`)은 서버 PR 5 (D32). 일정을 여러 개 찾으면 다 받음 (D36) — 기상과 이어지는 첫 일정(`first_of_day`)만 알람 줄을 자세히, 나머지는 "출발 알림" 한 줄. 카드별 상태는 서버 `server_state.cards`

### A03 하루 기록 · 일기 (AI 대기)
- 일기: `daily_journals`(AI 글 · 고친 글 · 코칭 · 격려 · 루틴 제안) 읽기 · 고치기 — DB, 만들기 — Edge. 날짜별로 엶 (R02 일간에서, D48)
- 오늘의 사실: `alarm_events` · `appointment_participants`(출발 · 도착 · 지각) · `todos` — DB

### A04 루틴 편집
- 루틴: `routines`(이름 · 목표 · 요일 · 단계 `steps` · 켜짐) — DB
- 단계 알람: `alarms`(`routine_id` · `step_order`) — DB → 예약 — 폰. 루틴을 끄거나 단계(알람)를 빼면 알람을 지우지 않고 `is_enabled` false (지우면 울림 · 확인 기록 `alarm_events`가 같이 사라짐). 다시 켜면 같은 줄(루틴 · 단계 번호가 하나뿐)을 켬. 폰 맞추기는 저장이 중간에 실패해도 함

### R02 나의 기록
- 월간: `daily_records`(그 달) — DB. 달력 점 "완료"(지난 날) = 기상 확인 `wake_confirmed_at` + 준비 실측 `actual_prepare_minutes` (출발 입력 때 `recordParticipantTimes`가 씀). 서버의 예상 준비시간 P80(`v_prepare_time_stats`)도 이 값을 읽음
- 주간: `daily_records.wake_confirmed_at` + `appointment_participants.is_late` — DB → 평균 기상 · 목표 기상률은 앱에서 계산
- 일간: 설정값 `alarms`(켜진 것만 — 일정을 통째로 꺼 둔 날은 도착 목표도 없음) + 실제 `alarm_events` — DB
- 날짜 이동 (D48): 월간 · 주간 날짜를 누르면 그날 일간, 일간 이전 · 다음 · 오늘, 일간에서 그날 일기(A03). 점수 · 달력 점 규칙은 D26 · D27

### S01 알람 조정 제안
- 제안: `alarm_suggestions`(PENDING) — DB
- 적용 · 되돌리기 · 무시: `alarms`(말소리 · 배경음 · 진동 칸) + `status` · `result_value` · `responded_at` — DB → 그 알람만 다시 예약 — 폰. 시각을 바꾸는 제안 종류는 아직 없어 `alarm-commit`은 안 씀 (#49). 배경음 제안은 이전 값이 비어 있어도(기본음) 되돌릴 수 있음(`sound_key` null)
- 직접 수정 (D53): 앞 · 뒤 1분 단위, 준비 · 출발까지 미리 보기, 적용한 뒤에도 다시 고침 (EDITED · `result_value`). 저장 모양은 D6 · D23 · D25, 고친 값은 `user_edit_logs`(S01) — 가짜 데이터 흐름. 실데이터는 시각 조정 제안 종류가 생기면(#49)
- 제안 만들기: `suggestion-generate`(매일 배치) — Edge

### 로그인 · 온보딩 · 설정 (#25)
- 로그인: Supabase Auth 카카오 · 구글 → 가입하면 `profiles` 자동 생성. 화면 아래의 "알람 테스트" 버튼은 `/dev/alarm-test`로 바로 감 (로그인 전에도 열림, 화면 위 "← 이전"으로 돌아옴, #177)
- 온보딩: `profiles` 아이디(`handle`) · 닉네임 · 잠귀(`wake_sensitivity`) · 집(`home_name` · `home_lat` · `home_lng`) · 기본 준비 · 여유 시간 · 이동 수단 · 깨우는 여유(`wake_margin`) · 개인정보 동의(`privacy_agreed_at` · `privacy_version`) · 온보딩 끝낸 시각(`onboarded_at`) — DB, 집 검색 `place-search` — Edge
  - **단계 온보딩** (`lib/flags` `ONBOARDING_IN_FLOW = true`, #25): 순서는 `features/onboarding/steps.ts`, 단계마다 켜고 끄는 표는 `ONBOARDING_STEPS`(아이디 → 닉네임 → 잠귀 → [집] → 아침 준비 → [시간표] → 동의 → [권한 안내] → 기상 공유 → 첫 일정, [ ]는 화면이 아직 없어 끔). 단계마다 [다음]에서 `saveProfileFields`로 저장하고 마지막에 `finishOnboarding`이 `onboarded_at`을 적음. 판정은 `onboarded_at`이 비었는지(`features/auth/onboardingGate.ts`). 가짜 데이터 모드 미리 보기는 저장 없이 단계만 넘김. `/dev/screens`의 "온보딩부터 다시"로 처음부터 다시 봄
  - 가입 직후 프로필: 닉네임 = 카카오 · 구글에서 가져온 값(DB 트리거), 준비 60분 · 여유 10분 · 이동 수단 대중교통 · 잠귀 보통 · 깨우는 여유 보통 = DB 기본값(온보딩 입력칸 처음 값), 집 · 아이디 = 비어 있음
- 온보딩 단계 부품 초안(`features/onboarding/components/`): `OnboardingFrame`(틀) · `HomePlaceStep` · `TimetableStep` · `PermissionsStep` · `OnboardingDoneStep` — 값 · 콜백만 받고 api · 라우터를 부르지 않음(L7이 함수를 붙임). `/dev/onboarding?mode=mock`에서 가짜 값으로 넘겨 봄 (`/dev/screens` 목록에는 없음, #116)
- 권한 안내: 알림 · 정확한 알람 · 잠금화면 알람 화면 — 폰
- 푸시 토큰: 앱 켤 때 `register_push_token` — RPC

## Edge Function — 만들 것만

| 이름 | 하는 일 | 외부 | 화면 |
|---|---|---|---|
| `place-search` | 장소 검색 | 카카오 로컬 | H05 · 온보딩 |
| `alarm-suggest` | 이동시간 · 기상 · 준비 · 출발 · 도착 시각 · 강도 계산 (저장 안 함) | 카카오 대중교통 | H05 · H03 · H01(아침 카드 다시 확인) |
| `alarm-commit` | 약속 · 참여 조건 · 알람을 한 번에 저장 | — | H05 · H03 · S01 |
| `notify` | 다른 사람 폰에 푸시. 보내기 전에 권한 확인: G03은 같은 그룹 + `wake_share_opt_in`(D19에서 확정), G04는 `can_edit_alarm`일 때만 | Expo Push | G03 · G04 · 미확인 알림 |
| `wake-check` | 5분마다 기상 미확인 알람을 MISSED로 기록하고 미확인 푸시(`notify`) — pg_cron 배치 | — | H08 · G03 |
| `alarm-roll` | 반복 약속 · 일정 없는 반복 알람의 다음 회차를 14일치 미리 만들고(`series_id` · `occurrence_on`), 루틴 알람 시각을 다음 발생으로 옮김 — pg_cron 5분마다(서비스 키) + 앱 맞추기 때 본인 몫(로그인 토큰) | 카카오 대중교통 | H01 · H02 · H03 · R02 |
| `suggestion-generate` | 매일 03:00 제안 만들기 (배치) | — | S01 |
| `voice-session` | 자기 전 대화 시작 · 이어 받기(텍스트). 첫 마디는 서버 템플릿(모델 호출 없음), 하루 5대화 상한. 응답 `{ session_id, resumed, rev, turn_seq, day, messages, cards, limits }` (L4 AI 묶음) | — | A02 |
| `voice-turn` | 자기 전 대화 한 턴: 말(`text`) · 앱 일 결과(`results`) · 카드 버튼(`card_action`). 서버는 카드 재료와 말만 주고 계산 · 저장은 앱이 함. 빠른 추출(T2F)과 대화 답(T1) 동시 호출 → 턴 처리 → 가드. 응답 `{ rev, turn_seq, next: USER \| APP_TASKS, reply, cards(전체), fixes, limits }`, 서버 마감 18초 (L4 AI 묶음) | Claude | A02 |
| `voice-commit` · `journal-*` | AI 대화 끝 정리(할 일 · 준비물) · 일기 | Claude | A02 · A03 (AI 대기) |

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
