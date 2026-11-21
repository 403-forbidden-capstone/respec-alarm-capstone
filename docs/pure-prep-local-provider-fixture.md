# 로컬 Supabase로 H05 장소 검색 → 미리보기 → 저장 검증

## 배경

Cloud Supabase에 배포된 `place-search`, `alarm-suggest`, `alarm-commit`은 **서로 다른 프로젝트인 로컬 Auth 토큰을 사용할 수 없다**. Cloud Edge secrets (KAKAO_REST_API_KEY 등)는 로컬 CLI에 자동 복제되지 않는다. Connected Supabase 도구로 클라우드의 비밀값을 읽어 로컬로 복사하는 기능도 없다.

이번 검증은 **외부 Kakao 장소 검색·이동시간만 명시적 합성 fixture**로 대체한다. 로컬 실제 Auth 로그인, 기존 요청검증, 알람 계산(순수 준비시간 경로), RLS, 로컬 DB 저장은 **실제 코드**를 실행한다.

## 실행

1. 기존 `npm run web` / 기존 로컬 Edge serve 프로세스가 있다면 **Ctrl+C**로 중지
2. 로컬 Supabase `npx supabase start`가 실행 중이어야 함
3. 프로젝트 루트에서:

```bash
git switch test/pure-prep-main-integration
git pull --ff-only
node scripts/start-local-pure-prep-services.mjs
```

이 스크립트는:
- **127.0.0.1:54321** 로컬 API만 허용
- 로컬 Auth에서 기존 `local-pure-prep-<8 hex>@example.com` 계정 UUID만 찾아 pure-prep 플래그 허용목록 생성
- 시스템 임시 폴더에 가상 장소/30분 이동값 + 순수 준비시간 적용 ON 플래그만 저장 (실제 비밀키 사용 안 함)
- `npx supabase functions serve --env-file <임시환경설정>`으로 실제 로컬 Edge Functions 구동
- `npm run web`을 **동일 로컬 API로 강제**하여 시작
- 기존 로컬 테스트 계정을 재생성하거나 DB를 초기화하지 않음

## 로컬 전용 합성 데이터

| 항목 | 내용 |
|---|---|
| 장소 1 | 건대입구역 **(로컬 테스트)** |
| 장소 2 | 세종대학교 **(로컬 테스트)** |
| 이동시간 | **30분 (합성값, MANUAL)** |
| 순수 준비시간 | 기존 로컬 계정 `profiles.default_outing_prep_minutes` 사용, 특정 계정에만 ON |
| ML | PREPARE_ML_ENABLED=0, PURE_PREP_HISTORY_ENABLED=0 |
| Cloud | 아무 것도 변경하지 않음 |

로컬 Edge URL이 아니라 Cloud `https://<ref>.supabase.co`이면 fixture는 활성화되지 않도록 `localPurePrepFixtureEnabled()`에서 검사함. 외부 Kakao API **정합성을 검증하는 테스트는 아님**. 기존 카카오 지도 JavaScript SDK가 웹에서 보이지 않을 수 있지만, 장소 검색 결과 항목은 눌러 위치로 지정할 수 있음.

## 사용 시나리오

1. 웹 `/dev/screens?mode=real`에서 기존 `local-pure-prep-...` 계정 로그인
2. `H05 새 일정 만들기`: 내일 이후 날짜 10:00, 제목 `[LOCAL-E2E] 새 약속`, 도착 장소에 `건대입구` 검색
3. `건대입구역 (로컬 테스트)`를 눌러 선택하고 시트 아래 `이 위치로 정하기`로 확정
4. 미리보기에서 이동 30분(합성), 순수 준비시간을 이용한 준비/출발 시각을 확인. 앱 UI가 값을 수정했거나 그날 다른 기상 알람이 있으면 시각은 달라질 수 있음.
5. 서버 오류 없이 확인 시트가 생성되고, 미리보기와 DB 저장 결과가 일치할 때에만 저장 성공으로 판정
6. 새 일정이 보이면 로컬 Studio `http://127.0.0.1:54323`에서 `appointments`, `appointment_participants`, `alarms` 확인
7. `appointment_participants.outing_prep_minutes` 및 `outing_prep_source`가 프로필 값과 일치하는지 확인

**주의:** 시뮬레이션된 장소와 이동 시간으로 만든 약속이므로 외출용 실제 알람처럼 사용하면 안 됨. 로컬이지만 기기 네이티브 알람 울림은 별도 Android E2E가 필요함.

## 성공/실패 판정의 층

- ✅ 로컬 UI → 실제 Edge Functions → Supabase RLS/DB: 테스트 대상
- ✅ 순수 준비시간 게이트를 로컬 테스트 계정에서만 적용
- ❌ 카카오 REST/모빌리티 실제 응답 품질 검증 대상 아님
- ❌ Cloud Edge 버전, 클라우드 DB, 팀원 실제 데이터 변경 없음
- ❌ Android 울림/백그라운드 예약 검증 대상 아님

## 문제 해결

- 로그인 화면에 기존 `demo-me@example.com`이 보이면 직접 로컬 계정으로 변경
- 테스트 검색이 `NOT_CONFIGURED`라면 이전 `npm run web`/ `supabase functions serve`가 아닌 새 스크립트로 띄운 서버인지 확인
- `localhost:8081` 대신 8082가 뜨면 이전 웹을 종료하고 새 스크립트를 다시 실행
- Edge CLI가 오류로 종료하면 그 오류 로그를 공유하되 비밀번호/API 키는 제외
