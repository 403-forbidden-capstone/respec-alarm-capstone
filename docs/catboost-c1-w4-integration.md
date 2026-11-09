# C1/W4 CatBoost 준비시간 연결 (비활성화 기본값)

## 연결 경로
- 앱 H05/H03 → `alarm-suggest` / `alarm-commit` → 공통 `buildPlan()`
- `buildPlan()` → `prepare-ml.ts` (사이드카 /predict) → `computePlan()`
- C1: 달력 3개 + 검증된 사용자 프로필 3개.
- W4: 위 항목에 **약속 날짜 바로 전날** `daily_records.actual_prepare_minutes` 추가.
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
프로필의 `ml_age_code`, `ml_education_code`, `ml_economic_code`는
원본 코드북으로 대응 관계를 확인한 뒤에만 저장하세요.
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
