# 순수 준비시간 웹·실데이터 테스트 (2026-11-20)

## 0. 목적과 안전 범위
PR #577의 테스트 전용 개발화면 `/dev/pure-prep`를 사용한다.

- **실데이터**: 본인 로그인 세션이 있는 경우 `profiles`, `appointment_participants`의 컬럼 존재 여부와 본인 프로필의 기존 준비시간만 **SELECT**로 조회한다.
- **순수 계산**: 서버 공통 `purePrepAlarmChain` 모듈로 메모리 안에서만 시각을 계산한다. 시나리오 입력은 **실제 계정 기록이 아니라 가상 수치**다.
- **절대로 수행하지 않는 작업**: `INSERT/UPDATE/DELETE`, `alarm-commit`, `alarm-roll`, 마이그레이션 적용, 타 사용자 조회, 실제 Android 예약.
- **실데이터 연결 ≠ 신규 기능 배포**. 현 운영 DB에는 신규 `default_outing_prep_minutes`와 참여자 메타데이터 컬럼이 없다. 신규 준비시간의 실제 저장·Edge 적용은 불가능하다. 관련 버튼을 누르지 않는다.
- `/dev/screens`의 **내 시험 데이터 지우기** 버튼은 쓰기·삭제 동작이므로 절대로 누르지 않는다. 실험용 계정이어도 친구/그룹 등 기존 데이터는 보존한다.

## 1. 웹 실행 환경
1. 통합 브랜치 `test/pure-prep-main-integration`에서 코드를 실행.
2. `mobile/.env`의 `EXPO_PUBLIC_SUPABASE_URL`과 `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`는 읽기 가능한 기존 프로젝트 값으로만 설정. `service_role` / `sb_secret_` 키를 넣지 않는다.
3. 프로젝트 루트에서:
   ```bash
   git switch test/pure-prep-main-integration
   git pull --ff-only
   cd mobile
   npm ci
   npm run web
   ```
4. 터미널에 표시된 웹 주소 뒤에 `/dev/pure-prep?mode=real`을 붙여 접속. 기본 포트가 8081이면 `http://localhost:8081/dev/pure-prep?mode=real`.
5. 실데이터 로그인 계정이 없다면 `/dev/screens?mode=real`에서 이메일 로그인. 기존에 제공된 **전용 데모 계정**만 쓰고 비밀번호는 화면에 입력한다. 데모 계정은 자동으로 생성되지 않는다. 테스트 비밀번호를 GitHub/공개 로그에 넣지 않는다.
6. 로그인 뒤 `/dev/pure-prep?mode=real`로 돌아와 **현재 계정 DB 스키마 확인**을 누른다.
7. 로그인했어도 URL에 `mode=mock`을 쓰면 실데이터가 아니라 가짜 데이터이므로, 모드 표시를 꼭 확인한다.

## 2. 확인할 시나리오

| ID | 종류 | 재현 방법 | 기대 결과 | 상태 |
| --- | --- | --- | --- | --- |
| W-01 | 환경 | 웹 `/dev/pure-prep?mode=real` 열기 | 실데이터 모드, 로그인 여부 명시 | 브라우저 수동 확인 필요 |
| W-02 | DB(읽기) | 전용 계정 로그인 → 스키마 확인 | 신규 컬럼 미적용이면 `마이그레이션 미적용` 경고. 기존 기상→출발 분은 읽음 | 현 운영 DB는 미적용 |
| W-03 | 계산 | 약속 10:00, 이동 30, 여유 10, 순수 준비 35, 기상 후 기본 여유 20, 준비 전 활동 0 | 기상 08:25 / 준비 08:45 / 출발 09:20 / 도착 목표 09:50 | 자동 Jest 검증 포함 |
| W-04 | 계산 | W-03에서 준비 전 활동 15분 | 기상 08:10 / 준비 08:45 유지 | 자동 Jest 검증 포함 |
| W-05 | 계산 | W-03에서 `기상 알람 포함` 끄기 | 기상 없음 / 준비 08:45 / 출발 09:20 | 자동 Jest 검증 포함 |
| W-06 | 단위 | 기존 프로필 기상→출발 60분, 시나리오 순수 준비 35분 | 서로 다른 의미이며 자동 복사/덮어쓰지 않음 | 데이터 읽기 + 계산 각각 확인 |
| W-07 | 범위 | 순수 준비시간 5~240분 사이, 음수 값 모듈 직접 테스트 | 정상 입력 계산, 음수는 RangeError | 자동 Jest 검증 포함 |
| W-08 | 통합 게이트 | 실 DB에서 새 스키마 없음 | 신규 순수 준비시간 쓰기·Edge 통합·실제 알람 예약은 실행하지 않음 | 현재 차단 |
| W-09 | 실기기 | Android Dev APK에서 실제 알람 예약·울림 확인 | 웹에서 확인 불가. Android 별도 E2E | 미실시 |
| W-10 | ML | 실제 CatBoost v2 호출 / 그림자 평가 | 이 화면에서 수행하지 않음. 연구 모델 검증 후 별도 | 미연결 |

## 3. 자동 검사
```bash
cd mobile
npm test -- --runInBand src/features/dev/__tests__/purePrepScenario.test.ts src/features/dev/__tests__/purePrepDiagnostics.test.ts src/features/profile/__tests__/api.test.ts
npm run typecheck
npm run lint
```

`purePrepDiagnostics.test.ts`는 DB 가짜 클라이언트에서 SELECT만 호출하는지 확인한다. **원격 DB E2E가 아니다**.

## 4. 기록 양식
- 실행 시각/KST:
- 브랜치/커밋:
- 브라우저 및 주소 (`/dev/pure-prep?mode=real`):
- 모드: real / mock
- 계정: 데모 계정의 별칭만 (이메일·ID·토큰 제외)
- W-02: migration-needed / ready / error
- W-03: 기상 / 준비 / 출발 / 도착 값
- W-04/W-05: 변경 결과
- 브라우저 콘솔: 민감한 네트워크 응답/토큰 제외한 오류 텍스트
- 기타: 기대값과 다르다면 해당 시나리오 ID + 화면 값만 기록

## 5. 다음 단계의 분리
이 환경에서는 **운영 DB에 신규 스키마를 적용하지 않는다**. 향후 별도 Supabase 테스트 프로젝트/로컬 Supabase에 마이그레이션 적용 → 서버 Edge 배포 → 전용 계정 실데이터 쓰기/조회 → Android 네이티브 확인 → 연구 CatBoost v2 shadow 평가의 순서를 지킨다.
