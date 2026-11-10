# C1/W4 CatBoost 준비시간 연결 (비활성화 기본값)

## 연결 경로
- 앱 H05/H03 → `alarm-suggest` / `alarm-commit` → 공통 `buildPlan()`
- `buildPlan()` → `prepare-ml.ts` (사이드카 /predict) → `computePlan()`
- C1 (연령 전용 실험 후보): 달력 3개 + **서버가 검증한 연령코드**.
- W4 (연령 전용 실험 후보): 위 항목에 **약속 날짜 바로 전날** `daily_records.actual_prepare_minutes` 추가.
- 최신 실험 MAE: C1 43.163분 (n=4,535), W4 29.417분 (n=1,689). 원본 조사자료 타깃의 성능이며 실제 앱 정확도가 아님.
- `models/v4_age_only/c1_mae.cbm`, `w4_mae.cbm`는 Mac 로컬에서 학습된 파일로 Git 저장소에 포함하지 않음.
- 20261110130000 DB 마이그레이션에서 선택형 응답은 만 나이만 필요. 학교/경제활동 값은 이전 데이터 호환성을 위해 남겨 두되 모델 추론에 사용하지 않음.
- 예측은 기상 포함 일정의 **자동 준비시간**에만 적용. 사용자가 직접 정한 시간 및 같은 날 이후 일정은 기존 규칙 유지.
- 네트워크 실패, 입력 부재, 스키마 부재는 기존 개인 P80 계산으로 자동 복귀.
- `prepare.source='MODEL'`과 `prepare.model='c1_mae'|'w4_mae'`은 실제 호출 성공 시에만 표시.

## 현재 상태 / 정확도 주의
이 PR은 **연결 구조를 구현**한 것이며, 모델 사용은 기본 비활성화입니다.
2024 생활시간조사 원본 타깃은 '마지막 수면 종료→첫 외출 이동'의 **프록시**입니다.
앱의 `actual_prepare_minutes`는 실제/예정 기상 시각→출발의 기록이므로
훈련 대상과 완전히 같지 않습니다. W4의 서비스 데이터 정확도는 별도 평가가 필요합니다.

코드북 부재로 휴일종류는 `__MISSING__`을 씁니다. 훈련 데이터에서
이 값이 약 31.94%였더라도 임의의 모든 날짜에 이를 쓸 때의 성능은 검증되지 않았습니다.
프로필 중 새 모델 입력은 `ml_age_code`만 사용합니다.
원본에서 관측된 연령코드(1:10대, 2:20대, ... 8:80세 이상)를
공식 코드표와 대조해 신뢰된 서버 워크플로에서 검증 후 저장하세요.
학교·경제활동 코드를 새 모델 입력에 넣지 마세요.
`ml_codes_verified`는 기본 `false`이고, UI/수집 단계는 포함하지 않습니다.
연령코드 결측은 학습 데이터에서 0%였으므로 임의 결측값 예측은 피해야 합니다.

## 배포 전 준비 (현 단계에서는 하지 않음)
1. 프로필 마이그레이션을 배포하고 기존 앱과의 호환성을 확인합니다.
2. 모델 프로필 수집에 대한 개인정보 동의와 코드북 매핑을 검증합니다.
3. C1/W4 FastAPI 서버를 Edge에서 접근 가능한 **HTTPS** 주소로 배포합니다.
   Mac의 `127.0.0.1:8091`은 클라우드 Edge에서 접근할 수 없습니다.
4. Edge Functions Secret으로 `PREPARE_ML_URL`, `PREPARE_ML_API_TOKEN`을 저장합니다.
   연결 준비와 검증이 끝난 후에만 `PREPARE_ML_ENABLED=1`로 전환합니다.
5. 예측값의 서비스 실제 오차, 적절한 안전 여유, 미리보기·저장의 일관성을 확인합니다.

## 테스트
```bash
node --experimental-strip-types --test supabase/functions/_shared/prepare-ml.test.ts
```

모델 호출이 없으면 알람 계산 경로는 변경 전과 같게 유지됩니다.

## 2026-11-10 연결 검증 결과 (운영 ML은 여전히 비활성화)

아래는 **가상 프로필** 및 가상 W4 전날 준비시간(60분)을 사용한 통합 테스트 결과로, 실제 서비스 정확도 시험이 아니다.

