# 앱 ↔ 알람 코어

알람 예약 · 울림은 폰의 네이티브 모듈 `@capstone/alarm-core`(`mobile/modules/alarm-core`)가 맡음. 화면은 이 모듈의 JS 함수만 부르고, 서버는 알람을 울리지 않음.

```text
화면 → alarm-core(JS) → 울림 계획 계산(TS, plan.ts) → 네이티브(Kotlin)는 받은 계획대로만 실행
     → AlarmManager → 시각이 되면 BroadcastReceiver
        ├ WAKE            → 포그라운드 서비스 → 알람 볼륨 채널로 배경음(soundKey) + 진동(vibration 3종) + 풀스크린 인텐트(→ 앱 H07 /ring, 아래 "울림 화면")
        └ 그 밖(준비 · 출발 · 도착 · 루틴) → 보통 알림(알림음 · 진동 한 번) + 원탭 버튼
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
| `schedule(pkg)` | 꾸러미 하나를 폰에 걸음. 같은 `alarmId`면 덮어씀. `'scheduled'` · `'skipped_past'`(시각이 지남, 오류 아님) · `'deferred'`를 돌려줌. 꾸러미가 틀렸거나 정확한 알람 권한이 없으면 reject. 울리는 중이거나 같은 시각이 미룸 · 다시 울림 대기 중이면 건드리지 않음(서버와 맞추려고 다시 넘겨도 미루기가 안 풀림): 시각 · 강도 · `soundKey` · `vibration`이 이미 같으면 `'scheduled'`(이때 `voiceTone`만 다르면 미루기 상태는 두고 말소리 칸만 고침), 다르면 새 꾸러미를 받지 않았다는 `'deferred'`. **울리거나 미룬 중엔 새 꾸러미를 미루고, 해제 뒤 앱 맞추기(다음 앱 열림)에서 다시 넣음** |
| `scheduleAll(pkgs)` | 여러 개를 차례로 `schedule`. 하나가 실패해도 계속하고 알람마다 `{ alarmId, status, error? }`를 돌려줌 (`status`는 `'scheduled'` · `'skipped_past'` · `'deferred'` · `'failed'`) |
| `cancel(alarmId)` · `cancelAll()` | 예약 지우기 (미루기 · 다시 울림 대기 포함). 울리는 중이면 멈춤. 해제 기록은 안 남음. `cancelAll()`은 이미 떠 있는 일정 알림(준비 · 출발 · 도착 · 루틴)도 지워서 로그아웃 뒤 남은 알림의 원탭이 기록을 쌓지 않음 |
| `list()` | 폰에 걸린 예약. `{ id, type, intensity, soundKey, vibration, voiceTone, title, atMillis, snoozeCount, nextRingAt }` — 서버 `alarms`와 `alarm_id` + `scheduled_at`(=`atMillis`) + `intensity` + `soundKey` + `vibration` + `voiceTone`으로 맞춤 (`voiceTone`은 칸이 없던 예약이면 `null`, 예전 APK는 칸 없음 → 비교 안 함) (`soundKey` · `vibration`은 칸이 없는 예전 저장 알람이면 아래 기본값) |
| `stop()` | 지금 울리는 알람을 해제 처리 (해제 기록이 남고, 앱이 이미 열려 있으니 앱은 안 엶) |
| `getRinging()` | 지금 울리는 알람 `{ id, type, title, subtitle, atMillis, nextRingAt, snoozeCount, snoozeLimit, snoozeMinutesOptions, departAtMillis, heading, soundKey, vibration, intensity }` 또는 `null`. 앱 H07이 그림. 해제하면 알람이 지워져 다시 읽으면 `null` |
| `snooze(minutes)` | 지금 울리는 알람을 `minutes`분 미룸 (SNOOZED 기록). 한도(3번) · 허용 분(5 · 10 · 15)은 코어가 검사해 `false`를 줄 수 있음 (이미 멈춤 포함) |
| `ackRingScreen()` | (동기) 앱이 H07을 띄웠다고 네이티브 길잡이 화면에 알림 → 길잡이 화면이 닫힘 |
| `releaseRingOverLock(dismissKeyguard)` | 알람이 끝나 H07의 잠금화면 위 설정을 되돌림. `true`(해제)면 잠금 해제도 요청해 기상 확인(H08)이 이어서 보이게 하고, `false`(미루기)면 앱을 뒤로 보냄 |
| `ringNow(pkg)` | 예약 없이 바로 울림 (시험용). 같은 id가 있으면 덮어씀 |
| `canScheduleExactAlarms()` · `canUseFullScreenIntent()` | 정확한 알람 · 잠금화면 알람 화면 권한 |
| `hasUsageAccess()` · `openUsageAccessSettings()` · `getUsageSpans(from, to)` | 사용 정보 접근 권한 확인 · 설정 열기 · 화면 사용 구간 읽기 (아래 기상 확인) |
| `getPendingEvents()` · `markEventsUploaded(ids)` · `addAlarmEventListener(fn)` | 폰에 쌓인 울림 기록 읽기 · 올린 것 지우기 · 앱이 켜져 있을 때 새 기록 받기 (아래 울림 기록) |
| `isAvailable` | Android + 모듈이 든 APK인지. 웹이면 false |

순수 함수(네이티브 없이 씀): `buildRingPlan` · `volumePercentFor` · `ringStartTimes` · `snoozeRingAt` · `canSnooze` · `isSnoozeLate` · `snoozeCountLabel` · `snoozeLimitNotice` · `unansweredSpanMillis` · `isPastRing` · `volumeAdjustFromRatings` · `toUseSpans` · `makeUuid`.

## 울림 화면 (#332)

WAKE가 울리면 소리 · 진동 · 다시 울림은 네이티브 서비스(`AlarmPlaybackService`)가 맡고, 화면은 앱의 H07(`/ring`)이 잠금화면 위에 뜸.

```text
풀스크린 인텐트 · 알림 본문 → AlarmRingingActivity(길잡이, 단색 #141414)
   → respecalarm://ring?alarm=<알람 id> 로 앱(MainActivity)을 엶 → 앱 /ring이 getRinging()으로 그림
   → 앱이 ackRingScreen() → 길잡이 화면 닫힘
   → 해제: stop() + releaseRingOverLock(true) → /wake   미루기: snooze(분) + releaseRingOverLock(false)
앱이 RING_APP_TIMEOUT_MS(6초) 안에 ack를 안 하면 → 길잡이 화면이 네이티브 컨트롤(대체 화면: 5 · 10 · 15분 미루기 · 해제)을 그림
```

- **잠금화면 위 규칙**: 앱 manifest에 `showWhenLocked`를 박지 않음 (잠긴 채 다른 알림을 눌러도 앱이 잠금 위에 뜨는 보안 후퇴). `respecalarm://ring` 인텐트로 열렸을 때만 `AlarmCorePackage`의 ReactActivityLifecycleListener가 `setShowWhenLocked` · `setTurnScreenOn` · `KEEP_SCREEN_ON`을 켬(`RingOverLock`). `releaseRingOverLock`이 되돌리고, 사용자가 홈으로 나가거나(`onUserLeaveHint`) 서비스가 멈춘 지 8초가 지나도 남아 있으면 스스로 거둠.
- 길잡이 화면은 앱과 다른 작업(task)에 둠(`taskAffinity=""`) — 앱이 앞에 와도 길잡이가 사라지지 않아, 앱이 못 뜰 때 대체 화면을 그릴 수 있음.
- 앱 라우팅: `/ring`은 로그인 · 온보딩 · 프로필 읽기를 기다리지 않고 열림 (`app/_layout.tsx`). 해제 · 미루기는 코어 호출뿐.
- 코어는 약속 정보(장소 · 음성 문장)를 안 가져서 실데이터 H07은 제목 · 시각 · 미루기 칸만 그림.

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
  snoozeLimit: number;    // 미루기 한도, 기본 3 — 울림 계획(plan.snoozeLimit)에 실려 네이티브가 셈 (D3 기본안 A)
  voiceText?: string;     // 음성 안내 문장 — 저장만 함 (D8, 나중). 서버가 약속의 기상 알람에 채움
  notice?: string;        // 알림 한 줄 — 있으면 울림 계획의 heading이 이 글자. 서버가 약속의 준비 · 출발 알림에 채움
  soundKey?: string;      // 배경음 고르기: 'theme_calm' · 'theme_default' · 'theme_urgent'(앱에 든 파일). 약(`theme_calm`) · 강(`theme_urgent`)만 앱 파일을 먼저 틀고, 보통(`theme_default`) · 없거나 모르는 키는 폰 기본 알람음이 먼저 (D1 A, 10/30 지형님)
  volumeAdjust?: number;  // 평가 보정 비율, -0.1 = 볼륨 10% 줄임 (#81)
  departAt?: number;      // 출발 시각 — 미루기 한도 안내 · "이만큼 미루면 늦어요" 판단에 씀 (D3 기본안 A)
  vibration?: 'NONE' | 'SHORT_REPEAT' | 'STRONG_CONTINUOUS'; // 진동 패턴 3개 (D1 A). 칸이 없으면 강도에서: SOFT → NONE · NORMAL → SHORT_REPEAT · STRONG → STRONG_CONTINUOUS
  voiceTone?: 'CALM' | 'NEUTRAL' | 'DIRECT'; // 말소리 = AI 음성 시작 단계 약 1 · 중 2 · 강 3 (서버 alarms.voice_tone, 늘 채움). 없으면 저장된 브리핑의 시작 단계, 그것도 없으면 1
  snoozeMinutesOptions?: readonly number[];                  // 자리만, 안 읽음 — 미루기 시간은 5 · 10 · 15분 고정(D3 기본안 A)이라 plan이 정함
};
```

앱은 `soundKey` · `vibration`을 알람마다 항상 넣어 보냄(`toNativePayload`). 네이티브는 칸이 없는 예전 저장 알람(예전 APK가 저장) 때문에 기본값을 둠: `vibration`은 `intensity`에서(위), `soundKey`는 꾸러미 칸 → 계획(`plan.soundKey`) 칸 → `intensity`(SOFT → `theme_calm` · NORMAL → `theme_default` · STRONG → `theme_urgent`) 순. 모르는 `vibration` 값도 `intensity`에서 정함. 계획의 `soundKey`는 꾸러미의 것과 같은 값으로 맞춰 저장함 (`StoredAlarm.fromJson`).

### 알림 문구 (`notice` · `voiceText`)

약속 알람만 서버가 문구를 채움. 새 알림을 늘리지 않고 기존 준비 · 출발 알림 문구에 출발 안내를 합침 (D65 기본안). 일정 없는 알람 · 루틴 · 도착은 문구 없이 `HEADING` 그대로.

| 종류 | 알림에 보이는 줄 (`plan.heading`) | `voiceText` (저장만, 읽어 주기는 D8) |
|---|---|---|
| PREPARE | `notice`: `오전 8:40 출발까지 30분` (출발 알람 시각 − 준비 알람 시각, 60분 이상이면 `1시간 10분`) | — |
| DEPARTURE | `notice`: `지금 나가면 오전 9:50 도착 · 여유 10분` (도착 = 출발 알람 시각 + 이동분, 여유 = 약속 − 도착. 0이면 `여유 없음`, 늦으면 `10분 늦어요`) | — |
| WAKE | 그대로 `일어날 시간이에요` | `좋은 아침이에요. 오늘 첫 일정은 오전 10시 전공 수업이에요. 오전 9시에 나가면 돼요.` (출발 알람이 없으면 마지막 문장 없음) |

- 글자는 서버 `_shared/ring-package.ts`가 만들고 앱 `lib/alarmSync/reconcile.ts`(`buildServerPackages`)가 **같은 함수**로 만듦 — 서버 `alarm-commit`이 돌려준 꾸러미와 앱이 서버 행으로 다시 만든 꾸러미가 같은 글자. 도착 · 여유 계산은 `_shared/calc/depart.ts`(7장 7.5.2)
- 나르는 길: `notice`가 있으면 `buildRingPlan`이 그 글자를 `plan.heading`에 넣음. 네이티브는 `notice` 칸을 몰라도 되고 `plan.heading`만 저장해(`StoredAlarm`에 `plan`이 통째로 들어감) 알림 본문 `heading · subtitle`에 씀(`AlarmNotifications.showNotice`). 재부팅 뒤 다시 걸기(`AlarmBootReceiver` → `restoreAll`)도 저장된 값을 그대로 다시 걸어서 글자가 유지됨 → **Kotlin 변경 없음, APK 다시 받을 필요 없음**
- 글자는 저장(`alarm-commit`)할 때 정해지고, 앱 맞추기(`planReconcile`)는 시각 · 강도만 비교함(폰 `list()`는 글자를 안 돌려줘서 글자로는 못 비교). 그런데 준비 알림 글자와 기상 `voiceText`는 **같은 약속의 출발 알람 시각 · 켜짐**에서 나오므로, 출발 알람이 바뀌면 그 약속의 준비 · 기상을 시각 · 강도가 같아도 같이 다시 걸어 새 글자로 덮음:
  - 출발 알람이 새로 걸리거나 시각이 바뀌어 `schedule`에 들어갈 때 → 폰에 이미 있는 같은 약속의 켜진 준비 · 기상 꾸러미도 `schedule`에 넣음 (이미 지난 것은 제외). 강도만 바뀐 출발은 글자가 같아 해당 없음
  - 출발 알람이 폰에서 지워질 때(서버에서 꺼졌거나 지워짐 → `cancel`) → 같은 약속의 준비 · 기상을 다시 걸어 출발 줄이 빠진 글자(`준비할 시간이에요`)로 돌아감. 폰은 지울 알람의 약속을 몰라서 `reconcile`이 그때만 `alarms`에서 `participant_id`를 한 번 읽어 `planReconcile`에 넘김(`departureGroups`). 알람 일부만 맞추는 `reconcile({ alarmIds })`도 출발 알람이 들어 있으면 같은 약속의 준비 · 기상 id를 대상에 더함(`expandWithTextSiblings`)
  - 같은 약속을 묶는 키는 `buildServerPackages`가 이미 쓰는 그룹 키(`participant_id`)를 앱 쪽 꾸러미 타입 `ServerPackage.groupKey`에만 실음. `planReconcile`이 `schedule`에 담을 때 떼어 내고 `toNativePayload`도 정해진 칸만 담아서 **네이티브로는 안 감** (시험으로 확인)
  - 아무것도 안 바뀌면 다시 걸지 않음. 서버 목록이 상한(500)에서 잘렸을 때는 "서버에 없음"을 못 믿어 출발 알람이 지워지는 쪽은 건너뜀
- 이동 시간이 비어 있으면 출발 문구가 빠지고, 시각 서식이 실패하면 문구만 빠지고 알람은 그대로 걸림 (빠진 문구는 `console.warn`으로 알람 종류 · id · 오류만 한 줄 남김). `notice`가 글자가 아니면 `buildRingPlan`이 무시하고 기본 줄을 씀. 기상 문장의 `이에요/예요`는 제목 끝이 숫자면 읽는 소리(`영어 1이에요` · `캡스톤 2예요`), 닫는 괄호면 괄호 앞 글자(`자료구조(월)`은 `예요`)로 고름
- 남는 한계: 제목 · 부제만 바뀐 경우(시각 · 강도 그대로)는 여전히 폰에 옛 글자가 남음 — 원래 있던 문제이고 약속을 다시 저장하면 새로 걸림
- 남는 한계: 알림이 한 줄이라 문구가 길면 잘릴 수 있음 — `AlarmNotifications.kt`에 `BigTextStyle`이 없음. 다음 네이티브 PR에서 함

반복은 폰이 하지 않음. 반복 약속(`recurrence_rule`)과 일정 없는 반복 알람은 서버가 **앞으로 14일치 회차를 회차마다 한 줄씩 미리 만들고**(약속 · 참여 조건 · 알람이 새 행, `series_id` · `occurrence_on`으로 묶음 · 날짜 구분, `alarm-roll`이 5분마다 보충), 지난 회차 행은 기록으로 그대로 남김. 폰은 앱이 열릴 때(`syncNow`: 기록 올리기 → `alarm-roll` 부르기 → reconcile) 그 행들을 reconcile로 읽어 14일 안 알람을 걸음. `alarm-roll` 호출은 10분에 한 번, 8초 안에 안 끝나면 기다리지 않고 실패는 삼킴(반복 일정을 방금 저장했으면 제한 없이 그 묶음을 먼저 넘김). reconcile은 출발 기록(`departed_at`)이 있는 약속의 준비 · 출발 알람, 도착 기록(`arrived_at`)이 있는 약속의 준비 · 출발 · 도착 목표 알람을 서버 행에서 빼므로 이미 폰에 걸린 것은 "서버에 없음"으로 지워짐(기상은 그대로). 맞춘 뒤에는 `onAlarmsSynced` 훅(`source` · `whole` · `summary` · `upcoming` · `nowMs`)이 불림 — 기다리지 않고, 던져도 맞추기는 성공. 루틴(`routines.repeat_days`)은 회차 행을 따로 만들지 않고 같은 알람 행의 시각만 다음 발생으로 옮김. 그래서 꾸러미에는 `atMillis` 하나면 됨 (회차 수는 폰 쪽에 가정하지 않음). 예전 `scheduleDailyAlarm`(매일 반복)은 없앰. 서버 함수 `alarm-roll`(3a-2)과 앱 맞추기(3b)가 머지되고 `alarm-roll`이 배포된 뒤부터 동작 — 그 전에는 DB 칸(`supabase/README.md` "반복 다음 회차")만 있고 첫 회차만 만들어짐.

## 울림 계획 (#29)

`plan.ts`가 꾸러미 한 개에서 계산해 네이티브에 같이 넘김. 네이티브는 계산하지 않고 받은 값대로 실행. 같은 입력이 같은 계획이 되는지는 `spec/cases.json`을 jest가 확인.

| 항목 | 규칙 |
|---|---|
| 볼륨 | 소리·진동 축과 별개로 **전체 세기(`intensity`)**가 정함: 알람 볼륨 스트림 최대치 × 강도별 60 · 80 · 100%(SOFT · NORMAL · STRONG) × (1 + `volumeAdjust`). 정수 %로 반올림하고 10~100% 안으로 (보정이 커도 소리가 사라지지 않게). 끄면 원래 볼륨으로 되돌림 |
| 한 번 울림 | 최대 3분 (백그라운드 재생 제한, 7장 7.4.2 · T-6에서 실기기로 확정) |
| 안 끄면 다시 울림 | 울림이 끝난 뒤 쉬었다가 다시: 약 5분 쉬고 1번 · 보통 5분씩 쉬고 2번 · 강 3분씩 쉬고 3번 (**쉬는 시간 읽기는 해석** — 아래). **미루기 횟수에 안 셈**. 미루기 뒤에는 다시 울림 묶음을 처음부터 (서버 미확인 판정도 같은 기준, #160) |
| 미루기 | **5 · 10 · 15분 중 고르기, 알람 한 개당 최대 3번** (D3 기본안 A). 울림 화면에 시간 3개(기본 선택 5분) + "미루기 N/3회"(N = 이미 미룬 횟수). **한도에 닿으면**(`snoozeCount >= snoozeLimit`) 시간 · 미루기 버튼을 끄고 "지금 바로 준비 · {출발 시각} 출발"(`departAt`이 없으면 "지금 바로 준비"). **다시 울릴 시각(지금 + 고른 분)이 출발 시각(`departAt`)을 넘으면 "늦어요"를 눈에 띄게 보이되 막지는 않음** — 늦는 칩은 경고색 + 칩 안 "늦어요", 고른 칩이 늦으면 미루기 버튼 바로 위 굵은 경고 한 줄 "15분 미루면 9:00 출발보다 5분 늦어요"(늦는 분 = 다시 울릴 시각 − 출발 시각, 올림) + 버튼 "15분 미루기 · 늦어요"와 경고 테두리, 5분만 미뤄도 늦으면 맨 위 경고 띠 "지금 일어나야 9:00 출발에 맞아요" (남은 준비 시간은 안 뺌). 목록(`plan.snoozeMinutesOptions`) · 한도(`plan.snoozeLimit`)는 `plan.ts`가 계획에 실어 보내고, 한도 · 늦어요 판단은 지금 시각이 필요해 네이티브(`SnoozeRules.kt`)가 같은 식으로 함 (`spec/cases.json`이 TS 쪽을 고정). 한도 · 목록에 없는 분은 `AlarmController.snooze`도 거절. 알림의 "미루기" 버튼은 기본 10분(`plan.snoozeMillis`) 하나 — 한도면 버튼이 빠지고 본문에 안내, 늦으면 알림을 올릴 때 한 번 정해 "10분 미루기 · 늦어요"(알림은 올라온 뒤 문구를 못 바꿔 분 수 · 경고 줄은 없음). 한도는 미루기만 셈(다시 울림은 안 셈). **네이티브(Kotlin)가 바뀌어 새 개발용 APK가 필요함** |
| 소리 | `soundKey`가 정하는 **배경음 파일**을 알람 스트림으로 반복해서 틂 (D1 A · Q7). `theme_calm`(약) · `theme_default`(보통) · `theme_urgent`(강) 세 파일이 `res/raw`에 있음. **약(`theme_calm`) · 강(`theme_urgent`)만 앱 파일을 먼저 틀고** 안 되면 폰 기본 알람음 → 폰 기본 벨소리 → 기본 알림음 순으로 넘어감. **보통(`theme_default`) · 기본 키(`default`) · 모르는 키는 폰 기본 알람음이 먼저**고 앱 파일(`theme_default.wav` · `alarm_siren.wav`)이 그 다음 예비 (10/18 지형님 — 안드로이드 기본 알람 정도는 되게, 10/30 확인). `theme_urgent`는 옛 사이렌(`alarm_siren.wav`)보다 작지 않게 RMS 0.55 이상. 파일은 `mobile/scripts/make-alarm-sounds.mjs`가 직접 합성한 것이라 외부 소리 · 라이선스 없음 (아래 표) |
| 진동 | `vibration`이 정하는 **패턴 3개**를 울리는 동안 반복 (알람 용도로 걸어서 무음 · 방해 금지에서도 울림): `NONE` = 진동 없음(진동을 건너뛰고, 알림이 뜰 때의 진동 한 번도 없는 알림 채널을 씀) · `SHORT_REPEAT` = 0.2초 켜짐 · 0.3초 꺼짐 · `STRONG_CONTINUOUS` = 0.8초 켜짐 · 0.1초 꺼짐(거의 연속). 진동 없음이어도 소리 볼륨은 위 전체 세기가 정한 값 그대로. 해제 · 미루기 · 3분 끝 · 서비스 끝에 소리와 같이 멈춤. 패턴 상수는 `AlarmProfiles.kt` |

배경음 파일 (PCM 16bit · 모노 · 44.1kHz, 반복 재생에 이음매가 안 들리게 처음 · 끝이 무음). `node scripts/make-alarm-sounds.mjs`(`mobile/`에서)로 다시 만들 수 있고 만든 파일을 커밋함:

| 파일 | 길이 | 소리 | 최대 진폭 |
|---|---|---|---|
| `theme_calm.wav` | 2.0초 | 낮은 음(G4 392Hz 사인) 한 번을 0.35초에 걸쳐 부드럽게 시작 → 천천히 사라짐, 0.7초 쉬고 반복 | 0.7 |
| `theme_default.wav` | 1.0초 | 기본 비프(A5 880Hz) 0.22초 × 2번 | 0.8 |
| `theme_urgent.wav` | 1.0초 | 높은 음(A6 1760Hz 사각파) 0.09초 × 8번을 0.125초마다 | 0.9 (RMS 0.61) |

**"간격"의 읽기 (해석 — 문서에 측정 기준 없음, 지형님 확인)**: 문서(#29 · 7장 7.4.2)는 "5분 후 1회 / 5분 간격 2회 / 3분 간격 3회"만 적고 어디서부터 재는지 없음. 한 울림(최대 3분)이 끝난 뒤 다음 울림이 시작될 때까지 쉬는 시간으로 읽음. 시작부터 시작까지로 읽으면 강은 3분 울림이 쉬는 틈 없이 12분 이어져서 "1회 최대 3분"이 의미가 없어짐.

| 강도 | 울림 시작 시각 (첫 울림 시작 = 0분) | 쉬는 시간 | 마지막 울림이 끝나는 때 |
|---|---|---|---|
| 약 | 0 · 8분 | 5분 | **11분** |
| 보통 | 0 · 8 · 16분 | 5분씩 | **19분** |
| 강 | 0 · 6 · 12 · 18분 | 3분씩 | **21분** |

마지막 열은 앱이 "안 끄면 다시 울림이 언제 끝나는지"를 셀 때 쓰는 "다시 울림 총 소요"(`unansweredSpanMillis`가 이 숫자를 돌려줌). 서버의 놓침(MISSED) 판정은 이 값을 쓰지 않고(친구 7장, 11/8) "마지막으로 울리기 시작한 때 + 30분"으로 센다. 읽기를 바꾸려면 `plan.ts`의 쉬는 시간 표(`RE_RING_GAP_MINUTES`)와 `spec/cases.json`만 고치면 되고 네이티브는 그대로 (첫 울림 시작으로부터의 거리를 그대로 AlarmManager에 걸기 때문).

다시 울림은 첫 울림이 시작될 때 다음 것을 **미리 AlarmManager에 걸어 둠** — 서비스가 죽어도 이어지고, 끄면(해제) 걸어 둔 것을 지우고, 미루면 그 자리를 미루기 시각으로 바꿈. 끝까지 안 끄면 놓침 판정과 `MISSED` 기록은 서버가 함(7장 7.9.2, 폰은 기록을 안 남김). 울림이 끝난 뒤 다음 울림을 기다리는 쉬는 동안에는 알림도 화면도 없어서 `stop()`이 아무것도 끄지 않음 — 앱에서 끄려면 `cancel(alarmId)`(기록 없음).

## 종류별 갈래 (#33)

| 종류 | 울림 | 원탭 버튼 → 남는 기록 |
|---|---|---|
| WAKE | 알람음 + 계속 진동 + 잠금화면 위 알람 화면 + 알림(해제 · 미루기). `setAlarmClock` | — (해제 · 미루기가 기록) |
| PREPARE | 보통 알림(알림음 · 진동 한 번). `setExactAndAllowWhileIdle` | "준비 시작" → `ACKNOWLEDGED` |
| DEPARTURE | 〃 | "출발했어요" → `ACKNOWLEDGED` |
| ARRIVE | 〃 | "도착했어요" → `ARRIVAL_CONFIRMED` |
| ROUTINE | 〃 | "했어요" → `ACKNOWLEDGED` |

알람음은 WAKE만이고 나머지는 보통 알림(알림음 · 진동 한 번) (10/18 지형님 — 보통 푸시처럼. 7장 7.4.1은 루틴도 소리 나는 알람으로 적었지만 이 문서가 기준 — 문서 보완 목록). 알림 채널은 "일정 알림"(기본 알림음 · 기본 진동 · 배너). 일정 알림은 한 번 알리면 끝이고 미루기 · 다시 울림이 없음. 원탭은 앱을 열지 않고 기록만 남김. 원탭 결과를 `appointment_participants`의 출발 · 도착 시각으로 옮기는 것은 앱(screen-data-map의 H07 · H08 참고).

`setExactAndAllowWhileIdle`은 절전(Doze) 중 앱당 약 9분에 한 번으로 제한될 수 있음 — 일정 알림끼리 9분 안에 붙으면 늦을 수 있음 (실기기 확인 6개와 함께 봄).

## 미루기 = 같은 알람의 상태

새 알람을 만들지 않고 같은 알람의 상태를 바꿈: `snoozeCount`(미루기만 셈) · `nextRingAt`(다음 울림). 그래서 `list()`는 알람당 한 줄이고, 서버와 맞출 때 미룬 알람이 지워지지 않음. 예전 `<id>__snooze` 항목은 없앰.

## 울림 기록 (#33 · #79)

폰이 앱이 꺼져 있어도 · 재부팅해도 남도록 쌓음 (SharedPreferences, 최대 1000줄). 앱이 켜지면 읽어서 `alarm_events`로 올리고 지움.

| 기록 | 언제 | 칸 |
|---|---|---|
| `TRIGGERED` | 울릴 때마다 (처음 · 미루고 난 뒤 · 다시 울림) | `sequenceNo`(울림 회차, 1부터) |
| `SNOOZED` | 미룰 때 | `snoozeMinutes`(고른 분 — 5 · 10 · 15, 알림 버튼은 10) |
| `DISMISSED` | 해제 | — |
| `ACKNOWLEDGED` / `ARRIVAL_CONFIRMED` | 일정 알림의 원탭 | — |

모든 줄에 `clientEventId`(폰이 만든 UUID — DB의 중복 방지 칸(#160에서 추가)에 그대로 들어감, Q11) · `alarmId` · `alarmType` · `eventType` · `at`(epoch ms) · `inputSource`(폰 안 버튼은 늘 `'BUTTON'`). 위치 · 사용 정보로 자동 남기는 기록은 앱이 따로 만듦. `WAKE_CONFIRMED` · `FEEDBACK` · `MISSED`는 폰이 남기지 않음.

앱이 `alarm_events`에 직접 남기는 기록 (폰 기록과 같은 `client_event_id` 중복 방지를 씀):

| 기록 | 언제 | 출처(`input_source`) · 번호 |
|---|---|---|
| `WAKE_CONFIRMED` | 기상 확정 — H08 · 앱이 앞에 올 때 다시 판정(아래) | 자동 `USAGE` / 직접 응답 `BUTTON`. 번호는 아래 "기록 번호 공식" |
| `DISMISSED` | 홈 "미루기 취소"를 기상 알람에서 눌렀을 때. `cancel`은 해제 기록을 안 남기므로 "이제 직접 일어남"을 해제로 보고 앱이 남긴 뒤 폰 예약을 지우고 H08로 이어감 (기록이 먼저 — 오프라인이면 예약을 그대로 두어 알람이 다시 울림) | `MANUAL`. 번호 `stableUuid('snooze-cancel-dismissed', alarmId, 처음 예약 시각 atMillis)` |

- 앱이 켜져 있으면 `addAlarmEventListener`로 새 기록을 바로 받음. 꺼져 있을 때 쌓인 것은 `getPendingEvents()`로 읽음 (오래된 순)
- 올리기에 성공한 것만 `markEventsUploaded(clientEventIds)`로 지움
- **폰이 스스로 올리는 길 (`DeviceUpload.kt`, WorkManager + 네트워크 조건)**: 알림 버튼(`ACKNOWLEDGED` 준비 시작 · 출발했어요 · 루틴 했어요, `ARRIVAL_CONFIRMED` 도착했어요)과 기상 알람 해제(`DISMISSED`)는 기록이 쌓이는 즉시(`AlarmEventLog.append` → `DeviceUpload.onAppended`) 작업을 걸어 서버 함수 `alarm-events-device`로 `alarm_events`에 넣음. 인증은 백그라운드 브리핑 갱신과 같은 기기 키(`BriefingCredential`, `Bearer bdk_…`) — 키가 없거나 만료 · 폐기면(401) 아무것도 안 하고 앱이 열릴 때 올림. 연결 실패 · 408 · 429 · 5xx는 30초부터 늘려 가며 최대 5번, 그 밖의 오류(400 · 401 · 403 · 404)는 다시 안 함. 울림(`TRIGGERED`) · 미루기(`SNOOZED`)는 이 길로 안 올리고 앱이 열릴 때 올림. 폰의 기록은 지우지 않음 — 앱이 열리면 아래 길이 같은 `clientEventId`로 다시 올려도 `alarm_events`가 번호 충돌을 무시해 한 줄이고, 원탭 뒤처리(`onEventsUploaded`: 출발 · 도착 시각 · 준비 실측 반영)도 그때 돎 (서버 INSERT 트리거가 원탭을 `appointment_participants`에 옮기므로 폰은 `alarm_events` 행만 올림). 앱이 올리는 길: 앱이 앞에 올 때 · 기상 확인 화면에 들어올 때 `lib/alarmSync`의 `uploadEvents()`가 `alarm_events`로 올리고(`client_event_id` 중복 무시) 올린 것만 `markEventsUploaded`로 지움. 로그아웃 때는 올려 본 뒤 남은 기록을 버림 (아래 "앞으로 더할 것")

## 해제 뒤 앱 열기 (#79)

WAKE를 해제하면(알람 화면 · 알림 버튼 모두) 앱을 `respecalarm://wake?alarmId=<alarmId>`로 엶 → 기상 확인(H08) · 아침 루틴 · 평가가 받음. 잠겨 있으면 잠금을 푼 뒤 열림. 알림의 "해제" 버튼은 보안 잠금이 걸려 있으면 잠금을 푼 뒤에 동작함 (잠금화면 위 알람 화면의 "해제"는 잠근 채로 됨). 알림의 "해제"는 안드로이드 12부터 알림 버튼이 리시버를 거쳐 화면을 열 수 없어 화면 없는 중계 화면(`AlarmActionActivity`)이 맡음. 앱의 `/wake` 화면은 이 `alarmId`(앱 안에서 오는 길은 `alarm`)를 둘 다 읽음 (`features/alarm/wake.ts` `pickAlarmId`).

