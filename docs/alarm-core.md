# 앱 ↔ 알람 코어

알람 예약 · 울림은 폰의 네이티브 모듈 `@capstone/alarm-core`(`mobile/modules/alarm-core`)가 맡음. 화면은 이 모듈의 JS 함수만 부르고, 서버는 알람을 울리지 않음.

```text
화면 → alarm-core(JS) → 울림 계획 계산(TS, plan.ts) → 네이티브(Kotlin)는 받은 계획대로만 실행
     → AlarmManager → 시각이 되면 BroadcastReceiver
        ├ WAKE            → 포그라운드 서비스 → 알람 볼륨 채널로 소리 + 잠금화면 위 알람 화면
        └ 그 밖(준비 · 출발 · 도착 · 루틴) → 소리 없는 알림 + 원탭 버튼
```

```text
mobile/modules/alarm-core/
  src/            공통(TS) — 타입 · 울림 계획 계산 · 평가 볼륨 보정 · 사용 구간 변환 · 웹 대체(메모리) · 네이티브 연결
  spec/cases.json 공통 테스트 케이스 — 같은 입력이면 같은 울림 계획 · 다시 울림 시각 (jest가 읽음)
  android/        Kotlin — 예약 · 재생 · 알림 · 기록 · 사용 정보 읽기 (판단 없이 계획대로)
```

## 함수 (#79)

전부 async. 화면은 어느 폰인지 모름.

| 함수 | 하는 일 |
|---|---|
| `schedule(pkg)` | 꾸러미 하나를 폰에 걸음. 같은 `alarmId`면 덮어씀. `'scheduled'` 또는 `'skipped_past'`(시각이 지남, 오류 아님)를 돌려줌. 꾸러미가 틀렸거나 정확한 알람 권한이 없으면 reject. 울리는 중이거나 같은 시각이 미룸 · 다시 울림 대기 중이면 건드리지 않고 `'scheduled'`(서버와 맞추려고 다시 넘겨도 미루기가 안 풀림) |
| `scheduleAll(pkgs)` | 여러 개를 차례로 `schedule`. 하나가 실패해도 계속하고 알람마다 `{ alarmId, status, error? }`를 돌려줌 (`status`는 `'scheduled'` · `'skipped_past'` · `'failed'`) |
| `cancel(alarmId)` · `cancelAll()` | 예약 지우기 (미루기 · 다시 울림 대기 포함). 울리는 중이면 멈춤. 해제 기록은 안 남음 |
| `list()` | 폰에 걸린 예약. `{ id, type, intensity, title, atMillis, snoozeCount, nextRingAt }` — 서버 `alarms`와 `alarm_id` + `scheduled_at`(=`atMillis`) + `intensity`로 맞춤 |
| `stop()` | 지금 울리는 알람을 해제 처리 (해제 기록이 남고, 앱이 이미 열려 있으니 앱은 안 엶) |
| `ringNow(pkg)` | 예약 없이 바로 울림 (시험용). 같은 id가 있으면 덮어씀 |
| `canScheduleExactAlarms()` · `canUseFullScreenIntent()` | 정확한 알람 · 잠금화면 알람 화면 권한 |
| `hasUsageAccess()` · `openUsageAccessSettings()` · `getUsageSpans(from, to)` | 사용 정보 접근 권한 확인 · 설정 열기 · 화면 사용 구간 읽기 (아래 기상 확인) |
| `getPendingEvents()` · `markEventsUploaded(ids)` · `addAlarmEventListener(fn)` | 폰에 쌓인 울림 기록 읽기 · 올린 것 지우기 · 앱이 켜져 있을 때 새 기록 받기 (아래 울림 기록) |
| `isAvailable` | Android + 모듈이 든 APK인지. 웹이면 false |

순수 함수(네이티브 없이 씀): `buildRingPlan` · `volumePercentFor` · `ringStartTimes` · `snoozeRingAt` · `unansweredSpanMillis` · `isPastRing` · `volumeAdjustFromRatings` · `toUseSpans` · `makeUuid`.