- Mac Docker C1/W4 /health: 두 모델 로딩 성공.
- Cloudflare 임시 HTTPS 터널 /predict: C1/W4 성공, 인증키 누락 요청 401.
- Supabase Edge → 임시 HTTPS → CatBoost 실제 통신: 테스트용 함수 HTTP 200, C1 66분 / W4 53분 (해당 테스트용 입력).
- 로그인한 허용 테스트 계정 전용 `alarm-suggest-ml-test` 미리보기: HTTP 200, `prepare.source=MODEL`, `saved=false`.
- 2026-11-17 10:00 KST 가상 약속(이동 30분, 여유 10분, 준비 전 활동 20분):
  - 기존 P80: 준비 60분, 기상 08:20 KST (비교 기준).
  - C1: 준비 66분, 기상 08:14 KST.
  - W4: 준비 58분, 기상 08:22 KST.
- 71개 Node 테스트 통과 및 앱 TypeScript 검사 통과(사용자 로컬 실행).

### 실사용 적용 전 보류 사항
1. **원본 2024 생활시간조사 코드북 및 학습 전처리 로직을 교차 확인**: `weekday_code`, `평토일구분코드`, `휴일종류코드`, `연령코드`, `교육재학코드`, `경제활동상태코드`의 값/결측/시점 정의.
2. 사용자에게 필요한 선택 입력과 개인정보 동의 흐름을 설계하고, 검증 없이 모델 범주 코드를 추정해서 저장하지 않음.
3. `ml_codes_verified`가 사용자가 직접 true로 변경할 수 없는 **서버측 검증 상태**가 되도록 권한을 점검하고, 별도 운영 ML 계정 허용 목록을 구현.
4. W4의 직전 로컬 날짜 `daily_records.actual_prepare_minutes`와 조사 학습 타깃('수면 종료→첫 외출 이동')의 차이 및 실제 서비스 오차 검증.
5. 자동 준비시간의 C1/W4 선택, 수동 입력 우선순위, 예측 실패 시 P80 복귀, 미리보기와 저장의 일관성 E2E 검증.
6. 일시적인 Cloudflare Quick Tunnel은 개발용으로만 사용. 지속적인 운영용 배포 및 키 관리 별도 설계.
7. `PREPARE_ML_ENABLED=0` 유지. 테스트 전용 함수는 사용하지 않을 때 `PREPARE_ML_TEST_ENABLED=0`으로 차단하고 종료 후 삭제.

## 2026-11-10 운영 사용 전 추가 안전장치 (작업 브랜치, 아직 미배포)

- `PREPARE_ML_ENABLED=1`만으로는 **어떤 사용자도 추론할 수 없다**. 서버 비밀값 `PREPARE_ML_ALLOWED_USER_IDS`에 정확히 허용된 UUID가 추가로 있어야 한다. 빈 목록 또는 잘못된 목록이면 전체 거부.
- 자동 준비시간·기상 포함 일정에서만 추론. `participant.prepare_minutes` 수동 지정은 우선하며 그날 두 번째 일정은 기존 규칙 유지.
- 사용자 프로필 3개는 클라이언트가 요청 본문으로 보내지 않는다. `buildPlan`이 서버 DB에서 가져오는 방식이다. 코드북 매핑과 별도 개인정보 동의가 확인되기 전에는 해당 프로필 필드 값을 임의로 넣거나 `ml_codes_verified=true`로 바꾸지 않는다.
- 현재 `ml_codes_verified` 컬럼은 **RLS 소유자 수정이 가능**하므로 신뢰된 검증 신호가 아니다. 운영에 적용하려면 인증된 서비스 측 저장·검증 방식, 컬럼 UPDATE 권한 차단 또는 보호 테이블을 추가해야 한다. **서버 사용자 허용 목록만으로 이 문제를 해결한 것으로 취급하지 않는다**.
- 직전 날짜의 `daily_records.actual_prepare_minutes`를 찾은 경우만 W4 후보이며 없거나 유효하지 않으면 C1 후보. 모델 API 실패/시간 초과/검증 실패 시 기존 P80 사용.
- 동일한 `computePlan`에 동일한 입력과 추론값을 주었을 때 preview/save 시각이 일치하는 순수 테스트 추가. **실제 저장 API E2E 또는 데이터베이스 영속화 일치성은 아직 검증하지 못했다**.
- 서버 코드의 새 안전장치는 브랜치에서 테스트한 뒤 별도로 배포해야 동작한다. 현재 운영 플래그는 0 유지.

## 검증된 사용자 입력 저장 경로 (미배포)

