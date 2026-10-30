# sim-week 안내서 — L1 입력 → 알람, L2 못 부른 것

기준: main `ad1f923`(10/30, #269 학습 기초 a · #247 · #240 포함). 앱 · 서버 코드는 한 줄도 안 고치고 `bridge.ts`로만 불러 씀.

## 1. L1 입력이 알람을 어떻게 바꾸는지

알람 사슬(`calc/chain.ts` `alarmChain`): 도착 목표 = 약속 − 여유 · 출발 = 도착 목표 − 이동 · 기상 = 출발 − 준비(기상~출발) · 준비 알람 = 기상 + 준비 전 활동 20분. 그날 두 번째 일정은 기상 · 준비 전 활동 없이 준비 알람이 출발 − 15분.

| 입력 | 알람이 바뀌는 방식 | 코드 | 하네스가 넣는 값 |
|---|---|---|---|
| 약속 시각 · 여유 | 도착 목표 · 출발이 그만큼 이동 | `calc/chain.ts:15-30` | 인물 일정 · `buffer_minutes` |
| 이동 시간 | 출발 · 기상이 그만큼 이동. 길찾기(카카오) → 안 되면 같은 길 실측 3건↑ 중앙값 → 좌표 근사(확인 필요) | `route.ts` `resolveAutoTravel` | 카카오 대역: 인물 `api_estimate_min`(평소보다 짧게 나오는 사정) 그대로. 카카오가 켜져 있으니 실측은 안 쓰임(`learnedAt`이 모으기만 함) |
| 준비 첫 값(온보딩 "일어나서 나가기까지") | 기록이 없을 때 기상~출발 = 이 값 (5~300분, 밖이면 50) | `plan-core.ts` `firstPrepareMinutes` | `prep_minutes`를 5분 단위로 (`app-state.ts onboardingPrepareOf`) |
| 내 기록(최근 30건, 10~240분) | 준비 = 첫 값 + n/(n+10) × (내 P80 − 첫 값). 5건부터 출처 "내 기록 기반 N건", 4건까지 "배우는 중 N/5" | `calc/prepare.ts` `predictPrepare` · `prepareStatsOf` | 하루 기록 `actual_prepare_minutes`(출발 − max(실제 기상, 예정 기상))를 날마다 쌓음 → `learnedAt` |
| 그날 두 번째 일정 | 기상 없음, 개인 보정 없음(기록 수와 상관없이 15분) | `plan-core.ts:291-294` | 카드 저장 때 그날 이미 저장된 기상 알람을 보고 다시 판단(서버 alarm-commit과 같음) |
| 반복 다음 회차 | 직전 회차 준비값 ±10분 안에서만 움직임 | `plan-core.ts` `clampPrepareToBound` · `roll.ts:182 · 240` | 인물 일정은 한 주 안에서 되풀이되지 않아 안 쓰임. 확인 표 2줄만 같은 입력으로 합성 |
| 중요도 | 매우 중요(HIGH)면 강도 +1 | `calc/intensity.ts:37` | 인물이 말한 값 → 서버 키워드 사전(시험 · 면접 · 발표 …) → 기본 NORMAL |
| 최근 4주 지각 수 | 2번 이상이면 강도 +1 (최대 강) | `calc/intensity.ts:37` | 앱이 지각이라 판정한(밤 대화 정정 반영) 도착 수 |
| 직접 고른 준비 · 시각 | 그 값이 먼저(출처 MANUAL) | `plan-core.ts` `override` | 서버 질문 답("내일은 더 걸려요 +N분") → 앱이 자동 준비 + N을 직접 값으로 (`voice/real.ts prepareOf`와 같음) |
| 잠귀 · 깨우는 여유 | (설계) 잠귀 깊음 → 강, 빠듯 · 보통 · 넉넉 = 0.7 · 0.8 · 0.9 분위수 | **지금 계산이 안 읽음**(학습 기초 b 미머지) | 기능 확인 표 3 · 5b가 이 빈틈을 봄 |

### 학습이 알람을 바꾸는 길 (하네스에서 도는 한 바퀴)

1. 밤 대화로 내일 일정 카드 → 앱이 L1 계산(첫 값 + 기록) → 사람이 저장 → 알람
2. 아침: 알람 · 미루기 · 준비 · 출발(위치 신호 → L2 판정) → `actual_prepare_minutes` 기록
3. 다음 밤: 어제 기록을 "확인할 기록"으로 보여 줌 → 틀린 출발 · 도착은 정정(L2 `recordParticipantTimes` 규칙) → 기록 · 지각 판정이 바뀜
4. 그날 밤 새 일정 카드 → 쌓인 기록으로 준비 · 기상 알람이 움직임 (시험 `week.test.ts` "이틀")

## 2. L2에서 하네스가 못 부른 것 · 이유

순수 판정(`transitions` · `regions` · `attach` · `geo` · `area` · `participantTimes`의 순수 함수)은 그대로 부름. 아래는 못 부르거나 흉내 낸 것.

| 코드 | 못 부르는 이유 | 하네스가 대신 하는 것 |
|---|---|---|
| `location/register.ts` `native.ts` `task.ts` `useLocationSync.ts` | expo-location · TaskManager · RN(네이티브) | `location.ts`가 진짜 움직임 → 신호(반경 통과 시각 + 감지 지연)로 바꿔 `interpretSignals`에 넣음 |
| `location/store.ts` `lock.ts` `actions.ts` `notice.ts` | AsyncStorage · 잠금 · 알림 | 상태(GeoState)를 메모리에 들고 한 신호씩 넣음. 오프라인 보관 · 중복 알림은 안 봄 |
| `alarm/participantTimes.ts` `recordParticipantTimes` · `clearLocationTime` · `readLocationTime` | supabase DB 읽기 · 쓰기 | 순수 함수(`decideWrite` · `judgeArrival` · `prepareMinutesOf` · `mayWritePrepare` · `travelMinutesOf`)를 같은 순서로 불러 `location.ts`(위치) · `correctRecordTime`(대화 정정)이 흉내. DB 제약 · 알람 행 없으면 안 쓰는 규칙은 안 봄 |
| `location/real.ts` `listEarlierDepartures` · `listDetections` | DB | 서버 쪽 사본 `context-core.earlierDeparturesOf`(같은 규칙)에 위치 출발 액션을 넣어 "잠깐 나갔다 들어옴" 줄 |
| `location/real.ts` `rejectDetection` · `undoReject` ([아니에요] · 5초 되돌리기) | DB · 화면 | 안 함. 대화 정정 DENY는 앱이 아직 못 함(`voice/fixes.ts:27` `denyDetection` = false, L2 PR 6 대기)이라 그 결과("아직 안 됨")를 그대로 셈 |
| `alarm/oneTap.ts` 원탭 뒤처리 | 알람 이벤트 · DB | 원탭 응답은 `tap_prob`로 응할지만 정해 BUTTON 값으로 `decideWrite` |
| 알람 울림 · 미루기 UI · 잠금 해제 감지 | 네이티브 · 사람 | `day.ts` 진짜 하루 시뮬레이터가 인물 카드(미루기 · 늦잠 · 누워서 폰)로 흉내 |
| 모델 · 대화 글 | 기능 모드 — 호출 없음 | `fake-llm.ts`가 T2F 출력(FastExtract)을 인물 진실에서 규칙으로 만들고, T1은 처리 결과 줄만 (`DECISIONS.md` 23) |

## 3. 지금 되는 것 / 아직 안 하는 것

되는 것: 한 사람 하루 · 이틀 · 최대 7일 이월(기록 · 4주 지각 · 질문 예산), 밤 대화(카드 수락 확률 · 정정 · 서버 질문 · 준비 가감 카드)를 서버 순수 함수로, 위치 상황 6종 · 위치 조정 표, 기능 확인 표(문서 5절), 보고서(`runs/`, 레포에 안 올림).

아직 안 하는 것: 실호출(`--live`는 거절) · 모델 대화 글 · 가상 유저 앱 리뷰 · `live-client.ts` · 7일 본 시험 결과 페이지(`docs/시험/가상유저_일주일_1030.md`).
