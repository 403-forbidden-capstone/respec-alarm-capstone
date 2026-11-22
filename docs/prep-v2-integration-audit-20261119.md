# 준비 시작시각 CatBoost v2 통합 사전 감사 — 2026-11-19

> 대상: Re:Spec Alarm, `main` + Draft PR #549, Supabase 원격 DB/Edge(읽기 전용 확인). **코드/DB/EC2 배포·모델 활성화 없음.**
> 결론: **NO-GO for production; GO for gated shadow integration after P0 fixes.**

## 0. 올바른 시간 의미 (모델 교체 전 불변식)

- `departure_at = appointment_at - route_eta - arrival_buffer`
- `prepare_at = departure_at - pure_prep_minutes`
- `wake_at = prepare_at - planned_preprep_task_minutes - wake_lead_minutes` (기상 알람을 생성하는 경우)
- 고정 기본 `wake_lead_minutes=20`은 이 PR에서 변경하지 않음. 다른 준비 전 할 일은 별도 분리.
- **이전 `profiles.default_prepare_minutes`, `appointment_participants.prepare_minutes`, `daily_records.actual_prepare_minutes`는 전부 기존 코드에서 기상~출발 전체 소요시간으로 해석**하므로 새로운 외출 준비시간의 교사 데이터나 초기값으로 자동 전용하지 말 것.

예시: 약속 10:00, ETA 30, 도착 여유 10 → 출발 09:20; 순수 준비 35 → 준비 08:45; 준비 전 활동 0/기본 여유 20 → 기상 08:25. 오후 두 번째 일정이라도 기상이 없을 뿐 준비시작시각 계산은 유지해야 함.

## 1. 실측 확인(2026-11-19, 읽기 전용 집계)

- `profiles`: 8명(온보딩 완료 8); `default_prepare_minutes` 모두 값 존재(30/35/40/50/60분 등).
- `appointment_participants`: 97행; `prepare_started_at` 37행, `departed_at` 45행.
- 두 시간이 있는 유효쌍(출발 > 시작, 5~240분): 30행, **4계정**; 6회 1계정, 8회 3계정.
- 기간 2026-11-03~2026-11-17; 평균 약 38.90분, 중앙값 38.50분, P90 49.30분.
- 이 30개 시작 출처는 전부 `PREPARE_ALARM`(사용자 해제/원탭), 출발 출처는 `LOCATION`. **실제 행동 시작과의 일치 및 테스트/시드 데이터 여부 미검증**.
- `daily_records.actual_prepare_minutes` 유효 23행이지만 기상→출발로 측정됨. 새 타깃에서 사용 금지.
- **아직 없음**: `profiles.default_outing_prep_minutes`, `appointment_participants.prepare_mode`, `appointment_participants.activity_plan`.
- 실제 데이터로 CatBoost v2를 재학습하기엔 4계정만으로 일반화 평가 불가. 현재 `train.py` 기본 요건은 학습 가능 100계정.

## 2. 코드 감사: P0 차단사항