## 기상 확인 — 사용 정보 읽기 (#35 · D14)

해제 뒤 폰을 썼는지를 읽어 H08 판정에 넣음. 설정 → 사용 정보 접근에서 사용자가 켜야 하고(`PACKAGE_USAGE_STATS`는 선언만 해 둠, 첫 빌드 Q12), 거부하면 "일어났어요" 버튼만.

- `getUsageSpans(from, to)` → `{ startMillis, endMillis }[]` (시각순). "사용 중" = 화면이 켜져 있고(`SCREEN_INTERACTIVE`) 잠금이 풀려 있는(`KEYGUARD_HIDDEN`) 동안. 앱 전환(ACTIVITY_RESUMED · PAUSED) 대신 이 이벤트를 쓴 이유: 알람을 끈 직후는 알람 화면 때문에 화면은 켜져 있어도 잠금이 안 풀린 상태라 "폰을 썼다"가 아니고, 잠금이 풀린 시각이 7장 7.13.8의 "해제 후 첫 잠금 해제"와 맞음. 어떤 앱을 쓰는지는 읽지 않음. 잠금 화면이 없는 폰은 화면 켜짐만으로 봄
- 이벤트는 안드로이드 9(API 28) 이상에만 있어서 그보다 낮으면 reject → 앱은 버튼으로
- `toUseSpans(spans, 해제 시각)` → `[해제 뒤 시작 분, 끝 분][]` — `features/alarm/wake.ts`의 `UseSpan`과 같은 모양이라 그대로 `usageSummary` · `thetaReachedAt`에 들어감
- **구간 보관 · 기록 시각 = θ 도달 시각 (D14)**: 사용을 분 합계가 아니라 구간(시작 · 끝)으로 읽어 두기 때문에, 누적 사용이 θ를 넘은 시각을 거꾸로 구해 `WAKE_CONFIRMED`의 `alarm_events.event_at`으로 남길 수 있음 (해제 시각이 아님). 구간 자체는 OS가 보관하는 이벤트에서 그때그때 읽고 모듈이 따로 저장하지 않음. 누적 · 최근 사용 분 값은 DB에 안 남음
- 알람을 끈 직후 앱이 H08로 열리면 그 화면을 보는 시간도 "사용"으로 셈 (화면 켜짐 + 잠금 해제라서). 이를 빼야 하는지는 앱 연결 때 확인

