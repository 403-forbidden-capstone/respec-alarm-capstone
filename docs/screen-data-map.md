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
| G04 시각 제안(켜기 · 끄기는 없음) | RPC `propose_alarm_time` → 주인에게 `notify` (Edge). 설정 권한이 있어도 상대의 `alarms`를 직접 update하는 길은 11/9에 닫음(0행, 이슈 #427) — 바뀌는 것은 주인이 [적용]한 뒤. 앞당길 때 옮긴 시각이 지금 + 5분보다 이르게 되는 켜진 알람이 있으면 거절 | 주인 폰이 푸시를 받거나 앱이 앞에 올 때 맞춤 (내 폰에서 걸지 않음) |
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
- 계정 삭제 (친구 12장) — 설정 [계정 삭제]: `my_account_delete_summary` — RPC(나갈 그룹 · 마지막 멤버라 사라질 그룹 · 남을 공동 약속 · 친구 수, 본인 것만)로 확인 문구를 만들고 확인 두 번 → `account-delete` — Edge(본인만, 요청 본문 없음, 서버가 `prepare_account_delete` → `auth.admin.deleteUser`, 중간 실패는 다시 불러 이어서 끝냄) → 성공하면 `lib/session` `cleanupAfterAccountDelete()`(폰 알람 취소 · 남은 기록 버림 · 구독 끊기 · 로그아웃, 서버 계정이 이미 없으니 못 지워도 멈추지 않음). 서버 함수 타입은 서버 PR 머지 뒤 `types/database.ts`를 다시 만들 때 들어옴(그때까지 이름으로 부름)
- 웹 삭제 요청 안내 — `/account-deletion`(로그인 없이, 폼 없음): 팀 메일 주소(답 대기라 비워 둠, `features/account/texts` `DELETION_MAIL`) · 보낼 내용(가입 이메일 · 아이디) · 30일 안 처리 안내
- 로그아웃 — `signOutAndCleanup()` (`lib/session`): 로그아웃 중 표시 켜기(`setSigningOut`) → 기록 올려 보기 → 맞추기와 같은 줄에서 `AlarmCore.cancelAll()`(`cancelAllPhoneAlarms`) → 남은 기록 버림 → 푸시 토큰 지우기(`removePushToken`, 이 기기의 `push_tokens` 행 삭제 · 실패해도 계속) → 실시간 구독 끊기 · 기능 메모리 정리(`onSignOut`) → `signOut`. 데이터 모드 저장값은 그대로
  - 로그아웃 중 표시가 켜져 있는 동안 `reconcile`은 서버 알람을 폰에 걸지 않고 건너뜀 (로그인 상태가 남은 사이에 맞추기가 끼어 앞 계정 알람을 다시 거는 것을 막음). `cancelAll`이 실패하면 로그아웃을 멈추고 표시를 끔. 로그아웃이 끝까지 가면 켜 둔 채로 두고, 다시 로그인할 때 `useAlarmSync`가 끔
  - `signOut`은 서버에 알리다 네트워크로 실패해도 이 기기의 로그인이 지워졌으면 끝난 것으로 봄

`reconcile`은 내 켜진 알람(지금 이후)을 읽어 서버와 같은 조립(`_shared/ring-package.ts`, 앱은 경로 별칭 `@shared/*`)으로 꾸러미를 만들고 폰 `list()`와 `alarmId` + 시각 + 강도로 비교함. 폰에 없으면 걸고(앞으로 14일 안만), 다르면 다시 걸고, 서버에 없으면 지움. 지난 시각은 건너뜀. `deferred`(울리거나 미룬 중이라 새 꾸러미를 못 받음)는 다음 맞추기에서 다시.

첫 울림이 이미 지난 폰 예약(울리는 중 · 미룸 · 다시 울림 대기)은 서버 목록(지금 이후)에 없어도 바로 지우지 않음 — 울린 뒤 서버 행의 시각이 과거가 되어 목록에서 빠지는 것이 정상이기 때문. 대신 **서버에 켜진 행이 없다고 확인된 것만** 지움 (끈 알람이 미룸 중이어도 · 다른 기기나 G04에서 꺼졌거나 지워졌어도, 시각은 안 보고 `is_enabled = true` 행이 있는지만 물음). 끄기 직후의 `reconcile({ alarmIds })`와 전체 맞추기가 같은 규칙이고, 확인 쿼리가 실패하면 전체 맞추기는 안 지움(조심 쪽, 다음 맞추기에서 다시). 서버 알람을 한 번에 읽는 줄 수(500)에서 목록이 잘렸으면 이 확인을 거친 것만 지움.

**서버 함수** — 앱은 `callEdge<T>(이름, 본문)`으로만 부름. 오류는 `EdgeError`(= `UserError`)로 오고 문구는 서버 `code`로 고름 (표: `lib/edge.ts`). **그룹 기상 신호** — `subscribeGroupWake(groupId, 콜백)` (`lib/realtime`), 신호의 `date`를 `get_group_wake`의 `p_date`로 넘김(서버가 어제 · 오늘 · 내일만 받아서, 그 밖의 날짜는 `p_date` 없이 불러 오늘 기준으로 읽음). 다시 연결될 때 · 앱이 앞에 올 때도 다시 읽음.

## 화면 목록

| 번호 | 화면 | 경로 | 이슈 |
|---|---|---|---|
| H01 | 홈 | `(tabs)/index` | #30 |
| H02 | 알람 목록 (02 알람 탭, D110) | `(tabs)/alarms` | #30 |
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
| R02 | 나의 기록 (홈 맨 아래, D110) | `(tabs)/index` · `features/records/components/RecordsSection` | #38 · #41 |
| S01 | 알람 조정 제안 | `suggestion/[id]` | #49 |
| L01 · L02 · L03 | 로그인 · 온보딩(10단계) · 설정 · 학교 시간표 · 시간표 가져오기 확인 | `login` · `onboarding` · `settings` · `timetable` · `timetable-import` | #25 · #291 |
| L04 | 알람이 안 울릴 때 | `ring-check` | #210 |
| NTF | 감지 정정 (알림 "출발 8:30 감지"를 눌러 열림) | `detection` | #40 |

## 화면별 데이터

### H01 홈
- 다음 알람은 흐름 카드 — 약속 이름 · 큰 시각 · 기상 → 준비 → 출발 → 일정 점 줄(일정 없는 알람은 '일정' 점 없음). 그룹 약속이면 아래에 같이 준비하는 사람 줄: `listGroups` → 이름이 같은 그룹 → `getGroupSummary`(멤버 앞 글자 · 오늘 기상 수, 약속이 오늘이 아니면 그룹 이름만). 덧붙임 줄이라 못 읽으면 안 그림
- 나의 기록은 접힌 요약(이번 주 `getWeek`: 날짜 줄 · 평균 기상 · 목표 기상률 · AI 코칭) 한 카드, "자세히"를 누르면 그 자리에서 월간 · 주간 · 일간(R02)
- 다음 알람: `alarms`(내 것, 켜짐, 지금 이후 가장 이른 것) → `appointment_participants` → `appointments`(제목 · 장소 · 시각) — DB. 루틴 알람이면 `participant_id`가 NULL이라 `routines.title`을 씀. 일정 없는 알람(D46)은 둘 다 NULL(#160) → 제목 "알람"
- 오늘 일정(저녁엔 내일): `appointment_participants`(나) + `appointments.appointment_at` 날짜 — DB
- **아침 카드** (기상 알람 시각 ~ 출발 + 30분, 이슈 #230): `getMorningPlan()` — 오늘(저녁엔 내일) 첫 일정 = 켜진 기상 알람이 붙은 가장 이른 약속(서버 `calc/wake.ts` `hasEarlierWake`와 같은 기준). 하루 일정과 **같은 읽기**(`realRows loadDayRows`, 동시에 부르면 쿼리 한 번)에서 약속 · 알람(준비 · 출발 · 도착 목표 시각, 꺼진 알람은 빈 값) · `est_travel_minutes` · `travel_source` · `departed_at`을 읽고, 기상 확인은 그 기상 알람의 `alarm_events` `WAKE_CONFIRMED` — DB. 가짜 모드는 `db.wakeConfirmations` · `db.me.departAt`
  - 보이는 때 (`features/alarm/morning.ts` `morningCardVisible`): 저녁(18시~)이 아님 · 기상 알람 시각이 지남(기상 확정을 기다리지 않음 — 원탭 확인 줄이기, #240) · 출발 알람 시각 + 30분까지(출발 알람이 없으면 약속 − 이동) · 출발 기록(`departed_at`)이 없음. 못 읽으면 카드만 없음(홈 전체는 그대로)
  - 글자: 첫 일정 · "출발까지 1시간 10분" · "지금 나가면 오전 9:47 도착 · 여유 13분" · 여유 / 빠듯 / 지각 위험 · 이동 출처. 도착 · 여유는 늘 지금 시각 기준으로 다시 셈 (`departNow`, 7장 7.5.2). 카드를 누르면 H03
  - [다시 확인]: `checkDepartNow(appointmentId)` — **Edge** `alarm-suggest { appointment_id }` 미리 보기에서 이동시간만 새로 구함 (저장 안 함, 출발 시각이 지나 `UNPROCESSABLE`이어도 `details.suggestion`을 씀). 카카오 응답은 DB · 앱 메모리에 담지 않음(D5) — 숫자(이동분 · 출처)만 화면 상태로 들고 있고 같은 요청이 겹치면 한 번만. 가짜 모드는 일정에 적힌 이동분
- **감지 정정 줄** (이슈 #40, 인사 아래 · 아침 카드 자리 바로 뒤): `listDetections(오늘)` — 오늘 위치로 잡힌 출발 · 도착(`departed_source`/`arrived_source` = LOCATION)만. 없으면 제목도 줄도 안 그림. 줄 글자는 "출발 오전 8:30 · 자동 감지"(지각 문구 없음, D61). 읽기는 홈이 앞에 올 때 · 앱이 다시 앞에 올 때 · 홈이 다시 읽힐 때. [아니에요]: `rejectDetection(screen 'H01')` → 폰 판정 기억 잊음(`forgetGeoDetection`) → 폰 예약 · 감시 계획 다시 맞춤 → 토스트 "출발 오전 8:30 기록을 지웠어요" + [되돌리기](5초, `undoReject` → `restoreGeoDetection`). 지운 순서는 감지 안내(NTF)와 같은 `features/location/fix.ts`. 출발을 지우면 아침 카드가 다시 보일 수 있어 홈도 다시 읽음. 못 읽어도 홈 전체는 그대로. 가짜 모드는 저녁 시나리오(5월 21일)에서만 줄이 보임(아침 시나리오의 오늘은 감지가 없음)
- 오늘 루틴 · 진행: `routines`(켜짐, 오늘 요일) + 오늘 `alarm_events` ACKNOWLEDGED(단계 알람) — DB
- 내일 준비물(저녁): `todos`(ITEM, 내일) 읽기 · 체크(`is_done` · `done_at`) — DB
- 미룬 알람 줄의 "취소": 폰 예약을 지움 — 폰. 기상 알람이면 먼저 `alarm_events` `DISMISSED`(`MANUAL`)를 남기고 기상 확인(H08)으로 이어감 (해제로 봄 — 작성자 판단). 기록이 막히면(오프라인) 예약을 그대로 두고 "미루기를 취소하지 못했어요"
- 오늘 루틴은 알람 단계가 하나라도 있는 루틴만 보임 (확인을 달 알람이 없으면 홈에서 끝낼 수 없음). 마지막 알람 단계까지 확인하면 뒤의 알람 없는 단계도 끝난 것("오늘 루틴을 모두 마쳤어요")

### H02 알람 목록
- 카드는 세 줄(시각 · 기상/준비/출발 · 일정)이고 작은 글자는 반복 줄(다음 회차 · 반복 요일 · 2주치 걸림)만 — 알람 강도 · 준비 시간은 카드를 눌러 H03에서 봄. 위 줄 오른쪽 "+" 하나 → 시트에서 새 알람 · 새 일정을 고름
- 날짜별 알람: `alarms` + `appointment_participants` + `appointments` — DB
- 카드의 켜기 · 끄기(일정 전체): `alarms.is_enabled` — DB → 예약 취소 · 다시 예약 — 폰
- 일정 없는 알람(D46, 화면 이름 "기본 알람"): 반복은 `alarms.recurrence_rule`(#160), 만들기는 `alarm-commit` — 입력은 알람 탭 위 줄 "+ 새 알람" 시트(시간 · 반복, #588). 고치기 · 지우기는 카드를 눌러 같은 시트(#643) — 반복 아님 · 안 울린 알람은 제자리에서 고치고, 그 밖은 새 알람 + 옛 묶음 거두기(끄고 `recurrence_rule` 비움 → 안 울린 · 기록 없는 회차만 행 삭제, 울림 기록 보존)
- 반복 일정 · 반복 알람은 묶음(`series_id`)당 한 장 — 지금 이후 가장 가까운 회차 하나 (서버가 14일치 회차를 미리 만들어 둠, 지난 회차는 안 보임). 묶음이 전부 지났으면 가장 최근 지난 회차 하나. 반복이 아닌 약속은 그대로. H01 · R02 · H03은 회차 행 그대로
  - 카드에는 한 줄 "다음 회차 5월 26일 (월) 오전 9:00 · 매주 월 · 수"(`seriesInfo`)만 더하고, 앞으로 회차가 둘 이상 걸려 있으면 작은 글자 "2주치 알람 걸림"(`upcomingCount` ≥ 2). 회차 목록은 목록 · 홈에 안 나오고 H03에서만
  - 홈 "오늘 일정"(`getDaySchedule`)은 그날 회차만, "다음 알람"(`getNextAlarm`)은 가장 가까운 켜진 알람 하나만 (회차 줄줄이 없음). G04 친구 카드는 그대로 (L3 2차)

### H03 알람 설정
- 반복 일정의 앞으로 회차: `listOccurrences(id)` — 이 약속의 `series_id`를 읽고 같은 묶음의 내 참여 조건 중 지금 이후 · 날짜순 (`appointment_participants` + `appointments` + `alarms`) — DB. 둘 이상일 때만 "앞으로 회차" 카드가 뜨고, 다음 3회만 보이고 나머지는 "더 보기"(누르면 펼침, 화면 상태). 읽지 못해도 화면은 그대로
- 연결 일정 · 이동 조건 · 준비 시간: `appointments` + `appointment_participants`(출발지 · 이동 수단 · 예상 이동 · 출처 · 준비 · 여유) — DB. 출발지 · 이동 수단 · 예상 이동 · 준비 시간도 고침 (D42 C) → 다시 계산 `alarm-suggest` → 저장 `alarm-commit`
- 알람 시각 직접 고르기 (D42 C): `alarms.scheduled_at` + `time_source` MANUAL(#160), "자동으로 되돌리기" = AUTO. 강도도 같은 규칙(`intensity_source`, #160)
- 자동 강도 (D69, `_shared/calc/intensity.ts`): 기본 보통 — 매우 중요(HIGH)면 한 단계 올림 · 최근 4주 늦잠 지각 2회 이상이면 한 단계 올림 · 잠귀 무거움이면 강(`profiles.wake_sensitivity`, 일정 없는 단독 알람도 같음) · 상한 강. 약은 직접 고를 때만. 이미 저장된 자동 약은 `20261030130000_intensity_default.sql`이 보통으로 올림
- 강도의 세 축 (D1 A, 이슈 #312): `alarms.intensity` = **전체 세기**(볼륨 · 다시 울림 — 늘 자동 단계, 잠귀 깊음 → 강). 배경음 축 = `sound_key`(`theme_calm` · `theme_default` · `theme_urgent`), 말소리 축 = `voice_tone`(기상 음성 문장의 말투), 진동 축 = `vibration`(`NONE` · `SHORT_REPEAT` · `STRONG_CONTINUOUS`, **직접 고른 값만** 저장하고 자동이면 NULL = 전체 세기를 따름). 직접 고른 축이 하나라도 있으면 `intensity_source` = MANUAL. 폰에 넘기는 꾸러미(`ring_packages[]`)에는 해석된 `soundKey`(`sound_key ?? 강도에서`)와 `vibration`(`vibration ?? 강도에서`)을 늘 실음(`calc/intensity.ts soundKeyOf · vibrationOf`) — 앱은 `lib/alarmSync`가 폰 `list()`의 두 값과 비교해 다르면 다시 걸고, 고친 값 기록의 진동 칸 이름은 `vibration`(예전 기록은 `intensity`)
- 고친 값 기록 (D42 · D43): `user_edit_logs`(#160, 화면 · 칸 · 자동값 → 고친 값 · 시각) — DB, 다음 계산 · 제안의 개인화 입력
- 예측 준비 근거: 내 기상~출발 기록 `daily_records.actual_prepare_minutes`의 최근 30건(10~240분) — DB. 깨우는 여유(`profiles.wake_margin`) 빠듯 · 보통 · 넉넉 = 0.7 · 0.8 · 0.9 분위수, 매우 중요는 한 단계 위. H03 "준비 N분 · 내 기록 기반 N건" 아래 "최근 5번 …분"(`alarm-suggest` 응답 `prepare.recent`)
- 여유 시간을 바꾸면 다시 계산: `alarm-suggest` — Edge → 저장 `alarm-commit` — Edge → 다시 예약 — 폰
- 종류별 켜기 · 끄기, 강도 직접 고르기(`alarms.is_enabled` · `intensity` · `voice_tone` · `sound_key` · `vibration`)도 저장 때 `alarm-commit`의 `enabled` · `levels`로 — Edge → 다시 예약 — 폰 (DB에 바로 쓰는 길은 없음)
- 일정 편집 · 삭제 함수 (이슈 #211, D41 A · N6): `updateAppointment(id, patch, scope, { confirmed? })` → `{ changes, needsConfirm }`(앞당김은 바로 저장 + 토스트 [되돌리기] = 이전 값을 `confirmed: true`로 같은 함수에, 5분 이상 늦춤은 저장 전에 `needsConfirm`으로 돌려줘 기존 확인 시트 뒤 `confirmed: true`로 저장, D67) · `deleteAppointment(id, scope)` · `restoreAppointment(id)`(삭제 토스트 [되돌리기]) · `leaveSharedAppointment(id)`([나는 빠지기]) — 공동 약속은 그룹원 누구나(#619, 만든 사람은 기록만). **가짜 모드만 구현**, 실서버는 4b(`appointment-edit`)까지 `UserError('아직 실서버에서는 쓸 수 없어요')`
  - 삭제 되돌리기 계약: 화면은 삭제 확인 뒤 5초 토스트를 띄우고, **5초가 지나거나 화면을 떠날 때** `deleteAppointment`를 부름. 5초 안에 [되돌리기]를 누르면 아무것도 부르지 않음. 가짜 모드는 부르는 즉시 숨기고 `restoreAppointment`로 되살리지만, 실서버(4b)는 5초 안에는 서버로 안 보내므로 L5는 "5초 안 = 부르지 않음" 기준으로 짬 (`restoreAppointment`는 이미 지운 뒤의 되돌리기)
  - 화면 (`useScheduleEdit` · 편집 시트 U14 · 반복 범위 U15): 연결 일정 카드(›)를 누르면 편집 시트 — 일정명 · 날짜 · 시간 · 장소(장소 검색 시트) · 중요도 · 반복. 반복 일정이면 저장 · 삭제 전에 "이번만 · 이후 모두"(반복 요일을 바꾸는 저장은 묻지 않고 이후 모두). 5분 이상 늦춰지면 기존 "알람 시각이 바뀌어요" 시트 뒤 `confirmed: true`로 저장, 바뀐 알람이 있으면 토스트 "알람 7:10 → 6:50" [되돌리기]. 삭제는 확인 뒤 같은 화면에 "지운 일정"을 보이며 5초 토스트, 5초 뒤나 화면을 떠날 때 `deleteAppointment` 후 이전 화면으로. 남이 만든 공동 약속은 읽기 전용 + [나는 빠지기]
- 길찾기를 못 했을 때 (7장 7.1.2): 미리 보기가 어림값(`ESTIMATE` · `CACHED`)이거나 직접 입력이 필요하면(`manual_required`) 이동 조건 칸에 안내가 뜸. 저장 때 서버가 어림값만 있으면(`ROUTE_UNAVAILABLE` + `details.fallback`) "길찾기를 못 해 이동시간을 대략 N분으로 잡았어요. 이 값으로 저장할까요?" → "이 값으로 저장"(그 분을 직접 입력 `MANUAL`로 다시 보냄) / "예상 이동을 직접 고칠게요". 좌표가 없어 어림값도 없으면 예상 이동에 직접 입력

### H05 새 일정
- 장소 줄 = 지도 시트(`MapPlaceSheet`, 검색 · 핀 · 현재 위치) + 자주 가는 곳 칩(`listUserPlaces`, 없으면 안 그림). 목적지 반경은 시트 "감지 범위"에서 골라 `draft.destRadiusM` → 요청 `appointment.destination.radius_m`(100~500 정수, 좌표가 있고 골랐을 때만) → `appointments.dest_radius_m`. 장소를 바꾸면 반경도 같이 바뀜(칩은 그 곳의 저장된 반경, 없으면 서버 기본값)
- 장소 검색 시트("장소" 줄을 누르면 열림): 0.3초 입력이 멈추면 `listPlaces(query, near)` → `place-search`(카카오 키워드) — Edge. `near` = 프로필 집 좌표(`profiles.home_lat` · `home_lng`)가 있으면 가까운 순, 검색어가 비면 최근 장소(최근 90일 약속의 도착지 · 출발지, `near` 안 씀). 줄 아래 글자는 주소 · 분류(`category`, 카카오 값 그대로 통과 — 저장 안 함, 카카오 약관 "응답 저장 · 재사용 불가"는 D5 참고). 가짜 모드는 목업 대학가 장소에서 거름
- 이동시간 · 알람 시각 · 강도 미리 보기: `alarm-suggest`(카카오 대중교통 포함) — Edge
- 함께할 그룹(친구 9장): 참여 중인 그룹 목록에서 고르면 요청 `appointment.group_id` → 공동 약속. 줄 아래 '일정 이름 · 시각 · 장소는 그룹원 모두에게 보여요'(메모 칸은 아직 없음)
- 공동 약속 시각이 바뀐 뒤 확인(`/alarm/changed?id=`): 지금 알람(`getAppointment`) → 바뀐 시각으로 다시 계산(`alarm-suggest`) 나란히, [새 시각으로 맞추기] = 내 조건 그대로 `alarm-commit` — Edge. 공동 약속 변경 알림 `needsConfirm`일 때 열림(알림 받는 곳은 푸시 앱 PR)
- 저장: `appointments` + `appointment_participants` + `alarms`("알람" 줄에서 고른 종류 — 기상 · 준비 · 출발, 다 끄면 알람 없는 일정, D46)를 한 번에 `alarm-commit` — Edge, 준비물 `todos`(ITEM) — DB → 예약 — 폰
- 반복: 요일 칩 · 매일 · 평일 → `appointments.recurrence_rule` RRULE (D44, `FREQ=DAILY` · `FREQ=WEEKLY;BYDAY=…` 두 모양만). 저장은 첫 회차만 만들고, 다음 회차는 `alarm-roll`이 앞으로 14일치를 회차마다 새 행(약속 · 참여 · 알람 · 준비물)으로 미리 만듦 (D4 A, 5분마다 보충 · 앱 맞추기 때 본인 몫). 공동 약속은 첫 회차만 · 저장 직후 앱이 `syncNow({ rollSeriesId })`로 바로 넘기고(준비물 저장 뒤), 평소엔 앱이 앞에 올 때 10분에 한 번
- 계산이 집 위치 없음(프로필에 `home_lat` · `home_lng` 없음)으로 실패하면 안내 카드 [집 정하기] → 장소 시트로 고른 곳을 `saveProfileFields({ home_name, home_lat, home_lng })`로 `profiles`에 저장 → 다시 계산 (토스트로 "장소를 다시 골라"만 뜨던 것을 대신함)
- 확인 시트에서 시각 고치기 (D43): 기상을 옮기면 나머지도 따라 움직이되 순서가 뒤집히면 막음, 고친 값은 `user_edit_logs`

### H07 알람 울림
- 소리 · 강도 · 미루기 · 해제 — 폰
- 알림 글자 (이슈 #230): 준비 = `오전 8:40 출발까지 30분`, 출발 = `지금 나가면 오전 9:50 도착 · 여유 10분`을 새 알림 없이 기존 준비 · 출발 알림 한 줄에 합침(D65 기본안) — 서버 `_shared/ring-package.ts`가 만들어 꾸러미 `notice`로 줌. 웹 미리 보기 `ring`은 같은 함수(`features/alarm/notice.ts`)로 머리글을 그림. 기상 알람의 음성 문장(`voiceText`)은 읽어 주기(D8)가 붙기 전까지 폰이 저장만 함
- 기록: `alarm_events` TRIGGERED · SNOOZED(`snooze_minutes`) · DISMISSED — DB (오프라인이면 폰에 보관 후 다시 보냄). 기록마다 앱이 만든 번호 `client_event_id`(유니크 — 같으면 무시) · 출처 `input_source` (둘 다 #160)
- 준비 · 출발 알람 해제(11/19, 준비 · 출발이 알람이 됨)와 도착 알림 원탭("도착했어요"): `alarm_events` DISMISSED(PREPARE → 준비 시작. DEPARTURE는 위치로 출발을 판단하는 약속이면 해제만, 감지가 꺼진 사람은 ACKNOWLEDGED(DEPARTURE)도 함께 남겨 출발) · ARRIVAL_CONFIRMED(ARRIVE) + `appointment_participants.prepare_started_at` · `departed_at` · `arrived_at` — DB (예전 APK의 원탭 ACKNOWLEDGED도 같은 뜻). 폰이 앱을 안 열고 바로 올리고, 앱은 열릴 때 같은 기록으로 지각 · 준비 실측 · 이동시간을 이어서 셈. 쓰는 곳은 `recordParticipantTimes` 하나이고 지오펜스 자동 수집(#40)도 같은 함수를 `source: LOCATION`으로 부름
  - 위치 자동 우선 (지형님 10/29 흐름 확인 #240 + 7장 A~F 자동 수집 우선): 자동으로 잡은 값은 그대로 확정('확인 중' 상태 없음), 경계가 애매하면 사용자에게 유리한 쪽, 원탭은 자동 값이 없을 때 대신 쓰는 길(원탭 알림 건너뛰기는 PR 6), [아니에요]는 틀렸을 때만 누르는 정정
  - 출처 우선순위: 사용자 응답(원탭 `BUTTON` · 직접 입력 `MANUAL`) > 위치(`LOCATION`). 위치 값이 먼저 있어도 원탭이 덮고(출처도 응답 것으로 바뀜), 응답 값이 있으면 위치는 못 덮음 (응답끼리는 먼저 쓴 값). 위치 출발끼리는 더 늦은 출발로 바꿈 — 귀가 뒤 다시 나가면 그쪽이 출발(7.13.7 "약속 전 마지막 출발"), 앞 출발의 위치 기록 줄은 지우지 않고 '확인할 기록'으로 남겨 자기 전 대화(L4)가 확인. 위치 도착끼리는 먼저 쓴 값. 출발 · 도착이 바뀌면 그 값으로 셈한 `actual_travel_minutes`를 같은 줄에서 비우고 다시 셈. 출발 · 도착이 둘 다 위치(`LOCATION`)로 잰 값이면 도착 − 출발에 반경 보정 4분을 더함(7장 7.13.7 반경 보정, `TRAVEL_CORRECTION_MINUTES`, 실기기 측정으로 조정) — 한쪽이라도 응답이면 안 더함. 지금 값의 출처는 출처 칸 `departed_source` · `arrived_source`로 읽음 — 시각만 있고 출처가 비면 옛 앱 원탭 값이라 `BUTTON`. 위치 값을 쓰면 그 출발 · 도착 알람에 `alarm_events`(`input_source LOCATION`, 번호 고정)를 같이 남겨 기록 화면 "자동 · 지오펜스" 줄이 됨 (알람 행이 없으면 안 남김)
  - 지각(`is_late` · `late_minutes`, D58 · #41): 응답으로 받은 도착은 약속 + 5분 초과면 지각. 위치로 잡은 도착은 바로 판정(보류 없음) — +11분(응답 경계 5분 + 감지 지연 최대 6분) 초과면 지각, 지각 분은 감지 지연 6분을 뺀 값 (D61 감지 지연만큼 넓힘, 지연 빼기는 작성자 판단). 둘 다 NULL은 약속 시각을 못 읽었을 때뿐
  - 500m 안 가까운 약속: 출발 · 도착 감지는 그대로, `actual_travel_minutes`만 안 씀 (D68 "500m 안이면 이동 측정을 끄고 기본값" — 끄는 것은 이동시간만, 안건후보 D78 정리)
  - 준비 실측(`daily_records.actual_prepare_minutes`) = 출발 − max(실제 기상 `wake_confirmed_at`, 예정 기상 = 그날 켜 둔 기상 알람 중 가장 이른 시각). 출처와 상관없이 출발이 들어올 때, 기상 기록이 둘 다 없으면 비움, 이 일정 사슬(참여 조건의 알람)에 기상 알람이 없으면(저녁 규칙 · 직접 끔) 안 씀, 기록 범위(10~240분, D107) 밖이면 안 씀(저장 단계에서 거름, #329), 이미 값이 있으면 덮지 않음(같은 날 두 번째 약속의 출발은 준비 실측이 아님). 예외: 같은 참여 조건의 출발이 바뀌어(응답이 덮음 · 더 늦은 위치 출발) 그 출발로 셈한 값이면 새 출발로 다시 셈

### H08 기상 확인
- 기상 확정 뒤 오늘 아침 루틴(getTodayRoutine)에 남은 단계가 있으면 1.5초 뒤 H09로 자동으로 — 이 화면에서 확정됐을 때만(이미 확정된 화면을 다시 열면 그대로), 실데이터 울림 미리보기는 빼고
- 판정(폰 사용 · 버튼) → `alarm_events` WAKE_CONFIRMED + `daily_records.wake_confirmed_at` — DB
- 확정 시각 = 해제 뒤 누적 화면 사용이 θ를 넘은 시각 (D14) — 판정은 관찰 10분이 끝나야 되고 기록만 그 시각으로 남김. 확인 알림에 직접 응답하면 응답 시각
- 해제 뒤 H08을 안 열어도 앱이 앞에 올 때 최근 12시간에 끈 기상 알람 중 확정이 없는 것을 같은 판정으로 다시 보고 확정 기록 (`useWakeRecheck`). 앱을 안 열어도 폰이 해제 + 10분 2초에 정확 알람 → 급한 작업으로 같은 규칙(`WakeJudge.kt`)으로 스스로 판정해 확정이면 `alarm-events-device`로 기록 (정확 알람 권한이 없으면 늦을 수 있음 — 그때는 이 재판정이 같은 번호로 처리, `docs/alarm-core.md`)
- [먼저 깼어요] (D61 · 친구 7장): 기상 알람 전 60분 안에 울릴 켜진 기상 알람 `alarms`(WAKE · 아직 울림 · 확인 기록 없음) — DB → 누르면 지금 시각으로 WAKE_CONFIRMED(BUTTON) + 하루 기록 — DB. 그룹에는 바로 '일어났어요'. 폰 알람 미리 끄기는 안 함(알람 코어 몫)
- 확인 알림 원탭 → WAKE_CONFIRMED(알림 응답) — DB, 끝까지 안 깨면 MISSED 기록 + 미확인 푸시 — `wake-check` 배치(아래 표, 기준은 상세설계서 7장 7.9.2). **다시 울림 없음** (D2 = B) — 앱의 가짜 시연 `missWake` · "응답 없이 5분 지나기"는 뺌
- 기상 확정 뒤 "오늘 첫 일정" 한 줄 (이슈 #230): `getMorningPlan()`(H01 아침 카드와 같은 함수) — "오늘 첫 일정 오전 10:00 전공 수업 · 세종대학교" · "오전 8:40에 나가면 돼요" · "다음 알림 · 준비 오전 8:10 · 출발 오전 8:40"(아직 안 울린 것만). 일정 줄을 누르면 H03. 켜진 기상 알람이 붙은 일정이 없으면 "오늘은 기상 알람이 걸린 일정이 없어요". 못 읽어도 확정 화면은 그대로 (덧붙임 줄)


### H09 아침 루틴 음성 진행 (`app/routine-run.tsx`)
- 오늘 아침 루틴: `routines` + 단계 알람의 오늘 확인(ACKNOWLEDGED) — `routine/api` getTodayRoutine (홈 "오늘 루틴" 카드와 같음). 없으면 "오늘 아침 루틴이 없어요"
- 열리면 저절로 시작 (UI 단순화 — [시작] 버튼 없음, 연결 페이지는 누르지 않아도 소리를 냄) → 실데이터: 서버 `routine-live-token`(지침 · 오늘 루틴 · 다음 알람 · 도구 잠김)으로 Gemini Live 연결(`useLiveVoice`, 30초 무발화 끔 · 10분 상한). AI가 단계를 한 번에 하나씩 말하고, 도구 `step_done` · `step_skipped` · `routine_finished`로 앱에 알림 → `routine/run.ts` applyTool로 화면 · `checkRoutineStep`(그 단계 알람에 오늘 확인, 출처 VOICE)
- [했어] · [건너뛰기] → 같은 기록(출처 BUTTON) + Live에 앱 글(buttonNote)을 넣어 AI가 다음 단계로. 연결이 끊기면 "음성 다시 켜기"
- 알람이 없는 단계는 확인을 남길 자리가 없어 화면에서만 셈 (홈 카드와 같은 한계)
- 가짜 데이터: 음성 대신 대본(coachLine)으로 AI가 할 말을 보여 주고 버튼으로 진행
- 들어오는 길: 기상 확정 뒤 자동(H08) · 홈(H01) 오늘 루틴 카드 아래 "음성으로 진행 ›"(남은 단계가 있을 때, 카드 밖 — 카드는 누르면 다음 단계를 끝내는 버튼)
### F01 · G01 친구와 그룹
- 맨 위 (D110, 홈 아래에서 옮김) — 알람 조정 제안 카드는 뺌 (UI 단순화: 제안은 A02 저녁 AI 대화 카드 한 곳, 자세히는 S01). `suppress_until`은 "이 시각 전엔 같은 종류 제안을 만들지 않음"이라 `suggestion-generate`에서만 봄
- 맨 위 (D110, 홈 아래에서 옮김) — 그룹 기상 요약: `get_group_wake(group_id)` — RPC. 그 그룹 일정이 있는 날만 (D57), 약속 없는 날은 '오늘 n명 일어남' 줄을 숨김
- 친구 목록: `friends`(ACCEPTED) + 이름 · 사진 `get_public_profiles` — DB · RPC
- 받은 요청: `friends`(PENDING, 받는 사람 = 나) — DB, 수락 → ACCEPTED — DB
- 아이디 검색 · 요청: `find_profile_by_handle` — RPC → `friends` PENDING 추가 — DB
- 그룹 목록 · 만들기: `groups` + `group_members`(JOINED) — DB (만든 사람은 자동 JOINED)
- 초대 코드로 참여: 미리보기 `preview_group_by_code` — RPC → 동의 시트 → `join_group`(`p_wake_share`) — RPC. 받은 초대 카드 `my_group_invites` — RPC, [참여] `accept_group_invite` — RPC, [거절] 내 `group_members` 초대 행 삭제 — DB (친구 5장)
- 오늘 n명 일어남: `get_group_wake` — RPC의 `CONFIRMED` 수(분모 없음). 그 그룹 일정이 있는 날만, 없는 날은 줄을 숨김 (D57 · 친구 7장)

### F02 친구 권한
- 관계별 받은 권한: `sharing_permissions`(주는 사람 = 친구, 받는 사람 = 나, 출처 FRIEND · GROUP) — DB → 최종 = 항목별 OR (앱에서 합침). 기상 조회는 권한 행의 값이 아니라 그 그룹의 기상 공유 동의 하나(`wake_share_opt_in`)로 계산 — 알람 권한 행이 없어도 동의한 그룹은 줄이 생기고, 친구 출처에는 기상 조회가 없음. 안내 '내가 OO님에게 준 권한을 관계별로 합친 결과예요'

### F03 공유 권한 설정
- 내가 주는 권한 저장: 친구 관계 = `sharing_permissions` 내 행 하나 upsert(알람 조회 · 알람 설정 2개만, `can_view_wake`는 항상 꺼서) — DB. 그룹 관계 = `save_group_permissions(p_group_id, p_can_view_alarm, p_can_edit_alarm)` 한 번 — RPC(참여 중 멤버 전원에게 같은 값이 전부 되거나 전부 안 됨, 값이 그대로여도 저장해 나중에 들어온 멤버 몫 설정 행이 생김, 혼자인 그룹은 `NO_MEMBERS` → 오류). 그룹의 기상 상태 조회 스위치 = 이 그룹 기상 공유 동의: `group_members.wake_share_opt_in`을 내 행만 update(값이 바뀐 때만)
- 받은 권한 보기: `sharing_permissions`(받는 사람 = 나) — DB
- 설정 권한은 조회 권한이 있어야 실제로 쓸 수 있음(= 시각 제안을 보낼 수 있음) → 화면에서 설정을 켜면 조회도 같이 켬
- 알람 조회 줄 아래 안내 '일정 장소도 보여요 · 집 · 출발지는 안 보여요' (친구 13장, 화면 글자만 — 서버는 일정 장소까지만 내려줌)

### G02 그룹 상세
- 그룹 · 멤버: `groups` + `group_members` — DB, 기상 공유 동의 `wake_share_opt_in` · 출발 · 도착 공유 동의 `trip_share_opt_in`(기본 끔, 기상 공유를 켠 사람만 켜지고 기상 공유를 끄면 같이 꺼짐) — DB
- 연결 일정: `appointments`(`group_id`, 오늘부터, `creator_id`) — DB + 인원수 · 내 참여 `group_appointment_counts` — RPC. 줄을 누르면 참여자(참여 / 알람 없음, 차단 쌍은 이름만) `appointment_joiners` — RPC. [내 알람 만들기] = `alarm-commit`(`appointment_id` + 내 집 · 수단 · 준비 시간) — Edge, [나는 빠지기] = `appointment-edit` LEAVE — Edge. 지난 약속은 '지난 약속이에요'(버튼 숨김) (친구 9장)
- 멤버 기상 상태: `get_group_wake` — RPC. 그 그룹 일정이 있는 날만 (D57). 그룹 화면 하루 = 새벽 4시 기준일(11/20, 04:00 ~ 다음 날 04:00 · 앱 `lifeDayKey`). 기상 6단계(`SCHEDULED` '오전 8:50 알람' · `RINGING` · `DISMISSED` · `MISSED` '울렸어요' · `CONFIRMED` '일어났어요 오전 8:08', `NO_ALARM` '알람 없음') + 출발 · 도착 시각 `departed_at` · `arrived_at`(그날 이 그룹 공동 약속, 여럿이면 기록이 가장 최근인 약속, 그 약속 시각 `trip_appointment_at`)과 보임 여부 `trip_visible`(본인 포함 그 멤버가 `group_members.trip_share_opt_in`을 켜고 그날 참여 행이 있음, 아니면 시각은 null) + 준비 칸 `prepare_alarm_at`(같은 약속의 그 사람 켜진 준비 알람 시각, 기상 알람이 없는 오후 · 저녁 약속의 첫 단계) · `prepare_started_at`(준비 알람 해제 시각 = 준비 시작, 11/19) — `trip_visible`이 아니면 둘 다 null. 줄이 없는 멤버는 '공유 안 함' (친구 7장 · D59 11/19 도착까지). 멤버 메뉴 [이 사람에게 기상 숨기기 / 보이기] `set_wake_hidden` — RPC, 숨긴 목록 `wake_hides` — DB(내 줄만). 누가 일어나면 DB가 그룹 채널에 새로 고침 신호(Realtime 방송, #160) → 앱이 다시 부름 (지형님 10/15 기술 결정 — `capstone/전체작업계획_v1.md` 8절 Q3, 레포 밖)
- 초대: 코드 시트 `my_group_code`(만료됐으면 서버가 새 코드 + 7일) — RPC, [새 코드] `regenerate_invite_code` — RPC, 직접 초대 `invite_to_group` — RPC (친구 5장). 그룹장 없음 — 이름 바꾸기 `groups` update · 나가기 `group_members` JOINED → LEFT · 내보내기 다른 사람 행 delete · 알림 끄기 `group_members.notifications_off` — DB

### G03 그룹원 기상 상태
- 기상 · 출발 · 도착 상태: `get_group_wake` — RPC (단계 · 알람 시각 · 확인 시각 + 출발 · 도착 시각 `departed_at` · `arrived_at` · `trip_visible` · `trip_appointment_at` — 출발 · 도착 공유를 켠 사람만, 시각만(장소 · 좌표 · 감지 출처 · 지각은 안 내려줌). 미루기 횟수 · 알람 끈 시각은 본인만 — D59 11/19 · 친구 7장. 새 칸 `prepare_alarm_at` · `prepare_started_at`은 `get_group_wake_status`에도 같은 이름으로 끝에 붙음). 준비 시작 · 출발 · 도착이 바뀌거나 공유 설정 · 숨기기 · 나가기 · 약속 시각 변경 · 취소 · 약속에서 빠짐이 있으면 기상 신호와 같은 채널(`group:<id>:wake` · `refresh` · `{date}`)로 새로 고침 신호. 준비 알람 해제 = 준비 시작은 서버가 `alarm_events`(DISMISSED)에서 빈 칸만 채움. 출발은 위치 자동 판단이고 감지가 꺼진 사람만 출발 알람 해제가 대신 — 폰이 해제와 함께 보내는 ACKNOWLEDGED(DEPARTURE)가 출발이 되고, 출발 알람의 DISMISSED는 기록만. 그 그룹 일정이 있는 날만 (D57). 알람 카드는 알람 조회 권한이 있으면 [알람 보기](G04)로
- 깨우기: `notify`(`{ kind: 'WAKE_PING', targetUserId, groupId }`) — Edge. '울렸어요'일 때만 버튼. 판정 · 횟수(보내는 사람 → 받는 사람 쌍마다 5분 1번 · 하루 3번) · 직전 재확인은 서버가 하고, 응답 `ping.status`로 버튼 아래 한 줄: `OK` '1/3 · 8:15부터 다시' · `WAIT` '8:15부터 다시' · `DAILY_LIMIT` · `OFF`(받기를 껐거나 기상이 안 보임(403) — '지금은 깨울 수 없어요'로 구분 안 함) · `ALREADY_UP`('이미 일어났어요', 상태를 다시 읽음) · `NOT_RINGING`(다시 읽음) · `NO_TOKENS`('지금은 알림이 닿지 않아요', 횟수 안 셈). 상태를 미리 읽는 곳은 없어 보내 본 뒤에 앎 — 보냄 · 기다림 · 한도 · 꺼짐 · 이미 일어남은 버튼을 잠금(다음 가능 시각이 지나면 풀림). 가짜 모드는 막힘
- 오늘 받은 깨우기: `my_wake_pings` — RPC (`sender_nickname`, `sent_at` 최신 순, 차단한 사람 것 제외) → 홈 · H08 한 줄 '수연님이 7:12에 깨웠어요'(여러 번이면 '· 오늘 n번'). 가짜 모드는 없음
- 설정 [깨우기 받기]: `profiles.wake_ping_enabled` — DB 직접 update(내 프로필, 기본 켬). 꺼 두면 보낸 쪽에는 `OFF`만 보임

### G04 공유받은 알람
- 친구 알람: `alarms`(주인 = 친구) — DB, 조회 권한은 RLS가 확인. 약속 제목 · 장소까지 보여 주려면 RPC 하나 더 필요(`appointments` RLS는 본인 · 그룹원만) — #46에서
- 설정 권한이면 시각 제안(친구 10장): 바꿀 수 있는 것은 시각뿐(켜기 · 끄기 · 삭제 없음). 5분씩 골라 [보내기] 한 번 = `propose_alarm_time(p_alarm_id = 카드에서 가장 이른 알람, p_new_at)` — RPC. 상태 `OK` · `TOO_SOON`(곧 울릴 알람) · `LIMIT`(원래 시각 기준 ±60분 밖) · `TOO_LATE`(늦추면 출발 + 이동시간이 약속 시각을 넘음 → '이대로면 약속에 늦어요') · `SAME` · `FORBIDDEN`(권한 없음 · 안 보이는 알람, 구분 없음) · `INVALID`를 문구로. 성공하면 주인에게 `notify { kind: 'ALARM_CHANGED', targetUserId, alarmId }`(문구 · 시각은 서버가 제안 기록에서 가져옴, 실패해도 제안은 저장). 상대 알람은 그대로 — 상대가 [적용]해야 바뀜. 카드 한 줄 '제안함 · 8:20'(대기 · 무시) · '반영됨 · 8:20'(적용)은 `sent_alarm_proposals(p_owner_id)`, [원래대로]는 `alarms.original_scheduled_at`(친구가 바꾼 적이 있을 때만)을 제안
- 받는 쪽 제안 카드(홈 · 알람 탭): `my_alarm_proposals` — RPC → '○○님의 제안 / 기상 알람 7:30 → 7:00 [적용] [무시]'. `respond_alarm_proposal(p_proposal_id, p_apply)`: 적용하면 서버가 알람 카드 전체를 옮기고 앱이 `syncNow()`로 폰 예약을 서버 알람에 맞춤, 무시는 보낸 쪽에 알리지 않음, `EXPIRED`는 '이미 지나간 제안이에요'

### A02 AI 대화 (실데이터는 텍스트 대화 — 서버 함수 voice-session · voice-turn과 같이 배포돼야 동작)
- 루틴 제안 카드 `RoutinePromptCard` (안건 D114): 알람 조정 제안 카드가 없을 때만 (UI 단순화: 한 번에 카드 하나, 제목 · 이유 한 줄 · 버튼 둘). 기다리는 제안 `routine_suggestions`(PENDING) — DB(`routine/api` getPendingRoutineSuggestion). [만들기] → `acceptRoutineSuggestion` = 초안(다음 기상 알람 시각에서 시작) 그대로 저장 · 제안 ACCEPTED, 토스트 [고치기] → A04 `/routine/[id]`. [괜찮아요] → IGNORED + 답한 시각 (기록 있는 아침 3번 뒤 다시, D24 C — 서버가 셈)
- 실패 · 한도 안내 부품 `ChatNotice`(값 · 콜백) — `ai.tsx`가 실패(`unavailable`) · 한도(`limits.reached`)일 때 마지막 말풍선 아래에 붙임
- 알람 조정 제안 카드 `SuggestionPromptCard` (안건 D111 5번 — 저녁 대화에서 묻기): 대화 첫 마디 바로 아래, 제목 · 바뀌는 시각 한 줄 · [적용하기] [괜찮아요] 나란히 · 오른쪽 위 "자세히 ›"(S01). 대기 중 제안 `alarm_suggestions`(PENDING) — DB(`records/api` getPendingSuggestion, S01과 같음 — 제안이 보이는 곳은 이 카드 한 곳). [적용하기] · [괜찮아요]는 `suggestion-apply`(Edge, 실데이터) → 폰 예약. 대화 서버 상태(`voice-session` · `voice-turn` · 카드 종류)와는 따로라 대화에는 안 남음
- 가짜 데이터: 목업 대본(`mocks/ai.ts`) 그대로. 카드는 찾은 일정 한 장(`cards[0]`, 번호 c1)
- 실데이터(`features/voice/real.ts`, 설계 `L4_자기전_설계메모.md` 1 · 2 · 5절): 글로만 대화 — 말하기 버튼 없음("키보드 마이크로 말해도 돼요")
  - 시작: `voice-session {session_type: BEFORE_SLEEP, input_mode: TEXT, resume: true}` — 대화방은 KST 달력 날짜, 기록은 기준일: 오늘 연 대화방이 있으면 이어서([완료] 뒤 다시 열어도 같은 대화 · 카드, 자정이 지나면 새 대화방). 0시 ~ 기상 전에 연 방을 기상 뒤에 열면 같은 방의 다음 구간 세션(`server_state.prev_session_id`)을 만들어 화면 말 · 카드(번호 그대로, 열린 알람 바꾸기 카드만 FAILED)는 이어 주고 기록(구조화 JSON · 일기)은 구간마다 제 기준일로 — 응답 `prev_session_ids`로 앱이 앞 구간의 저장됨 표시를 옮김. 첫 마디는 서버 템플릿. 하루 한도면 `session_id: null` · `limits.reached: DAY`
  - 말: `voice-turn {session_id, rev, client_turn_id, text}` (25초 timeout, `lib/edge`). 응답 `next: APP_TASKS`면 앱이 카드마다 일을 하고 `voice-turn {results}`(같은 client_turn_id · rev는 응답의 rev)로 돌려준 뒤 마지막 `reply`를 받음
  - 앱 일: 새 약속 카드(`APPT_NEW`) = 장소 이름이 `listPlaces(이름)`에 똑같이 하나면 그 좌표로 `estimateAppointment`, 아니면 `NEEDS_PLACE`(카드의 [장소 고르기] = 장소 검색 시트) · 시각 고침 `adjustEstimate` / 알람 고치기(`ALARM_EDIT`) = `getAppointment` + `previewAlarms`(시각 · 준비가 바뀔 때만) / 정정 `fixes` = `features/voice/fixes.ts` — 새 시각 `recordParticipantTimes(MANUAL)` + 고친 값 기록(user_edit_logs, 화면 A02) 한 줄, 부정(위치 값 지우기)은 L2 PR 6 뒤 연결
  - 카드 버튼: [저장] = `createAppointment(estimate, '자기 전 대화')`(준비물 같이) · 약속 없는 알람 = `createStandaloneAlarm` · [바꾸기] = `saveAlarmSettings` · 준비 ±N(줄이기 · 0 = 자동으로) · 강도(null = 보통으로 → 자동)는 **실제로 바뀐 때만** 저장 뒤 `saveAlarmSettings` 한 번 더(alarm-commit이 길찾기를 또 부르므로) → `voice-turn {card_action: SAVED, appointment_id, alarms}` / [저장 안 함] = `card_action: REJECTED`(서버는 답 없음)
  - 완료: 대화를 그대로 남기고(세션을 끝내지 않음) 홈으로 + 하루 기록 정리 `voice-commit {session_id, rejected_cards}`를 기다리지 않고 보냄(`rejected_cards` = [저장 안 함]한 카드 — 서버에 못 알렸어도 서버가 열린 카드만 REJECTED로) — 서버가 T2(T2.v3.3 · extract.v2)로 대화 전체(글 · Live 음성)를 뽑아 공개 JSON `structured.v1`을 `conversation_sessions.extracted_data`에 저장(기본 저장소, 다른 담당자가 읽는 계약 — 노션 'Voice AI 구조화 결과'), `apply_status` · `transcript`도. 표에는 `todos`(할 일 · 준비물, D32 A)와 `daily_records`의 진술 칸(`sleep_at` · `sleep_satisfaction` · `condition_note`)의 빈 칸만. 일정 · 알람은 저장하지 않음(카드로만). 지각 · 출발 · 도착 진술은 JSON에만(`appointment_participants`는 위치 · 원탭 담당), `alarm_events`도 안 씀. JSON 저장이 끝나면 그날(`reference_date`) 대화들의 JSON 중 말했거나 확인한 사실(`inferred` · `needs_confirm` · 다른 날 뺌)로 T5(T5.v2 · t4-diary.v1) 한 번 → 일기 1~2문장을 `daily_journals.ai_summary`에(하루 한 줄, `source_session_id` = 이번 대화, 고친 일기(`is_edited`)는 그대로 · 쓸 사실이 없으면 안 만듦 · 실패하면 이 단계만 `PARTIAL`). 실패 · `PARTIAL` · `STALE`(정리하는 사이 새 말이 옴)이면 세션 id를 로컬(`respec.voice.commit.<사용자 id>`)에 남겨 다음 대화 열기 때 다시 보냄. 앞 구간이 있으면 그 구간을 먼저 그 기준일로 정리(못 하면 `PARTIAL` · `failed: previous_session`). 같은 날 이어 말하고 다시 [완료]하면 서버가 새 말까지 다시 추출(`server_state.commit.at_turn`보다 말이 늘었을 때만) — 할 일은 같은 대화가 만든 것을 건너뛰고 · 생활 기록은 빈 칸만 · 일기는 고친 것을 안 덮고 다시 씀. 새 말이 없으면 저장한 답 그대로
  - 대화 상태(세션 · rev · 카드 · 계산한 Estimate)는 앱 메모리. 앱을 다시 열면 voice-session resume으로 말 · 카드 상태를 받고, 저장 전 Estimate는 다시 계산 (D5 — 이동 분을 서버에 안 남김). 계산이 안 끝난 카드(`NEEDS_ESTIMATE`)는 이어서 계산해 새 client_turn_id로 `results`만 보냄. 저장한 카드는 서버에 SAVED를 알리기 전에 로컬(AsyncStorage · 웹 localStorage, 키 = 사용자 id + 세션 id, 값 = 카드 id별 · 7일 지나면 앱을 열 때 정리, 다른 계정에는 안 보임)에 '저장됨'으로 적고, 알림이 안 가고 앱이 꺼져도 다시 열면 `createAppointment` 없이 저장됨으로 복원해 SAVED만 다시 알림(서버가 SAVED로 확인하면 지움). 실패한 요청이 남은 동안 카드 [저장] · [저장 안 함] · 장소 고르기는 앱 일만 바로 하고 서버 알림은 큐에서 기다렸다가 그 요청이 [다시 시도]로 성공한 뒤 차례로 보냄
- 오류 · 상태 (화면 문구는 `lib/edge`의 code → 문구):

| 상황 | 앱이 하는 일 |
|---|---|
| `LLM_UNAVAILABLE` · `NOT_CONFIGURED` · `NETWORK` · `TIMEOUT` · `INTERNAL` | 던지지 않음. 대화 · 카드는 남기고 마지막 말풍선 아래에 "AI가 지금 답하지 못해요" + [다시 시도](같은 요청 · 같은 client_turn_id) · [직접 일정 만들기] · [대화 마치기]. `details`의 `cards` · `rev` · `limits`로 상태를 복원. 키가 없으면 `voice-session`은 첫 마디까지 주고 `voice-turn`만 `NOT_CONFIGURED`(보낸 말은 서버에 안 쌓이고 같은 요청을 다시 보내면 됨) |
| `CONFLICT` (rev 어긋남) | `voice-session` resume으로 다시 읽고 오류 안내(보낸 말은 입력칸으로). 앱에서 이미 저장한 카드는 서버가 몰라도 저장으로 둠 |
| `NOT_FOUND` (세션 · 카드 · 정정 번호) | 같은 방식으로 세션을 다시 읽음 |
| `limits.reached` TURN · DAY | 오류가 아님 — 마지막 답은 정상 reply로 보이고 그 뒤 입력만 막음. TURN(대화당 말 100) "오늘 대화가 길어져서 여기까지예요" · DAY(하루 사용량) "오늘 AI 대화는 여기까지예요" + [대화 마치기] · [직접 일정 만들기] |
| `LLM_UNAVAILABLE` + `details.code: RATE_LIMITED` | 분당 사용량(서버 관문 RPM · TPM · 동시 요청, Gemini 429) — "지금 AI 요청이 몰렸어요 · 1분쯤 뒤에 다시" + [다시 시도] |
| 그 밖 (`VALIDATION_FAILED` · `AUTH_REQUIRED` …) | 던짐 → 토스트, 보낸 말은 입력칸으로 |

- 대화 기록: `conversation_sessions`(`turns` · `server_state`) — 서버만 씀(앱은 읽기만)
- 일정 · 알람 저장: 앱이 L1 함수로(`appointments` · `alarms`), 준비물은 카드와 같이. 대화 끝 정리의 할 일 · 준비물(`todos`)은 서버 PR 5 (D32). 일정을 여러 개 찾으면 다 받음 (D36) — 기상과 이어지는 첫 일정(`first_of_day`)만 알람 줄을 자세히, 나머지는 "출발 알림" 한 줄. 카드별 상태는 서버 `server_state.cards`

### A03 하루 기록 · 일기
- 루틴 제안 (안건 D114 · D30 B): 오늘 일기에는 루틴 제안 카드를 두지 않음 (UI 단순화 — A02 저녁 AI 대화 한 곳). 일기 줄의 `routine_suggestion` 칸은 옛 흐름(가짜 데이터)만
- 일기: `daily_journals`(AI 글 · 고친 글 · 코칭 · 격려 · 루틴 제안) 읽기 · 고치기 — DB, 만들기 — Edge(`voice-commit`이 AI 글 `ai_summary`만, 코칭 · 격려 · 루틴 제안은 아직 없음). 날짜별로 엶 (R02 일간에서, D48)
- 오늘의 사실: `alarm_events` · `appointment_participants`(출발 · 도착 · 지각) · `todos` — DB

### A04 루틴 편집
- `/routine/new?suggestion=…` (안건 D114): 루틴 제안 초안 — 이름 · 목표 · 요일 · 단계(기상 기준 분 → 다음 기상 알람 시각, 없으면 7:00 · 밤 루틴은 고정 시각). 저장하면 `routines`(origin AI_SUGGESTED) + 단계 알람 → 그 제안을 ACCEPTED + 만든 루틴 — 제안 카드의 [만들기]는 이 초안을 열지 않고 바로 저장함(UI 단순화), 이 주소는 고치고 싶을 때만
- 루틴: `routines`(이름 · 목표 · 요일 · 단계 `steps` · 켜짐) — DB
- 단계 알람: `alarms`(`routine_id` · `step_order`) — DB → 예약 — 폰. 루틴을 끄거나 단계(알람)를 빼면 알람을 지우지 않고 `is_enabled` false (지우면 울림 · 확인 기록 `alarm_events`가 같이 사라짐). 다시 켜면 같은 줄(루틴 · 단계 번호가 하나뿐)을 켬. 폰 맞추기는 저장이 중간에 실패해도 함

### R02 나의 기록
- 자리: 기록 탭이 없어지고 홈(H01) 맨 아래 "나의 기록" 구역 (D110). 데이터 · 날짜 이동은 아래 그대로
- 월간: `daily_records`(그 달) — DB. 달력 점 "완료"(지난 날) = 기상 확인 `wake_confirmed_at` + 준비 실측 `actual_prepare_minutes` (출발 입력 때 `recordParticipantTimes`가 씀). 서버의 예상 준비시간 P80(`v_prepare_time_stats`)도 이 값을 읽음
- 주간: `daily_records.wake_confirmed_at` + `appointment_participants.is_late` — DB → 평균 기상 · 목표 기상률은 앱에서 계산
- 일간: 설정값 `alarms`(켜진 것만 — 일정을 통째로 꺼 둔 날은 도착 목표도 없음) + 실제 `alarm_events` — DB
- 날짜 이동 (D48): 월간 · 주간 날짜를 누르면 그날 일간, 일간 이전 · 다음 · 오늘, 일간에서 그날 일기(A03). 점수 · 달력 점 규칙은 D26 · D27

### S01 알람 조정 제안
- 제안: `alarm_suggestions`(PENDING) — DB
- 알람 값 제안(말소리 · 배경음 · 진동) 적용 · 되돌리기 · 무시: `alarms`(그 칸) + `status` · `result_value` · `responded_at` — DB → 그 알람만 다시 예약 — 폰. 배경음 제안은 이전 값이 비어 있어도(기본음) 되돌릴 수 있음(`sound_key` null)
- 준비 알람 당김(PREPARE_ADVANCE, 안건 D111): 근거 `alarm_suggestions.evidence`, 그 회차 알람(기상 · 준비 · 출발) — DB. 적용 · 고쳐 적용 · 되돌리기 · 무시는 `suggestion-apply`(Edge) — 이번 회차와 이후 회차의 `appointment_participants.prepare_advance_minutes` · 알람 시각을 바꾸고 `ring_packages`로 폰 예약. 되돌리면 대기(D23 A)
- 직접 수정 (D53): 준비 알람을 1분 단위로 더 당기기(30분까지 · 당김 합 120분까지), 기상 · 출발 미리 보기, 적용한 뒤에도 다시 고침 (EDITED · `result_value` = 당긴 뒤 당김 분 — 실데이터는 되돌린 뒤 새 값으로)
- 제안 만들기: `suggestion-generate`(매일 18:00 KST 배치) — Edge

### NTF 감지 안내 알림 · 정정 (`detection`, 목업에 없는 화면)
- 알림: 위치로 출발이 잡힌 순간(이탈, 확정은 5분 뒤) "출발 오전 8:30 감지", 도착을 서버에 쓴 직후 "도착 오전 9:52 감지" — **폰 안에서 만든 소리 없는 로컬 알림**(채널 `detect_v1`, 서버 푸시 아님). 알림 권한이 없으면 띄우지 않음(권한은 묻지 않음). 5분 안에 돌아와 출발이 취소되면 그 알림을 거둠. 누르면 `respecalarm://detection?kind&participantId&at` — 앱이 꺼진 채여도 열림 (`features/location/notice.ts` · `hooks/useDetectionLinks.ts`)
- 정정 화면: 열자마자 `rejectDetection({ participantId, kind, screen: 'NTF' })` — 위치 값만 지움(원탭 · 직접 입력 값이면 null → "이미 바뀐 기록이에요"), 폰 판정 기억에서도 잊음(`features/location/correct.ts`, 5분 대기 중이던 출발 포함). 지운 뒤 5초 동안 [되돌리기] = `undoReject` + 폰 기억 되돌림. 지운 뒤 · 되돌린 뒤 `syncNow` · `syncLocation`으로 폰 예약과 감시 계획을 다시 맞춤 — DB(`appointment_participants` · `user_edit_logs`)

### 로그인 · 온보딩 · 설정 (#25)
- 로그인: Supabase Auth 카카오 · 구글 → 가입하면 `profiles` 자동 생성. 화면 아래의 "알람 테스트" 버튼은 `/dev/alarm-test`로 바로 감 (로그인 전에도 열림, 화면 위 "← 이전"으로 돌아옴, #177)
- 온보딩: `profiles` 아이디(`handle`) · 닉네임 · 잠귀(`wake_sensitivity`) · 집(`home_name` · `home_lat` · `home_lng`) · 기본 준비 · 여유 시간 · 이동 수단 · 깨우는 여유(`wake_margin`) · 개인정보 동의(`privacy_agreed_at` · `privacy_version`) · 온보딩 끝낸 시각(`onboarded_at`) — DB, 집 검색 `place-search` — Edge
  - **개인정보 동의 단계** (친구 13장): 항목 5개(위치 · 화면 사용 · 음성 · 기상 공유 · 알람 공유) + '만 14세 이상이에요' 확인(체크 전에는 [다음] 잠김). 안내 판 번호 `PRIVACY_VERSION = 3` — 이 판에 이미 동의한 계정이 온보딩을 다시 열면 체크 없이 통과(다시 저장 안 함), 판이 낮으면 다시 동의. 온보딩을 마친 계정은 앱을 열 때 `privacy_version < PRIVACY_VERSION`이면 `/reconsent`(동의 항목 + 만 14세 확인만)가 먼저 뜨고, 동의하면 판 · 시각(`privacy_agreed_at`)을 저장하고 프로필을 다시 읽어 홈으로 (`needsReconsent`, `features/auth/onboardingGate.ts`). 오프라인 · 읽기 실패 때는 묻지 않음. 로그아웃 저장본은 친구 읽기 값이 계정별(`me`)로 따로 읽혀 따로 비우지 않음
  - **단계 온보딩** (`lib/flags` `ONBOARDING_IN_FLOW = true`, #25): 순서는 `features/onboarding/steps.ts`, 단계마다 켜고 끄는 표는 `ONBOARDING_STEPS`(아이디 → 닉네임 → 잠귀 → 집 → 아침 준비 → 시간표 → 동의 → 권한 안내 → 기상 공유 → 첫 일정). 집: 장소 검색(`place-search`)으로 고르면 `home_name` · `home_lat` · `home_lng` 저장(좌표 없는 장소는 못 고름, [나중에]는 저장 없이 다음). 시간표(직접 입력 초안, D66-1 B): 수업 줄(과목 · 요일 · 시작 시각 · 장소)마다 차례로 `estimateAppointment` → `createAppointment(…, '온보딩 시간표')`로 반복 일정 + 알람 저장, 실패한 줄만 표시하고 그 단계에 머묾, 첫 저장 뒤 알림 안내. 권한 안내: 알림 · 전체화면 알림 · (꺼졌을 때만)정확한 알람 · 사용 정보 · 배터리 · 삼성 절전 줄의 상태 표 + 사용자가 누르는 [켜기] · [설정 열기]만(`permissionRows`, 자동 시스템 창 없음, 안 켜도 [다음]), 위치 줄(안드로이드 + 실데이터만, `ONBOARDING_LOCATION_ROWS`): 누르면 `LOCATION_DISCLOSURE` 고지 → `requestLocationAccessFlow()`(앱 사용 중 → 항상 허용 설정 화면), 나중에 · 거절은 설정 카드로(`useLocationRow`). 단계마다 [다음]에서 `saveProfileFields`로 저장하고 마지막에 `finishOnboarding`이 `onboarded_at`을 적음. 판정은 `onboarded_at`이 비었는지(`features/auth/onboardingGate.ts`). 가짜 데이터 모드 미리 보기는 저장 없이 단계만 넘김. `/dev/screens`의 "온보딩부터 다시"로 처음부터 다시 봄
  - 개발 화면 목록(`/dev/screens` · 웹 미리보기 패널)에서 단계마다 바로 열기: `/onboarding?step=home` — 가짜 데이터 모드(저장 안 함)에서만, 실데이터는 늘 첫 단계부터 (`steps.ts` `startStep`)
  - 개발 화면 `/dev/screens`의 **내 시험 데이터 지우기** (실데이터 + 로그인 + 모드를 바꿀 수 있는 빌드에서만, 출시 빌드에서는 숨김 D16): 확인 창 → `features/dev/api` `resetMyTestData`(DB 함수 `dev_reset_my_data` — 내 일정 · 알람 · 기록 · 일기 · AI 대화 · 고친 값 기록 · 제안을 지우고 프로필을 온보딩 전으로, 그룹 일정은 내 참여 행만, 친구 · 그룹 · 푸시 토큰 · `ai_calls` · 루틴은 그대로) → `lib/session` `cleanupAfterDataReset`(폰 알람 전부 취소 · 못 올린 울림 기록 버림, 로그아웃 없음) → 프로필 다시 읽기 → 온보딩. 가짜 데이터 모드에서는 "지울 게 없어요"
  - 가입 직후 프로필: 닉네임 = 카카오 · 구글에서 가져온 값(DB 트리거), 준비 60분 · 여유 10분 · 이동 수단 대중교통 · 잠귀 보통 · 깨우는 여유 보통 = DB 기본값(온보딩 입력칸 처음 값), 집 · 아이디 = 비어 있음
- 온보딩 단계 부품 초안(`features/onboarding/components/`): `OnboardingFrame`(틀) · `HomePlaceStep` · `TimetableStep` · `PermissionsStep` · `OnboardingDoneStep` — 값 · 콜백만 받고 api · 라우터를 부르지 않음(L7이 함수를 붙임). `/dev/onboarding?mode=mock`에서 가짜 값으로 넘겨 봄 (`/dev/screens` 목록에는 없음, #116)
- 설정에서 값 바꾸기: 닉네임 · 아이디 · 잠귀 · 깨우는 여유 · 준비 시간 · 여유 시간 · 이동 수단 · 집 줄을 누르면 편집 시트(`features/profile/components/ProfileEditors`, 온보딩 단계 부품 재사용) → [저장]이 `saveProfileFields` → `profiles` — DB. 집은 지도 고르기 시트(아래). 실데이터 + 로그인일 때만 열리고 가짜 모드는 보기만. 아이디는 중복 확인(`isHandleTaken`) 뒤 저장 (L3 `changeHandle`이 오면 교체)
- 지도 고르기 시트(`features/alarm/components/MapPlaceSheet`, 지금은 설정의 집 바꾸기에서 열림): 카카오맵 지도(`public/map-picker.html`을 웹은 iframe · 앱은 WebView로 열고 JavaScript 키 `EXPO_PUBLIC_KAKAO_JS_KEY`는 공개 값) + 검색 `listPlaces`(`place-search` — Edge) + 핀 자리 주소 `reverseAddress`(`place-reverse` — Edge, 핀이 멈춘 0.4초 뒤) + 폰 위치 한 번 `locateOnce`(앞 권한만, 폰). 고른 값은 시트가 저장하지 않고 `onPick`으로 돌려줌(집은 `profiles` — DB). 카카오 응답은 저장하지 않음(D5). 키가 없으면 지도 칸이 "지도 준비 중"이고 검색 결과로만 정함
- 자주 가는 곳 (설정 "자주 가는 곳" 절, 지도에서 위치 고르기 ②, 이슈 #31): 학교 · 회사 · 알바 등 최대 5개 — `user_places`(이름표 `label` · 장소 이름 `name` · `address` · 좌표 · 반경 `radius_m`) — DB. 집은 위 `profiles` 그대로. **본인만 읽고 씀, 친구 · 그룹에 공유하지 않음**(Q13 · D59), 한 사람 5개까지(DB 트리거 + 앱 `UserError`). 함수: `features/location/api.ts` `listUserPlaces()` · `saveUserPlace({ label, name, address?, lat, lng, radiusM? })`(같은 이름표면 덮어씀) · `deleteUserPlace(label)`. 저장 규칙: 지도 시트 "이름" 칸이 이름표, 장소 이름은 핀 자리 주소(없으면 검색 이름). 칩 부품 `features/location/components/FrequentPlaceChips`(값 `places` + `onPick`만 받음)은 새 일정 장소 줄(H05)과 온보딩 시간표 장소 기본값(L7) 위에 꽂아 씀 — 이 PR은 부품만 내보냄. 가짜 모드는 메모리 배열(학교 · 회사)
- 시간표 가져오기 확인(`app/timetable-import.tsx`, 목업 번호 없음, D66-1, #291): 사진(A) · 폰 캘린더(D)에서 읽어 온 수업을 줄마다 고치고 빼고 → [수업 N개 저장]. 줄 편집 · 저장은 온보딩 시간표 단계와 같은 `TimetableStep` · `useTimetableStep`(줄마다 `estimateAppointment` → `createAppointment(…, '온보딩 시간표')`), 가져온 수업은 `lib/importHandoff`로 받음. 학교 위치를 한 번 정하면 좌표 없는 모든 줄에 적용(`CampusCard`). 길 입구는 `lib/flags` `TIMETABLE_PATHS`(photo · calendar 켬 — 온보딩 시간표 단계 · 학교 시간표(`app/timetable.tsx`) 입구, 끄면 입구 · 동의 항목 · 이 화면 진입이 함께 사라짐). 사진 읽기는 서버 함수 `timetable-extract`(Claude), 캘린더는 폰 안에서만(`expo-calendar`, 앞으로 2주 매주 반복 일정 후보)
- 감지 범위 고르기 (지도에서 위치 고르기 ③, 이슈 #31): 지도 고르기 시트에 `radius` 옵션을 주면 핀 둘레에 원이 그려지고 "감지 범위 작게 · 보통 · 크게" 3칸이 나옴 — 고른 값은 `onPick`의 `radiusM`(100~500m)으로 돌려주고 시트는 저장하지 않음. 저장 칸: **집 감지 범위 `profiles.home_radius_m`**(설정 "집 바꾸기"가 집 이름 · 좌표와 한 번에 `saveProfileFields`로 씀, 프리셋 100 · 200 · 300, 비었으면 200) · **자주 가는 곳 반경 `user_places.radius_m`**(`saveUserPlace({ …, radiusM })`, 프리셋 100 · 150 · 300, 같은 이름표로 덮으면 옛 값이 안 남음, 새로 추가하면 150에서 시작 · 바꾸기는 저장돼 있던 값에서 시작). 검색 결과를 누르면 직접 고르기 전까지 그 장소 분류의 기본 반경(`area.defaultRadiusFor`)에 가장 가까운 칸으로 맞춤(집은 안 맞춤). 목적지 반경 `appointments.dest_radius_m`은 새 일정 장소 줄(H05)이 `draft.destRadiusM`으로 보냄
- 권한 안내: 알림 · 정확한 알람 · 잠금화면 알람 화면 — 폰
- 설정 "출발 · 도착 자동 기록" 카드(`features/location/LocationAutoSection`, 안드로이드 + 실데이터에서만): 스위치 = 폰 저장 `location:v1:auto`(기본 켬) + 위치 권한 상태(`permissions.ts` `getLocationStatus`: 켜짐 · 위치 꺼짐 · 앱 사용 중에만 · 정확한 위치 꺼짐) — 폰, DB 없음. 앞 권한만 시스템 창으로 묻고 "항상 허용" · "정확한 위치"는 앱 설정 화면으로 안내(안드로이드 11+). 온보딩에서 못 켰다면 여기서(위치 허용하기 → 앞 권한 → 항상 허용 설정). 권한이 모자라도 스위치는 켜 둠 — 권한이 생기면 바로 등록. 끄면 등록한 지오펜스를 멈춤
- 온보딩은 `LOCATION_DISCLOSURE`를 보여 준 뒤 `requestLocationAccessFlow()`를 부름(L7 #277)
- 푸시 토큰: 로그인 직후 · 앱이 앞에 올 때(6시간 넘었으면) `usePushRegistration` → 안드로이드 채널 5개(`friend_v1` · `alarm_change_v1` · `request_v1` · `group_v1` · `missed_v1`)를 먼저 만든 뒤 `register_push_token(p_token, p_platform)` — RPC. 안드로이드만, 실패해도 던지지 않음. 같은 폰에서 계정이 바뀌면 마지막 로그인 계정이 토큰 주인
- `notify` 호출 모양: 요청에는 종류별 인자만(한 사람 = `targetUserId`, 그룹 = `groupId`) — 제목 · 본문 · data는 서버가 고정. 알람 바뀜(G04)은 `previousAt` · `newAt`(ISO)을 같이, 친구 요청 보냄(`REQUESTED`) → `FRIEND_REQUEST`, 수락 · 맞요청 자동 수락 → `FRIEND_ACCEPTED`, 그룹에 새로 들어옴(`JOINED`) → `GROUP_MEMBER_JOINED`. 본 동작이 끝난 뒤 기다리지 않고 부르며 실패해도 되돌리지 않음 (`features/social/real/push.ts`)
- 알림 누르기(`usePushLinks`, `features/push/link.ts`): `data.recipientUserId`가 지금 로그인한 계정일 때만 갈 곳(`/wake` · `/alarms` · `/friends`(그룹 탭) · `/group`(`groupId`가 있으면 그 그룹, `subjectUserId`도 있으면 그 사람의 기상 확인), 깨우기는 받는 사람의 기상 확인 `/wake`(H08), 공동 약속 변경은 `needsConfirm`이면 `/alarm/changed?id=`), 아니면 홈. 로그인 전에 누르면 로그인 뒤에 이어감. 앞에 떠 있을 때 받은 알림 중 내 알람 바뀜 · 공동 약속 바뀜 · 취소는 폰 알람을 서버와 맞춤(`syncNow`)
- 설정 '알람 점검' 첫 줄: 폰 알림 권한이 꺼져 있으면 '알림이 꺼져 있어요 [켜기]'(켜면 토큰 다시 등록), 아니면 '알림 설정 열기'

## Edge Function — 만들 것만

| 이름 | 하는 일 | 외부 | 화면 |
|---|---|---|---|
| `place-search` | 장소 검색 | 카카오 로컬 | H05 · 온보딩 |
| `place-reverse` | 지도 핀 좌표 → 주소 | 카카오 로컬 | 지도 핀 |
| `alarm-suggest` | 이동시간 · 기상 · 준비 · 출발 · 도착 시각 · 강도 계산 (저장 안 함) | 카카오 대중교통 | H05 · H03 · H01(아침 카드 다시 확인) |
| `alarm-commit` | 약속 · 참여 조건 · 알람을 한 번에 저장 | — | H05 · H03 · S01 |
| `notify` | 다른 사람 폰에 푸시. 보내기 전에 권한 확인: G03은 같은 그룹 + `wake_share_opt_in`(D19에서 확정), G04는 `can_edit_alarm`일 때만 | Expo Push | G03 · G04 · 미확인 알림 |
| `wake-check` | 5분마다 기상 미확인 알람을 MISSED로 기록하고 미확인 푸시(`notify`) — pg_cron 배치 | — | H08 · G03 |
| `alarm-roll` | 반복 약속 · 일정 없는 반복 알람의 다음 회차를 14일치 미리 만들고(`series_id` · `occurrence_on`), 루틴 알람 시각을 다음 발생으로 옮김 — pg_cron 5분마다(서비스 키) + 앱 맞추기 때 본인 몫(로그인 토큰) | 카카오 대중교통 | H01 · H02 · H03 · R02 |
| `suggestion-generate` | 매일 18:00 KST 제안 만들기 (배치 — 저녁 대화 전, 안건 D111 5번) | — | S01 |
| `voice-session` | 자기 전 대화 시작 · 이어 받기(텍스트). 첫 마디는 서버 템플릿(모델 호출 없음), 하루 5대화 상한. 응답 `{ session_id, resumed, rev, turn_seq, day, messages, cards, limits, prev_session_ids, uncommitted_session_ids }` (uncommitted = 어제 연 방 중 [완료] 없이 넘어와 정리가 안 된 것 — 앱이 정리 목록에 넣음) (L4 AI 묶음) | — | A02 |
| `voice-turn` | 자기 전 대화 한 턴: 말(`text`) · 앱 일 결과(`results`) · 카드 버튼(`card_action`). 서버는 카드 재료와 말만 주고 계산 · 저장은 앱이 함. 빠른 추출(T2F)과 대화 답(T1) 동시 호출 → 턴 처리 → 가드. 응답 `{ rev, turn_seq, next: USER \| APP_TASKS, reply, cards(전체), fixes, limits }`, 서버 마감 18초 (L4 AI 묶음) | Claude | A02 |
| `voice-commit` · `journal-*` | AI 대화 끝 정리(구조화 JSON `structured.v1` · 할 일 · 준비물 · 생활 기록 진술 칸) · 일기 | Gemini (T2.v3.3 · 일기 T5.v2는 voice-commit 안에서) | A02 · A03 (voice-commit 배포 전) |

나머지(목록 · 체크 · 권한 · 기록 화면)는 Edge 없이 DB · RPC로 함.

## 스키마에 더 필요한 것 (그 기능을 만들 때 마이그레이션)

| | 목업 | 지금 DB | 할 때 |
|---|---|---|---|
| 1 | S01 "다음 알람 10분 앞당김" | `alarm_suggestion_type`이 VOICE_TONE · SOUND · INTENSITY뿐 | #49에서 시각 조정 종류 추가 |
| 2 | H03 강도를 배경음 · 말소리 · 진동 따로 고름 | `intensity`(전체 세기) · `voice_tone`(말소리) · `sound_key`(배경음) · `vibration`(진동, `20261030200000_alarm_vibration.sql` — 직접 고른 값만, NULL = 강도를 따름) | D1 A로 정함 (이슈 #312) |
| 3 | G04 "변경 기록" | 저장 자리 없음 | 시트를 뺌 (친구 논리설계 10장 · D9 · D20) — 주인에게 푸시만, 보낸 쪽은 카드의 '제안함' · '반영됨' |
| 4 | — | 카카오 응답은 저장 · 재사용 불가인데 `est_travel_minutes` · `travel_source` CACHED가 있음 | #27에서 계산에 쓴 값만 남기는지 정함 |
| 5 | G02 · H01 그룹원 상태에 준비 시작 · 출발 · 도착까지 보임 | `get_group_wake_status`는 기상 상태(`wake_status`)와 시각 + 출발 · 도착 시각(`departed_at` · `arrived_at` · `trip_visible`)을 돌려줌, MISSED는 목업에 없음 | 11/19 D59를 도착까지로 바꿈 — 출발 · 도착 공유(`trip_share_opt_in`)를 켠 사람만 `departed_at` · `arrived_at` 시각이 내려옴. 준비 시작은 준비 알람 해제로 기록되어 `prepare_started_at`으로 같이 내려옴(11/19 추가). 화면은 앱 화면 PR에서 (목업 api는 글자 `WakeState`, 실데이터는 상태 값 + 시각) |
| 6 | 일정 없는 알람 (D46) · H03 직접 고름 (D42) · 고친 값 기록 (D42 · D43) · 울림 기록 중복 | `alarms_one_source`가 둘 다 NULL을 막음, `alarms.recurrence_rule` · `time_source` · `intensity_source` · `user_edit_logs` · `alarm_events.client_event_id` · `input_source` 없음 | PR #160에서 더함 (제약 풀기 · 칸 · 표 + RLS · `client_event_id` 유니크) |