| ID | 현상/근거 | 잘못될 수 있는 결과 | 통합 작업 |
|---|---|---|---|
| P0-01 | `PrepareStep.tsx` 질문 "일어나서 집을 나서기까지 보통 몇 분?", `profiles.default_prepare_minutes` 저장 | 30분(기상→출발)을 30분(준비→출발)로 해석 | 새 필드 `default_outing_prep_minutes` + 새 질문. 기존 값 보존·재설정 안내·부분 마이그레이션 금지 |
| P0-02 | `plan-core.ts`, `calc/chain.ts`의 `prepare.minutes`는 whole morning; v2는 pure prep | 20분 이중 계산 또는 PREPARE/WAKE 동시 틀어짐 | 출발, 준비, 기상 시간 각각 typed inputs로 분리. 20분 정책은 유지 |
| P0-03 | `request.ts createCommitBody`와 `existingBody`가 자동 예측 `prepare_minutes`도 직접 입력처럼 다시 보냄 | 저장 후 `draft.prepareMinutes != null`이라 ML 재실행 불가; 자동이 수동 고정으로 변질 | `prepare_source: AUTO/MANUAL` 명시·DB 저장, preview/commit 동일 스냅샷 정책·재예측 조건 정의 |
| P0-04 | #549 `plan.ts`의 v2 게이트는 `withWake=true`, `sameDayWake=false` 중심 | 오후/그날 두 번째 약속은 새 준비시각 예측이 빠지고 15분 기본값으로 복귀 | 준비시간 예측은 WAKE 존재와 독립적으로 적용, WAKE 생성 여부는 별도 판단 |
| P0-05 | `roll.ts` · `edit-run.ts` 등에서 `computePlan` 직접 호출 | 반복 회차/일정수정 시 v2 예측 미전달, 알람 시각 불일치 | 예측 결정/보존을 단일 계산 진입점에 연결하고 모든 호출 경로 회귀 테스트 |
| P0-06 | `services/prepare-ml/app.py`는 `c1_mae/w4_mae`와 기존 피처만 하드코딩, 포인트 분 예측 | .cbm만 교체하면 피처 검증 실패 또는 타깃 단위 혼동 | 별도 v2 sidecar를 먼저 병렬 검증 또는 FastAPI 다중 버전 계약 개편; `/health`, `/predict` 분리 검증 |
| P0-07 | 생활시간조사 v2 `survey_start_cluster_proxy`는 실제 준비 시작이 아닌 141/142 마지막 구간 추정 | 실측 알람 정확도 미입증, 과소예측 약 50.78% | 운영 알람은 기존 유지, v2는 shadow only. 진짜 시작/출발 실측·과소예측 안정성 검증 후 적용 |
| P0-08 | `activity_plan` DB 컬럼 없음, 당일 사전 준비 활동 피처 없음 | 머리감기/식사/과제에 따른 준비시간 보정 불가능 | 시작 전 활동 vs 준비 중 활동 구조/저장/동의, 사전 입력 시점과 피처 타임스탬프 정의 |
| P0-09 | `PREP_ADJUST_ENABLED` 호출 로직은 Draft PR #549에만 존재; 원격 `alarm-suggest`/`alarm-commit`에는 없음 | 앱은 모델을 호출할 수 없음 | Edge 새 버전 배포 전 전체 검증; live 플래그 기본 OFF, 허용 계정 only |
| P0-10 | #549 브랜치와 현재 main이 분기됨; 관련 자동 회귀 CI 실행 성공 결과 없음 | 머지 후 계산/타입 충돌 및 누락 | main 최신 rebase/merge, 모든 단위·통합·E2E 실행하고 리뷰 |

## 3. P1 확인사항

- `PREPARE_ALARM` 기록은 사용자 알람 해제/원탭이지 확정된 물리적 준비 시작이 아님. 아침식사 등 도중의 준비 알람 해제는 라벨 편향.
- `departed_at` LOCATION 기반 이동 감지 지연, 짧은 외출/실내 출발, 폰 GPS 오류, 수동 보정 및 삭제 시 기록 갱신 규칙 필요.
- 일정의 출발 ETA 변경, 약속 수정, 수동 PREPARE/WAKE, 친구 제안 `prepare_advance_minutes`, 자정/시차, 같은 날 여러 약속, 저녁 기상 생략, 반복 14일 생성에 대한 재계산 계약 정의.
- `wake_margin`(기존 0.7/0.8/0.9)과 v2 평균 예측의 과소예측률이 호환되지 않음. v2 80% quantile 후보도 실제 앱 데이터로 별도 재보정 필요.
- (n=0) 온보딩 수치는 self-report라 v2 학습의 '첫날 관측값'과 분포 다름. **cold: 온보딩 순수 준비분 그대로**, (n>=1): 신뢰도 가중 경험평균, CatBoost는 검증된 영역에서만 shadow→actual. 최소 기록 기준 3은 실험 설정이지 과학적 확정이 아님.
- 새로운 준비시간/활동 기록 수집·ML 사용에 필요한 이용자 동의와 데이터 보존 정책 검토. 연구용 연령 동의만으로 행동기록 2차 사용이 자동 승인되진 않음.
- 모델 바이너리는 GitHub PR에 없음. EC2 컨테이너 실제 실행 여부·설정/모델 해시·서버 라우팅은 현재 조회 수단으로 확인 못 함.

## 4. 단계별 통합 순서