### 앱이 앞에 올 때 다시 판정 (`useWakeRecheck`)

알람을 끈 뒤 H08을 안 열면 앱 JS가 돌지 않아 판정이 안 나고, 서버가 약 49분 뒤 기상 미확인(`MISSED`)으로 적음 (7장 A는 "판정은 해제 10분 뒤에 나고"). 그래서 앱이 앞에 올 때(로그인 직후 포함) **최근 12시간에 끈 기상 알람 중 `WAKE_CONFIRMED`가 없는 것**을 H08과 같은 함수(`getWakeCheck` → `evaluateWake` · `thetaReachedAt`)로 다시 판정하고, 조건을 채웠으면 확정(`USAGE`)까지 기록함.

- OS가 보관한 사용 구간을 읽으므로 앱을 안 열어 둔 사이의 사용도 잡힘. `event_at`은 H08과 같이 누적 사용이 θ를 넘은 시각
- 조건을 못 채운 것은 아무것도 안 씀 — 확인 알림("일어났어요")은 H08을 열어야 보이고, `MISSED`는 서버 배치가 기록 (`MISSED` 뒤에 확정이 들어오는 것은 막지 않음 — 해제 뒤 49분 넘어 앱을 열었어도 폰을 쓴 사실이 있으면 기록)
- 쓰기는 H08과 같은 함수 · 같은 번호라 두 곳이 겹쳐도 한 줄. 한 알람이 실패해도 다른 알람은 이어서 판정
- **폰이 해제 + 10분에 스스로 판정함 (`WakeJudgeWorker`)**: 기상 알람을 끄면(`DISMISSED`) 그 시각 + 10분 + 2초에 WorkManager 작업이 돎(네트워크 조건, 같은 알람을 또 끄면 나중 해제 기준으로 교체). `UsageSpans`로 해제 ~ +10분의 화면 사용을 읽어 `WakeJudge.kt`가 앱 `evaluateWake`와 같은 규칙(θ 1분 · 관찰 10분 · 뒤쪽 5분 사용 > 0 · 확정 시각 = 누적 사용이 θ를 넘은 시각)으로 판정 — 같은 표(`spec/wake-cases.json`)를 앱 `wake.test.ts`와 Kotlin `WakeJudgeTest`가 읽음. 확정이면 `alarm-events-device`에 `wake`(그날 `daily_records` 빈 칸 · 한국 시간 날짜)와 `WAKE_CONFIRMED`(`USAGE`)를 한 요청으로 보냄 — 서버가 앱 `writeConfirmation`과 같은 순서(그날 기록 먼저, 이벤트 마지막)로 쓰고, 번호는 아래 공식(`StableUuid.kt`)이라 앱이 먼저 · 나중에 같은 판정을 해도 한 줄. 확정이 아니면(조건 미달 · 사용 정보 접근 권한 없음 · 안드로이드 9 미만) 아무것도 안 함 — 확인 알림("일어났어요")은 앱 H08 그대로. 앱이 나중에 열려 다시 판정할 때는 서버의 `WAKE_CONFIRMED`를 보고 이미 확정으로 처리해 안 씀