## 예약 꾸러미

서버 `alarm-commit`이 돌려주는 값을 그대로 폰에 넘기는 모양. 예약 함수는 이 모양 하나로 합침(#29 · #33 · #79).

```ts
type RingPackage = {
  alarmId: string;        // alarms.alarm_id (UUID). 종류는 id가 아니라 type으로 정함
  type: 'WAKE' | 'PREPARE' | 'DEPARTURE' | 'ARRIVE' | 'ROUTINE';
  atMillis: number;       // alarms.scheduled_at
  title: string;          // 약속 제목
  subtitle?: string;      // "오전 10:00 · 세종대학교"
  intensity: 'SOFT' | 'NORMAL' | 'STRONG';
  snoozeLimit: number;    // 기본 3 — 저장만 함, 아직 안 셈 (D3)
  voiceText?: string;     // 음성 안내 문장 — 저장만 함 (D8, 나중)
  soundKey?: string;      // 소리 고르기. 폰에 든 소리가 하나뿐이라 지금은 어떤 값이든 기본 소리
  volumeAdjust?: number;  // 평가 보정 비율, -0.1 = 볼륨 10% 줄임 (#81)
  departAt?: number;      // 출발 시각 (단축 준비 안내용) — 저장만 함
  vibration?: 'NONE' | 'SHORT_REPEAT' | 'STRONG_CONTINUOUS'; // 자리만, 안 읽음 (D1)
  snoozeMinutesOptions?: readonly number[];                  // 자리만, 안 읽음 (D3)
};
```

반복은 폰이 하지 않음. 루틴(`routines.repeat_days`)과 반복 약속(`recurrence_rule`)은 서버가 **다음 회차 하나만** `alarms` 행으로 만들고(`scheduled_at`은 시각 하나), 울린 뒤 해제 · MISSED 기록이 들어오면 다음 회차를 다시 만듦(기록이 안 들어오면 매일 03:00 배치가 메움). 그래서 꾸러미에는 `atMillis` 하나면 됨 (회차 수는 D4가 정함, 폰 쪽에 가정하지 않음). 예전 `scheduleDailyAlarm`(매일 반복)은 없앰.

## 울림 계획 (#29)

`plan.ts`가 꾸러미 한 개에서 계산해 네이티브에 같이 넘김. 네이티브는 계산하지 않고 받은 값대로 실행. 같은 입력이 같은 계획이 되는지는 `spec/cases.json`을 jest가 확인.

| 항목 | 규칙 |
|---|---|
| 볼륨 | 알람 볼륨 스트림 최대치 × 강도별 60 · 80 · 100%(SOFT · NORMAL · STRONG) × (1 + `volumeAdjust`). 정수 %로 반올림하고 10~100% 안으로 (보정이 커도 소리가 사라지지 않게). 끄면 원래 볼륨으로 되돌림 |
| 한 번 울림 | 최대 3분 (백그라운드 재생 제한, 7장 7.4.2 · T-6에서 실기기로 확정) |
| 안 끄면 다시 울림 | 약 5분 뒤 1번 · 보통 5분 간격 2번 · 강 3분 간격 3번. **미루기 횟수에 안 셈**. 미루고 난 뒤 울림도 같은 묶음으로 다시 셈 |
| 미루기 | 10분 고정. 5 · 10 · 15분 고르기와 한도(`snoozeLimit`)는 D3이 정해질 때까지 안 읽음 (횟수 제한 없음) |
| 소리 | 폰에 든 파일 하나(`alarm_siren.wav`). `soundKey`는 칸만 있고 모르는 값은 기본 소리 (소리 3종은 별도 계획, Q7) |
| 진동 | 알림 채널의 진동 하나 (강도와 상관없음). 강도 · 축별 진동은 D1 뒤 |

**"간격"의 읽기 (작성자 판단 — 되돌리기 쉬움)**: 한 울림이 시작된 때부터 다음 울림이 시작될 때까지(시작-시작)로 읽음. 보통은 0 → 5 → 10분에 울림 시작(울림은 최대 3분이라 사이에 2분 쉼), 강은 0 → 3 → 6 → 9분(3분 울림이 쉬는 틈 없이 이어짐), 약은 0 → 5분. "울림이 끝난 뒤 쉬는 시간"으로 읽으면 보통 8 · 16분, 강 6 · 12 · 18분이 됨. `plan.ts`의 표(`RE_RING_START_MINUTES`) 한 곳만 바꾸면 되고 네이티브는 그대로 (첫 울림 시작으로부터의 거리를 그대로 AlarmManager에 걸기 때문).

다시 울림은 첫 울림이 시작될 때 다음 것을 **미리 AlarmManager에 걸어 둠** — 서비스가 죽어도 이어지고, 끄면(해제) 걸어 둔 것을 지우고, 미루면 그 자리를 미루기 시각으로 바꿈. 끝까지 안 끄면 놓침 판정과 `MISSED` 기록은 서버가 함(7장 7.9.2, 폰은 기록을 안 남김).

## 종류별 갈래 (#33)

| 종류 | 울림 | 원탭 버튼 → 남는 기록 |
|---|---|---|
| WAKE | 소리 + 잠금화면 위 알람 화면 + 알림(해제 · 미루기). `setAlarmClock` | — (해제 · 미루기가 기록) |
| PREPARE | 소리 없는 알림. `setExactAndAllowWhileIdle` | "준비 시작" → `ACKNOWLEDGED` |
| DEPARTURE | 〃 | "출발했어요" → `ACKNOWLEDGED` |
| ARRIVE | 〃 | "도착했어요" → `ARRIVAL_CONFIRMED` |
| ROUTINE | 〃 | "했어요" → `ACKNOWLEDGED` |

소리는 WAKE만 (7장 7.4.1은 루틴도 소리 나는 알람으로 적었지만 이 문서가 기준 — 문서 보완 목록). 무음 알림은 한 번 알리면 끝이고 미루기 · 다시 울림이 없음. 원탭은 앱을 열지 않고 기록만 남김. 원탭 결과를 `appointment_participants`의 출발 · 도착 시각으로 옮기는 것은 앱(screen-data-map의 H07 · H08 참고).

`setExactAndAllowWhileIdle`은 절전(Doze) 중 앱당 약 9분에 한 번으로 제한될 수 있음 — 무음 알림끼리 9분 안에 붙으면 늦을 수 있음 (실기기 확인 6개와 함께 봄).

## 미루기 = 같은 알람의 상태

새 알람을 만들지 않고 같은 알람의 상태를 바꿈: `snoozeCount`(미루기만 셈) · `nextRingAt`(다음 울림). 그래서 `list()`는 알람당 한 줄이고, 서버와 맞출 때 미룬 알람이 지워지지 않음. 예전 `<id>__snooze` 항목은 없앰.

## 울림 기록 (#33 · #79)

폰이 앱이 꺼져 있어도 · 재부팅해도 남도록 쌓음 (SharedPreferences, 최대 1000줄). 앱이 켜지면 읽어서 `alarm_events`로 올리고 지움.

| 기록 | 언제 | 칸 |
|---|---|---|
| `TRIGGERED` | 울릴 때마다 (처음 · 미루고 난 뒤 · 다시 울림) | `sequenceNo`(울림 회차, 1부터) |
| `SNOOZED` | 미룰 때 | `snoozeMinutes`(지금 10) |
| `DISMISSED` | 해제 | — |
| `ACKNOWLEDGED` / `ARRIVAL_CONFIRMED` | 무음 알림의 원탭 | — |

모든 줄에 `clientEventId`(폰이 만든 UUID — DB의 중복 방지 칸에 그대로 들어감, Q11) · `alarmId` · `alarmType` · `eventType` · `at`(epoch ms) · `inputSource`(폰 안 버튼은 늘 `'BUTTON'`). 위치 · 사용 정보로 자동 남기는 기록은 앱이 따로 만듦. `WAKE_CONFIRMED` · `FEEDBACK` · `MISSED`는 폰이 남기지 않음.

- 앱이 켜져 있으면 `addAlarmEventListener`로 새 기록을 바로 받음. 꺼져 있을 때 쌓인 것은 `getPendingEvents()`로 읽음 (오래된 순)
- 올리기에 성공한 것만 `markEventsUploaded(clientEventIds)`로 지움
- **폰이 스스로 올리는 길(WorkManager + 네트워크 조건)은 아직 없음**: 로그인 토큰이 네이티브에 있어야 하는데 지금은 JS(Supabase 세션)에만 있음. 앱 연결 PR에서 방법을 정함 (아래 "앞으로 더할 것")

## 해제 뒤 앱 열기 (#79)

WAKE를 해제하면(알람 화면 · 알림 버튼 모두) 앱을 `respecalarm://wake?alarmId=<alarmId>`로 엶 → 기상 확인(H08) · 아침 루틴 · 평가가 받음. 잠겨 있으면 잠금을 푼 뒤 열림. 알림의 "해제"는 안드로이드 12부터 알림 버튼이 리시버를 거쳐 화면을 열 수 없어 화면 없는 중계 화면(`AlarmActionActivity`)이 맡음. 앱의 `/wake` 화면이 `alarmId` 파라미터를 받는 것은 앱 연결 PR에서.

## 기상 확인 — 사용 정보 읽기 (#35 · D14)

해제 뒤 폰을 썼는지를 읽어 H08 판정에 넣음. 설정 → 사용 정보 접근에서 사용자가 켜야 하고(`PACKAGE_USAGE_STATS`는 선언만 해 둠, 첫 빌드 Q12), 거부하면 "일어났어요" 버튼만.

- `getUsageSpans(from, to)` → `{ startMillis, endMillis }[]` (시각순). "사용 중" = 화면이 켜져 있고(`SCREEN_INTERACTIVE`) 잠금이 풀려 있는(`KEYGUARD_HIDDEN`) 동안. 앱 전환(ACTIVITY_RESUMED · PAUSED) 대신 이 이벤트를 쓴 이유: 알람을 끈 직후는 알람 화면 때문에 화면은 켜져 있어도 잠금이 안 풀린 상태라 "폰을 썼다"가 아니고, 잠금이 풀린 시각이 7장 7.13.8의 "해제 후 첫 잠금 해제"와 맞음. 어떤 앱을 쓰는지는 읽지 않음. 잠금 화면이 없는 폰은 화면 켜짐만으로 봄
- 이벤트는 안드로이드 9(API 28) 이상에만 있어서 그보다 낮으면 reject → 앱은 버튼으로
- `toUseSpans(spans, 해제 시각)` → `[해제 뒤 시작 분, 끝 분][]` — `features/alarm/wake.ts`의 `UseSpan`과 같은 모양이라 그대로 `usageSummary` · `thetaReachedAt`에 들어감
- **구간 보관 · 기록 시각 = θ 도달 시각 (D14)**: 사용을 분 합계가 아니라 구간(시작 · 끝)으로 읽어 두기 때문에, 누적 사용이 θ를 넘은 시각을 거꾸로 구해 `WAKE_CONFIRMED`의 `alarm_events.event_at`으로 남길 수 있음 (해제 시각이 아님). 구간 자체는 OS가 보관하는 이벤트에서 그때그때 읽고 모듈이 따로 저장하지 않음. 누적 · 최근 사용 분 값은 DB에 안 남음
- 알람을 끈 직후 앱이 H08로 열리면 그 화면을 보는 시간도 "사용"으로 셈 (화면 켜짐 + 잠금 해제라서). 이를 빼야 하는지는 앱 연결 때 확인

## 평가로 볼륨 보정 (#81)

`volumeAdjustFromRatings(ratings)` — 최근 평가 5번(오래된 것 → 최근 순) 중 "너무 시끄러워요"(`TOO_LOUD`)가 2번 이상이면 `-0.1`, 아니면 `0`. 결과를 꾸러미의 `volumeAdjust`에 넣으면 같은 강도 그대로 볼륨만 10% 줄어듦. 누적되지 않음(그때그때 최근 5번만 셈), 강도별로 나눌지는 넘기는 쪽이 목록을 걸러서 정함. 평가 칩 화면은 새 UI라 나중.

## 웹 · 지원 안 하는 곳 (#98)

웹 · iOS는 메모리 대체: 예약 목록과 `ringNow` 기록만 메모리에 들고 울리지는 않음 (새로고침하면 사라짐). 그래서 웹 미리보기에서 "약속 만들기 → 알람 예약 → 목록"이 폰 없이 끝까지 보임. `isAvailable`은 false 그대로라 화면은 "실제로 울리지 않음"을 알 수 있음. Android인데 모듈이 없는 옛 APK는 예약 · 울리기를 거절하고 조회는 빈 값 ("예약된 줄 알았는데 안 울림" 방지).

## 앞으로 더할 것

| 언제 | 무엇 | 바뀌는 점 |
|---|---|---|
| 앱 연결 (P6) | 서버 알람과 폰 예약을 대조 | 앱을 켤 때 `alarms`(켜짐 · 앞으로)와 `list()`를 `alarm_id` + `scheduled_at` + `intensity`로 비교. 빠진 건 `schedule`, 없는 건 `cancel`, 시각 · 강도가 다르면 다시 `schedule`(친구의 ±5분 · 제안 적용 · 설정 수정 뒤 푸시를 못 받았을 때 대비). 지난 시각은 `skipped_past`로 건너뜀 |
| 앱 연결 (P6) | 울림 기록 올리기 | 앱이 켜지면 `getPendingEvents()` → `alarm_events`(`clientEventId`로 중복 방지) → `markEventsUploaded`. 끄거나 재부팅한 동안의 기록도 이 길로 감. 해제 · 놓침을 바로 올리는 폰 스스로의 길(WorkManager)은 토큰 문제로 따로 정함 |
| 로그아웃 | 정리 | `cancelAll()` + 폰에 쌓인 기록 지우기 (Q6) |
| D1 | 배경음 · 말소리 · 진동 축별 고르기 | `vibration` 칸을 읽고 진동을 서비스에서 직접 (지금은 알림 채널 진동 하나) |
| D3 | 미루기 5 · 10 · 15분 고르기 · 횟수 한도 | `snoozeMinutesOptions` · `snoozeLimit`을 읽고 한도면 단축 준비 안내(`departAt`) |
| D2 | 기상 확인 무응답 시 다시 울림 | 지금은 안 만듦 |
| Q7 | 소리 3종 | `soundKey`로 폰에 든 파일을 고름 |
| D8 | 음성 안내 | 알람 소리 채널로 폰 TTS가 `voiceText`를 읽음 (실패해도 사이렌은 울림) |
| 나중 | iOS | AlarmKit 구현은 안드로이드 뒤 (Q9) |

## 지킬 것

- 알람은 서버 · 인터넷 없이도 울려야 함. 계산 · 저장은 서버, 울리는 건 폰
- 네이티브 코드가 바뀌면 모두 개발용 APK를 다시 받음 (PR에 적기)
- 실기기 확인 6개(잠금화면 · 볼륨 0 · 최근 앱에서 닫기 · 재부팅 · 방해 금지 · 미루기)는 알람 코어를 바꿀 때마다 다시 봄 — `respecalarm://dev/alarm-test`. 이번에 더해 볼 것: 강도 3단계 볼륨 · 3분 뒤 멈춤과 다시 울림 · 무음 알림 원탭 · 해제 뒤 앱이 `wake?alarmId=`로 열림 · 사용 구간 읽기