- DB 마이그레이션 `20261110100000_prepare_ml_verified_profiles.sql`에 `public.prepare_ml_verified_profiles` 신설. 일반 `authenticated`는 SELECT/INSERT/UPDATE/DELETE 권한 없음. `service_role`만 접근; 프로필 삭제 시 CASCADE.
- 코드북 확인 + 명시적 동의 후, **별도 신뢰된 서버 워크플로**에서만 연령/교육/경제활동 코드를 이 테이블에 저장. 현재 앱 UI와 검증된 코드 생성/저장 엔드포인트는 아직 구현하지 않음.
- 모델 예측 전 필수 조건: 전역 `PREPARE_ML_ENABLED=1`, 해당 유저가 `PREPARE_ML_ALLOWED_USER_IDS`에 포함, 서버 전용 검증행 존재, `consent_at`/ `verified_at` 유효, `codebook_version === PREPARE_ML_CODEBOOK_VERSION`. 하나라도 빠지면 기존 P80로 복귀.
- 종전 클라이언트 수정 가능 `profiles.ml_*` 및 `ml_codes_verified`는 **더 이상 모델 요청 경로에서 사용하지 않음**.
- 실제 앱 요청은 여전히 일정 초안만 제출. 날짜/시간대는 서버에서 달력 피처로, 모델 코드값은 서버 전용 테이블에서, W4 직전 날짜 기록은 `daily_records`에서 읽음.
- 아직 **미구현/미검증**: UI와 동의 문구, 원본 조사 코드 매핑, 서비스 유저 평가, 실제 `alarm-commit` 영속화 일치 검증. 운영에 배포하거나 전체 플래그를 켜지 말 것.

## 선택형 입력 화면 및 원시 응답 저장 (2026-11-10, 미배포)
- 마이그레이션 `20261110110000_prepare_ml_optional_survey.sql`: `profiles`에 만 나이(14–100), 현재 학교 상태, 현재 근무 상태, 별도 동의 시각 추가. 모든 필드는 선택 사항이고 기본 NULL이며, 저장 시에는 4개를 함께 보낸다.
- 모바일 설정 `준비시간 예측 연구정보 (선택)`에서 선택형 입력·명시적 opt-in·정보 삭제/동의 철회 가능. 비동의 시 기존 알람 사용. 읽기/수정 경로: `profile/api.ts` 및 새 `PrepareMlSurveyEditor.tsx`.
- 이 값은 **인간용 자가 응답**이며 생활시간조사 공식 `연령코드`/`교육재학코드`/`경제활동상태코드`가 아니다. 모바일의 입력값을 자동으로 검증된 모델 코드로 전환하지 않는다.
- 자가 응답/동의 수정 시 트리거가 기존 서버 전용 검증행을 삭제한다. 이후 다시 검증하는 별도 서버 작업이 있어야 모델이 이를 사용할 수 있다. 복잡한 동의·검증/코드 매핑 기능 및 UI 문구의 최종 개인정보 검토는 남은 작업.
- 배포 순서 **반드시**: DB 마이그레이션/접근 통제 확인 → 앱 배포. 데이터베이스 변경 전 앱을 배포하면 새 컬럼을 SELECT할 때 프로필 조회에 실패한다.
- 작업 브랜치의 UI와 DB 마이그레이션은 GitHub에 커밋만 했으며 실제 환경에 적용하지 않았다.
- QA: `cd mobile && npx tsc --noEmit`, `cd mobile && npx jest --runInBand src/features/profile/__tests__/prepareMlSurvey.test.ts`, Edge `node@24 --test` 회귀 테스트를 실행한다.

## 최종 검증 게이트 (2026-11-10, 운영 배포 전)
- PGlite `supabase/tests/npm test` 결과: 사용자가 503/503 통과 확인. 이것은 Supabase 호스팅 DB의 적용 여부가 아님.
- `supabase/functions/_shared/commit.test.ts`에 C1/W4/P80 미리보기 → `persistAppointment` → FakeDb 알람·참여정보 저장/재조회 대조 테스트 추가. 아직 실행 결과 미확인.
- PR #410은 `main`보다 새 커밋이 있으면 다시 병합·회귀 검사해야 함. 머지 전 CI/리뷰 및 migration ordering 확인.
- **여전히 불가**: 코드북/개인정보처리 문구 검증 없이 추론 플래그 활성화; 마이그레이션 전 새 앱 프로필 SELECT 배포; 본인 계정의 실제 알람을 테스트 도중 무단 생성/삭제.
- 실제 Supabase 통합 검증은 별도 테스트 환경 또는 명시적으로 허가된 시험 계정에서만: 선택형 응답 저장/재조회/철회, `alarm-suggest`와 `alarm-commit` 호출, 반환된 `appointment_id`/ `participant_id`를 기준으로 DB `alarms` 및 `appointment_participants`를 읽어 UTC 시각 비교. 테스트 후 명시적 정리.
