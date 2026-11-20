# 순수 준비시간 로컬 DB 저장 테스트 (기존 운영 DB 무변경)

## 한 번에 실행

Mac 터미널에서 프로젝트 루트로 이동한 뒤 **로컬 Supabase를 켠 상태**에서 실행한다.

```bash
git switch test/pure-prep-main-integration
git pull --ff-only
node scripts/run-local-pure-prep-e2e.mjs
```

이 스크립트는 `npx supabase status -o env`에서 **로컬** URL과 키만 읽으며, **127.0.0.1/localhost + HTTP + 54321 포트만 허용**한다. Supabase Cloud로 접속하는 옵션이 없다. 기존 `mobile/.env`에 클라우드 URL이 적혀 있어도 Expo 자식 프로세스의 `EXPO_PUBLIC_SUPABASE_URL` 값을 로컬 URL로 덮어쓴다. 서버 관리자 키는 Expo 웹 앱에 전달하지 않는다.

### 자동 검사

1. 현재 로컬 프로젝트에 신규 순수 준비시간 컬럼이 실제 존재하는지 조회
2. `local-pure-prep-<랜덤>@example.com` 테스트 계정 생성·이메일 인증 완료 상태로 준비
3. 로컬 Auth 로그인 후 자신의 프로필을 **RLS 역할로 조회**
4. 새 프로필 순수 준비시간 **35분** 저장 → 별도 요청으로 다시 읽기 → **기존 기상→출발 시간은 그대로인지** 확인
5. 허용 범위를 벗어난 **241분**의 저장을 DB가 거절하는지 확인
6. 테스트 목적지 개인 약속 및 참여자, 기상/준비/출발 알람 3건을 **로컬 DB에 서버 역할로 시드**. 그다음 **실제 로그인한 계정으로 재조회**해 값과 3개 알람 시각 확인
7. 로컬 웹을 실행, 계정/비밀번호는 **로컬 터미널에만** 표시

실제 프로필·알람 테이블에 쓰기 때문에 테스트 계정은 로컬에서만 사용한다. **실제 alarm-commit Edge 호출, 일정 수정/반복, 네이티브 Android 알람, 모델 추론을 검증하는 것은 아님.**

### 웹에서 확인
- `http://localhost:8081/dev/screens?mode=real` 방문 → 터미널에 표시된 로컬 계정/비밀번호로 로그인
- `http://localhost:8081/dev/pure-prep?mode=real` 방문 → `현재 계정 DB 스키마 확인`: ready, 순수 준비시간 **35분**
- `실제 저장된 알람 읽기`: 기상·준비·출발 3건
- 로컬 Studio `http://127.0.0.1:54323`에서 `profiles`, `appointments`, `appointment_participants`, `alarms` 조회. 새 계정 UUID 필터링.

> 본 프로젝트의 기존 웹앱은 `mobile/.env`에 저장된 클라우드 주소를 사용할 수 있다. 이 스크립트로 시작한 웹 서버에서만 테스트하라. 다른 창의 기존 Expo 서버 또는 배포 웹이 클라우드에 연결됐을 수 있다.

### 실패 시
- `supabase status` 명령이 없거나 Docker가 꺼져 있으면 `npx supabase start` 후 재실행.
- API 포트 54321이 아니면 스크립트가 안전하게 중단함.
- SQL 컬럼 미적용이면 **Git 통합 브랜치** 및 로컬 마이그레이션을 확인해야 한다. 운영 DB에는 적용하지 않는다.
- 8081 포트가 이미 사용 중이면 기존 Expo 서버를 종료하고 다시 실행.
- 스크립트는 실행할 때마다 새로운 로컬 계정을 만든다. 수동으로 기존 테스트 계정을 삭제하거나 운영 DB를 초기화할 필요 없음.

## 학습 포인트
- **프로필 저장**과 **알람 계산**은 다른 검증 층: UI 계산 성공이 DB 저장 성공은 아님.
- **service role 시드**와 **로그인된 사용자의 RLS SELECT**를 구분: 서버가 만들 수 있는 행이 실제 사용자에게 보이는지 검증해야 함.
- `default_prepare_minutes`(기상→출발)과 `default_outing_prep_minutes`(준비 시작→출발)는 별도 값으로 보존되어야 함.
