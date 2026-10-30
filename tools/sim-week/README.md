# sim-week — 가상 유저 일주일 시험 하네스 (작업 중)

> 초안 PR. 바닥(데이터 · 앱 순수 함수 불러오기 · 하루 진실 시뮬레이터 · L1 계산 호출)까지만 됨. 아래 "남은 일" 참고.
> 실호출 · API 키는 이 PR에 없음 (`ANTHROPIC_API_KEY`는 실행 단계에서 env로만 읽을 예정).

## 시험 기준 (헤드 10/30)

1. 씨앗 고정(사람 id + 날짜). 위치 조정 때는 같은 씨앗, 값만 바꿈.
2. 아침 행동 = 인물 카드 값 + 하루 흔들림. 미루기 횟수 = 0..snooze_tendency 중 하나(최대 3번, 미루기 시간은 앱 기본, D3). 늦잠(첫 알람을 놓쳐 미루기 3번 다 쓰고 +15분) = chronotype LATE 또는 새벽 2시 이후 취침 인물만 주 1번, 나머지는 주 0번. 준비 = prep_minutes × 0.9~1.2 + 그 요일 recurring_reasons 분. 이동 = travel_minutes × 0.9~1.25, 주 1~2일은 비 오는 날로 대중교통 +15%.
3. 위치 상황 6종: 한 주에 6종 모두 최소 1번, 한 사람 하루 최대 1개, 나머지 날은 깔끔한 날. 조깅은 아침형 인물, 나머지는 고루.
4. 밤 대화 카드 수락: cooperation HIGH 90% · MID 70% · LOW 40%, 정정은 correction_tendency대로. AI 질문 수 · 원탭이 필요했던 수는 매일 셈(하루 1 · 주 3 — D104 · 7.15 기준 위반이면 버그 후보로 표시).
5. 지각 경계 · 반경 · 감지 지연은 L2 코드 값을 그대로 쓰고, 위치 조정 표에서만 바꿈 — 시험이 따로 정하지 않음(+11분 경계도 조정 표 안에서만, 기본 실행은 코드 값).
6. 결과 표에는 사람 × 날짜 줄마다 "PR 코드"(해당 PR 번호) 표시 · 쓴 씨앗 · 상황 이름.

코드 기준: main 머지분은 main 그대로. 아직 PR인 #240 · #247 · #250 · #241은 그 브랜치를 합친 임시 worktree를 `--app-root <경로>`(또는 env `SIM_APP_ROOT`)로 가리켜 부름. 합친 브랜치는 push하지 않음.
하네스가 혼자 정한 것은 `DECISIONS.md`. 현재 코드가 헤드 기준과 다른 곳(미루기 규칙 · 상황 배정)은 위 기준에 맞춰 고쳐 둠.

## 지금 되는 것

- (추가) `location.ts` — 진실 → 신호(반경 · 감지 지연) → L2 `planRegions`/`interpretSignals`/`resolvePending` + `participantTimes` 출처 · 지각 규칙 → 기록 · 오판 · 원탭. 시험 4건(`location.test.ts`)
- (추가) `bridge.ts` `--app-root` / `SIM_APP_ROOT`, `DECISIONS.md`

- `data/` — ai-lab p01~p08(dev) 사람 · 같은 사람의 7일 일정 · v3 말투 · 습관, `prompts/SIM.v3.1.md`, `schemas/sim-user.v2.json` (복사본, p09~p12는 복사하지 않음)
- `loader.mjs` + `bridge.ts` — 앱(`mobile/src`)의 순수 함수를 앱 코드 수정 없이 Node에서 불러옴 (`@/…` · `@shared/…` 별칭, 확장자 없는 import 해석, supabase/user는 던지는 껍데기로 대체)
- `persona.ts` — 하루 일정 · 장소(좌표 · 분류) · 위치 상황 배정표(6종이 한 주에 모두 나옴)
- `l1.ts` — `computePlan`(plan-core) · `resolveTravel` · `predictPrepare` 를 그대로 호출
- `day.ts` — 결정론 하루 시뮬레이터 (기상 · 미루기 · 늦잠 · 준비 · 출발 · 이동 · 도착 · 진짜 지각, 편의점 · 조깅 · 도착 전 귀가 움직임)
- `foundation.test.ts` — 5건 통과

실행: `node --test "tools/sim-week/**/*.test.ts"`

## 남은 일 (이어받을 때)

1. `location.ts` — 진실(DayTruth) → 신호(반경 · 감지 지연 1~6분) → `planRegions` / `interpretSignals` / `noteRegistered` → 기록(출발 · 도착 · is_late). 지각 경계 +5(실제 `judgeArrival`) · +11(하네스 규칙) 선택. 상황 6종(NEAR · CAMPUS · SUBWAY_DUP 포함) 판정 시험
2. `ledger.ts`(누적 $ 장부 · `--budget` · 즉시 멈춤) · `live-client.ts`(fetch 기반 LlmClient, env 키, 없으면 NOT_CONFIGURED) · `fake-llm.ts`(녹화 응답)
3. `sim-user.ts`(SIM.v3.1 렌더 · claude-haiku-5-5) · `coach.ts`(T2F ∥ T1 → 처리 결과 → T1, 서버 처리 stub, 카드 · 알람 제안 · 질문 예산)
4. `week.ts`(7일 이월: 기록 · 4주 지각 · P80 통계 · 질문 예산) · `adjust-runs.ts`(집 반경 150/200/300 · 목적지 반경 · 지연 1/3/6 · 지각 +5/+11) · `report.ts` · `run.ts`(`--personas --days --budget --fake --live --smoke`)
5. 시험: 한 사람 하루 · 이틀(학습이 알람을 바꾸는지) · 예산 멈춤 · 재개 · 위치 6종 · 보고서
6. `docs.md`(L1 입력 → 알람 정리, L2 "불러올 수 없음" 표) · 이 README 완성 · `docs/시험/가상유저_일주일_1030.md`는 실호출 뒤

## 미리 보인 이상한 점 (후보, 코드 확인 필요)

- `plan-core.ts`: 통계는 `actual_prepare_minutes`(= 출발 − 기상, `participantTimes.prepareMinutesOf`)인데 `toMorningMinutes`가 준비 전 활동 20분을 또 더함 → 학습 값이 이중으로 부풀 수 있음 (L1)
- `calc/prepare.ts`: 기록 1~4건이어도 보정이 이미 적용되고 출처 이름만 DEFAULT (L1)
- `participantTimes.ts`: 도착 전 귀가로 위치 출발이 지워져도 이미 쓴 `actual_prepare_minutes`는 안 지워짐 (RETRACT 경로에서 정리하는지 확인, L2)
- `location/area.ts` `namesWholeSchool`: 대학교 분류에 한 낱말 이름("경영관")이면 학교 전체(CAMPUS 300m)로 분류 (L2, 카카오는 보통 "○○대학교 경영관"이라 영향 작음)