### 기록 번호 공식 (`client_event_id`)

앱이 만드는 고정 번호는 `lib/uuid.ts`의 `stableUuid(...조각)`. 네이티브가 같은 번호를 만들 수 있도록 공식을 적어 둠 (바꾸면 이미 올라간 기록과 번호가 달라져 중복 기록이 생기므로 바꾸지 않음 — `lib/__tests__/uuid.test.ts`가 아래 시험값을 고정):

1. 입력 글자 = 조각 배열을 JSON으로 (`JSON.stringify`, 공백 없음): 글자는 큰따옴표, 숫자는 그대로. 예 `["wake-confirmed","00000000-0000-4000-8000-0000000000b1",1747897200000]`
2. 시드 4개 `0x811c9dc5, 0x9e3779b1, 0x85ebca77, 0xc2b2ae3d` 각각으로 `hash32(입력 글자, 시드)`를 구해 8자리 소문자 16진수(앞을 0으로 채움)로 이어 붙여 32자 `hex`를 만듦
3. `hash32(text, seed)` (모두 부호 없는 32비트): `h = seed` → 글자의 UTF-16 코드 단위마다 `h ^= 코드; h = (h * 0x01000193) mod 2^32` (FNV-1a) → `h ^= h >>> 16; h = (h * 0x85ebca6b) mod 2^32; h ^= h >>> 13; h = (h * 0xc2b2ae35) mod 2^32; h ^= h >>> 16`
4. UUID = `hex[0..8]` - `hex[8..12]` - `5` + `hex[13..16]` - `V` + `hex[17..20]` - `hex[20..32]` 를 하이픈으로 이음 (`hex[a..b]`는 a번째 이상 b번째 미만 글자, 0부터). `V` = `((hex[16]을 16진수로 읽은 값 & 0x3) | 0x8)`을 16진수 한 글자로 (8 · 9 · a · b). `hex[12]`는 안 씀

