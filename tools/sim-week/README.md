# sim-week — 가상 유저 일주일 시험 하네스 (작업 중)

> 초안 PR. 바닥(데이터 · 앱 순수 함수 불러오기 · 하루 진실 시뮬레이터 · L1 계산 호출)까지만 됨. 아래 "남은 일" 참고.
> 실호출 · API 키는 이 PR에 없음 (`ANTHROPIC_API_KEY`는 실행 단계에서 env로만 읽을 예정).

## 지금 되는 것

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