1. **P0 기능 정의/DB**: `default_outing_prep_minutes` 별도 추가, 새 온보딩/설정 UI, `prepare_mode` 및 모델/버전/예측시간 출처 저장, 기존 필드 의미 유지. 최소 범위의 migration + RLS 확인.
2. **알람 계산 분리**: DEPARTURE = ETA, PREPARE = DEPARTURE−pure_prep, WAKE = PREPARE−preprep_tasks−20 (기상 만들지 않는 일정은 WAKE만 생략). 편집·반복·그룹·수동 경로까지 적용. 기존 20분 값 수정 금지.
3. **추론 및 이력**: 새 v2 API를 기존 C1/W4와 병렬로 두고 모델 유형·기준시간·예측 시점 기록. `actual` vs `survey_proxy` provenance 검증. 실측 history n<3 cold fallback. 테스트 계정/flag만.
4. **Shadow 비교**: 기존 실제 알람 유지 + 새 예측만 로깅; 기존 기준, v2 point, v2 P80을 동일 사용자/날짜에 비교. 실제 출발·준비 확인 시각과 성능/오탐·데이터 누락 확인.
5. **Go/No-Go 결정 후 배포**: 서버 건강성/토큰 보호/HTTPS, staging Android E2E, 원격 Edge 버전과 저장된 UTC 일치, 규칙·누락·돌발 이동 회귀 테스트. 선택 계정부터 활성화, 이전 버전 신속 롤백 가능하게 보존.

## 5. 필수 수용 테스트 시나리오

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| T01 | 약속 10:00, ETA 30, 여유 10, 순수 준비 35, 준비 전 여유 20 | 출발 09:20 / 준비 08:45 / 기상 08:25 |
| T02 | 위 조건에 준비 전 식사 30 | 준비 08:45 유지, 기상 07:55 (중복 합산 없음) |
| T03 | 머리 감기 추가로 순수 준비 예측이 35→50 | 준비 08:30으로 당김, 기상도 동일하게 15분 당김 |
| T04 | 오후 17:00 두 번째 약속/WAKE 생략 | 새 순수 준비 예측을 적용한 PREPARE와 DEPARTURE는 생성 |
| T05 | 온보딩 기존 전체 60분 사용자의 첫 업데이트 | 60을 새 순수 준비시간으로 자동 변환하지 않음, 새 입력 필요 |
| T06 | 새 온보딩 값 30분, 이력 0건 | 30분 사용; CatBoost가 훈련받지 않은 self-report에서 임의 예측 금지 |
| T07 | 실측 기록 1, 2, 3개 / 4번째 추가 | 활동/기준값이 진짜 과거 완료 기록만 참조; 3건 기준 버전 제어 |
| T08 | 수동 준비시간 변경 후 저장/재열기 | AUTO로 되돌리기 전까지 수동 우선, 자동 예측으로 덮지 않음 |
| T09 | 자동 미리보기→저장→수정→반복 다음회차 | 동일 입력은 동일 시각, 출처 AUTO 유지, 모델 경로 누락 없음 |
| T10 | 준비 시작 누락/출발 LOCATION 60분 지연/시작>출발 | 학습/예측 입력 제외, 폴백·수동 교정 |
| T11 | 모델 장애·토큰 오류·잘못된 스키마·이전 모델 서빙 | 모델 적용하지 않고 기존 계산/경고, 사용자 알람 누락 없음 |
| T12 | 준비 알람 당김 10분/친구 제안/재계산 | 중복 당김 없음, 세 알람 순서 유지, 학습 라벨 신뢰도 구분 |
| T13 | 자정 넘김/타임존/휴일코드 | 현지 기준 날짜와 1/1.0 범주 정규화 동일 |
| T14 | 알람 비활성/개인정보 동의 철회/계정 삭제 | 추론 차단, 해당 사용자 이력 사용 중단 및 삭제 경로 검증 |

## 6. 배포 전 체크

- [ ] `main` 최신 반영, #549 전체 suite 통과 및 리뷰
- [ ] v2 모델 바이너리 `.cbm`, manifest SHA256, 학습 피처 유형·순서·카테고리 단일 계약
- [ ] 기존 서버 C1/W4 활성 상태 확인 (EC2/Docker 실제 `health` 및 Edge 플래그)
- [ ] `alarm-suggest`/`alarm-commit`/수정/반복/그룹 E2E 및 DB 미리보기=저장 일치
- [ ] 원격 DB 스키마/RLS/동의 검증
- [ ] 실측 기준 검증 + shadow 평가 + underprediction 안전 요구 정의
- [ ] 기능 플래그 기본 OFF, 배포 시 사용자 UUID allowlist, 양쪽 서버 인증된 HTTPS, 롤백
- [ ] 구형 C1/W4 모델 삭제/교체는 전환 검증 후에만

기존 C1/W4는 **새 타깃의 모델이 아니므로 최종적으로 교체**, 그러나 준비 구간이 아닌 기존 앱의 계산을 비활성화 없이 .cbm만 바꾸면 장애. **모델 교체는 코드·DB·알람 산식 전환과 하나의 롤아웃으로 수행할 것.**