| 기록 | 조각 | 시험값 |
|---|---|---|
| 기상 확정 `WAKE_CONFIRMED` | `'wake-confirmed'`, 알람 id, **마지막 해제(`DISMISSED`) 시각 epoch ms** — 해제 기록이 없으면(직접 응답만) 확정한 날 `'YYYY-MM-DD'`(한국 시간) | `stableUuid('wake-confirmed', '00000000-0000-4000-8000-0000000000b1', 1747897200000)` = `4b7f478f-5a2a-542a-92dc-9be071c05742` · 날짜 글자 `'2025-05-22'` = `9070d2b1-d569-5c26-acb3-e2e41be9c886` |
| 미루기 취소 해제 `DISMISSED` | `'snooze-cancel-dismissed'`, 알람 id, 처음 예약 시각 `atMillis` | `stableUuid('snooze-cancel-dismissed', '00000000-0000-4000-8000-0000000000b1', 1747897200000)` = `8ed95bc9-8f44-5f3c-9235-fc997bb707cb` |

마지막 해제 시각은 `DISMISSED` 기록의 `at`(epoch ms)이고 DB에도 같은 밀리초로 들어가므로 폰과 앱이 같은 값을 봄. `MISSED`의 번호는 서버가 따로 정함 (`md5('wake-missed:' || alarm_id || ':' || 알람 시각 초)::uuid`, `supabase/migrations/20261015000200_batch_notify.sql`).

