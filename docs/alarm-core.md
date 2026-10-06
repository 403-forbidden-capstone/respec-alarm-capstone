# 앱 ↔ 알람 코어

알람 예약 · 울림은 폰의 네이티브 모듈 `@capstone/alarm-core`(`mobile/modules/alarm-core`)가 맡음. 화면은 이 모듈의 JS 함수만 부르고, 서버는 알람을 울리지 않음.

```text
화면 → alarm-core(JS) → AlarmManager.setAlarmClock → 시각이 되면 BroadcastReceiver
     → 포그라운드 서비스 → MediaPlayer(알람 소리 채널) + 잠금화면 위 알람 화면
```

## 지금 있는 것 (#26)

| 함수 | 하는 일 |
|---|---|
| `scheduleOneShotAlarm(id, title, atMillis)` | 그 시각에 한 번 울림, 같은 id면 덮어씀 |
| `scheduleDailyAlarm(id, title, hour, minute)` | 매일 울림 |
| `cancelAlarm(id)` · `cancelAllAlarms()` | 예약 지우기 (미룬 알람 포함) |
| `getScheduledAlarms()` | 폰에 걸린 예약 목록 |
| `canScheduleExactAlarms()` · `canUseFullScreenIntent()` | 정확한 알람 · 잠금화면 알람 화면 권한 |
| `startAlarmTest(title)` · `stopAlarm()` | 바로 울리기 · 끄기 |
| `isAlarmCoreAvailable` | Android + 모듈이 든 APK인지 (웹 · 옛 APK면 false, 함수는 거절 · 빈 값) |

울림: 알람 볼륨을 최대로 올렸다가 끄면 되돌림, 10분 미루기, 재부팅 · 시간 변경 뒤 다시 예약.

## 앞으로 더할 것

| 언제 | 무엇 | 바뀌는 점 |
|---|---|---|
| #29 강도 3단계 | 예약할 때 강도(SOFT · NORMAL · STRONG)를 같이 넘김 | 볼륨 60 · 80 · 100%, 소리, 진동, 안 끄면 다시 울림(약 5분 뒤 1번 · 보통 5분 간격 2번 · 강 3분 간격 3번). 미루기는 최대 3번, 같은 강도 |
| #33 알람 4종 | 종류(WAKE · PREPARE · DEPARTURE · ARRIVE)를 같이 넘김 | 소리는 WAKE만. 나머지는 소리 없는 알림 + 원탭 버튼("준비 시작" · "출발했어요" · "도착했어요") |
| #33 기록 | 폰에서 생긴 일을 앱으로 넘김 | 울림 · 미루기 · 해제 · 원탭을 폰에 쌓아 두고, 앱이 켜지면 `alarm_events`로 보냄(오프라인이어도 안 잃어버림) |
| #33 맞추기 | 서버 알람과 폰 예약을 대조 | 앱을 켤 때 `alarms`(켜짐 · 앞으로)와 `getScheduledAlarms()`를 비교해 빠진 건 예약, 없는 건 취소 |
| #35 기상 확인 | 해제 뒤 10분 동안 폰을 썼는지 | 사용 정보 접근 권한(설정 화면에서 켬)으로 화면 켜짐 · 잠금 해제 시각을 읽음. 거부하면 "일어났어요" 버튼만 |
| 나중 | 음성 안내 | 알람 소리 채널로 폰 TTS가 한두 문장 읽음 (실패해도 사이렌은 울림) |

## 예약 꾸러미

서버 `alarm-commit`이 돌려주는 값을 그대로 폰에 넘기는 모양. 예약 함수는 이 모양 하나로 합침(#29 · #33).

```ts
type RingPackage = {
  alarmId: string;        // alarms.alarm_id
  type: 'WAKE' | 'PREPARE' | 'DEPARTURE' | 'ARRIVE' | 'ROUTINE';
  atMillis: number;       // alarms.scheduled_at
  title: string;          // 약속 제목
  subtitle?: string;      // "오전 10:00 · 세종대학교"
  intensity: 'SOFT' | 'NORMAL' | 'STRONG';
  snoozeLimit: number;    // 기본 3
  voiceText?: string;     // 음성 안내 문장 (나중)
};
```

## 지킬 것

- 알람은 서버 · 인터넷 없이도 울려야 함. 계산 · 저장은 서버, 울리는 건 폰
- 네이티브 코드가 바뀌면 모두 개발용 APK를 다시 받음 (PR에 적기)
- 실기기 확인 6개(잠금화면 · 볼륨 0 · 최근 앱에서 닫기 · 재부팅 · 방해 금지 · 미루기)는 알람 코어를 바꿀 때마다 다시 봄 — `respecalarm://dev/alarm-test`