## 평가로 볼륨 보정 (#81)

`volumeAdjustFromRatings(ratings)` — 최근 평가 5번(오래된 것 → 최근 순) 중 "너무 시끄러워요"(`TOO_LOUD`)가 2번 이상이면 `-0.1`, 아니면 `0`. 결과를 꾸러미의 `volumeAdjust`에 넣으면 같은 강도 그대로 볼륨만 10% 줄어듦. 누적되지 않음(그때그때 최근 5번만 셈), 강도별로 나눌지는 넘기는 쪽이 목록을 걸러서 정함. 평가 칩 화면은 새 UI라 나중.

## 웹 · 지원 안 하는 곳 (#98)

웹 · iOS는 메모리 대체: 예약 목록과 `ringNow` 기록만 메모리에 들고 울리지는 않음 (새로고침하면 사라짐). 그래서 웹 미리보기에서 "약속 만들기 → 알람 예약 → 목록"이 폰 없이 끝까지 보임. `isAvailable`은 false 그대로라 화면은 "실제로 울리지 않음"을 알 수 있음. Android인데 모듈이 없는 옛 APK는 예약 · 울리기를 거절하고 조회는 빈 값 ("예약된 줄 알았는데 안 울림" 방지).

## 앞으로 더할 것

| 언제 | 무엇 | 바뀌는 점 |
|---|---|---|
| 앱 연결 (P6, `lib/alarmSync` `reconcile` · `applyCommit`) | 서버 알람과 폰 예약을 대조 | 앱을 켤 때 `alarms`(켜짐 · 앞으로)와 `list()`를 `alarm_id` + `scheduled_at` + `intensity`로 비교. 빠진 건 `schedule`, 없는 건 `cancel`, 시각 · 강도가 다르면 다시 `schedule`(친구의 ±5분 · 제안 적용 · 설정 수정 뒤 푸시를 못 받았을 때 대비). 지난 시각은 `skipped_past`로 건너뛰고, `deferred`(울리거나 미룬 중)는 해제 뒤 다음 앱 열림 때 다시 넘김. 첫 울림이 이미 지난 폰 예약(울리는 중 · 미룸 · 다시 울림 대기)은 서버 목록에 없어도 바로 안 지우되, **서버에 켜진 행이 없다고 확인되면**(끄거나 지워짐, 시각은 안 봄) 지움 — 끈 알람이 미룸 중이어도 다시 울리지 않게. 확인에 실패하면 전체 맞추기는 안 지움(지정한 알람 `alarmIds`는 던져서 알림). 서버 알람 목록이 상한(500줄)에서 잘렸으면 "목록에 없음"이 "서버에 없음"이 아니므로 이 확인을 거친 것만 지움 |
| 앱 연결 (P6, `lib/alarmSync` `uploadEvents`) | 울림 기록 올리기 | 앱이 켜지면 `getPendingEvents()` → `alarm_events`(`clientEventId`로 중복 방지) → `markEventsUploaded`. 끄거나 재부팅한 동안의 기록도 이 길로 감. 알림 버튼 · 기상 해제를 바로 올리는 폰 스스로의 길은 위 `DeviceUpload` (기기 키 → `alarm-events-device`) |
| 로그아웃 (P6, `lib/session` `signOutAndCleanup`) | 정리 | 로그아웃 중 표시 켜기(`reconcile`이 서버 알람을 폰에 걸지 않게) → 기록 올려 보기 → 맞추기와 같은 한 줄에서 `cancelAll()`(앞에 서 있던 맞추기가 끝난 뒤) → 폰에 남은 기록 지우기 (Q6) → 푸시 토큰 지우기 자리 → 실시간 구독 끊기 · 기능 메모리 정리 → 로그아웃. `cancelAll`이 실패하면 로그아웃을 멈추고 표시를 끔 |
| 앱 연결 (P6, `useWakeRecheck`) | 기상 판정 다시 보기 | 앱이 앞에 올 때 최근 12시간에 끈 기상 알람 중 확정이 없는 것을 H08과 같은 판정으로 다시 보고 조건을 채웠으면 확정(`USAGE`) 기록 — 위 "앱이 앞에 올 때 다시 판정". 네이티브가 해제 + 10분에 스스로 판정하는 길은 위 `WakeJudgeWorker` (앱 `getWakeCheck`는 서버의 확정 기록을 보고 건너뜀) |
| D1 | 배경음 · 말소리 · 진동 축별 고르기 | **배경음 3개 · 진동 패턴 3개는 반영됨**(#312, D1 A). 말소리는 AI 음성 시작 단계로 반영됨(#532: 약 1 · 중 2 · 강 3) |
| D2 | 기상 확인 무응답 시 다시 울림 | 지금은 안 만듦 |
| Q7 | 소리 3종 | **반영됨**(#312): `soundKey`로 앱에 든 파일을 고름 (약 · 강만 앱 파일 먼저, `theme_default` · `default` · 모르는 키는 폰 기본 알람음 먼저). 파일은 지금 합성음이라 나중에 실제 소리로 바꿔도 키 · 이름은 그대로 |
| D8 | 음성 안내 | 알람 소리 채널로 폰 TTS가 `voiceText`를 읽음 (실패해도 사이렌은 울림). 문장은 지금 서버가 약속의 기상 알람에 채워 둠 — 읽는 것만 네이티브 PR |
| 나중 | iOS | AlarmKit 구현은 안드로이드 뒤 (Q9) |

## 지킬 것

- 알람은 서버 · 인터넷 없이도 울려야 함. 계산 · 저장은 서버, 울리는 건 폰
- 네이티브 코드가 바뀌면 모두 개발용 APK를 다시 받음 (PR에 적기). 진동 3개 · 배경음 3개(#312)도 Kotlin · `res/raw`가 바뀌어 새 APK가 필요함 — 옛 APK는 `soundKey` · `vibration`을 몰라서 예전처럼(폰 기본 알람음 + 0.5초 진동) 울리고, `list()`에도 두 칸이 없음
- 실기기 확인 6개(잠금화면 · 볼륨 0 · 최근 앱에서 닫기 · 재부팅 · 방해 금지 · 미루기)는 알람 코어를 바꿀 때마다 다시 봄 — `respecalarm://dev/alarm-test`. 이번에 더해 볼 것: 강도 3단계 볼륨 · 3분 뒤 멈춤과 쉬었다가 다시 울림 · 일정 알림 원탭 · 해제 뒤 앱이 `wake?alarmId=`로 열림(실제 일정 알람으로 확인 — 개발 화면 시험 알람은 해제 · 미루기 뒤 알람 테스트로 돌아옴, `features/alarm/ringExit.ts`) · 사용 구간 읽기
