# Re:Spec Alarm 앱

Expo SDK 57 · Expo Router · TypeScript

## 실행

```bash
cd mobile
npm install
npm run web
```

### 순수 준비시간 웹 실데이터 안전 점검 (PR #577)

`npm run web`으로 웹을 실행하고, 터미널의 웹 주소 뒤에 `/dev/pure-prep?mode=real`을 붙여 엽니다.
`mobile/.env`의 공개 Supabase URL·publishable key가 있어야 합니다. 로그인은 `/dev/screens?mode=real`의 기존 데모 이메일 로그인으로 진행합니다.
- **실제 데이터**: 로그인한 내 프로필 신규 컬럼 존재 여부와 향후 알람 최대 5건만 읽기(`SELECT`).
- **시뮬레이션**: 약속 10:00, 순수 준비 35, 이동 30, 여유 10, 기상 선행 20분 → 08:25 기상·08:45 준비·09:20 출발·09:50 도착 목표. 실제 DB에 저장하지 않음.
- 운영 DB의 새 순수 준비시간 마이그레이션이 없으면 **마이그레이션 미적용**으로 표시됨. 테스트 화면에서 운영 DB나 실제 폰 알람에 아무 쓰기도 하지 않음.
- 자세한 체크리스트: `docs/pure-prep-web-realdata-test-20261120.md`. Android 실기기 알람·CatBoost v2 실제 호출 검증과 별개.

브라우저에서 화면을 바로 볼 수 있습니다. PC에서는 왼쪽 패널에서 고른 기종(기본 Galaxy S24) 크기의 휴대폰 틀로 보입니다. 패널 위에서부터 데이터 모드(가짜 · 실데이터, 로그인 · 로그아웃) · 화면 목록(번호 · 이름으로 거르기, 알람 · 친구 · 그룹 등 기능별 절 접기 · 펼치기, 실데이터에서는 내 첫 친구 · 그룹 · 다음 알람으로 열림)이 있고, 시나리오 시각 · 개발 도구(알람 테스트 · 부품 모음 · 개발 메뉴) · 기종 · 세션은 맨 아래 '도구'(기본 접힘)에 있습니다. `?device=s24`로 기종을 지정합니다. 창이 기종 폭 + 100보다 좁으면(실기기 · 개발자 도구 에뮬레이션) 틀 없이 앱만 보입니다.
폰에서 보려면 개발용 APK가 필요합니다. Expo Go로는 실행되지 않습니다.

패키지는 `npx expo install <이름>`으로 추가합니다. SDK 57에 맞는 버전이 들어갑니다.

### push 전 검사

PR에서 앱 검사가 자동으로 돌지 않아서(Actions 분량, #134) push할 때 로컬에서 같은 검사를 돌립니다(#198, 레포 맨 위 `lefthook.yml`).

- `mobile/`에서 `npm ci`(또는 `npm install`)를 하면 git 훅이 자동으로 깔립니다. 따로 할 일 없음
- `mobile/` 안 파일이 들어간 push마다 `npm run typecheck` · `npm run lint` · `npm test`(전체)를 동시에 돌리고, 하나라도 실패하면 push가 막힙니다. 문서만 바꾼 push는 건너뜁니다. 단, 새 브랜치의 첫 push는 비교할 원격 브랜치가 없어 바뀐 파일과 상관없이 다 돌 수 있습니다
- 훅이 안 깔린 곳(`npm ci` 전, `CI=true`인 환경)에서는 PR 전에 세 명령을 직접 돌립니다
- 급할 때 건너뛰기: `git push --no-verify`. 건너뛴 PR은 Actions → 앱 검사 → Run workflow로 서버에서 한 번 돌립니다
- 커버리지: `npm run test:cov` → 폴더별 줄 · 함수 · 갈래 비율 표 (앱 검사 실행 요약에도 붙음)

## 폴더

| 폴더 | 내용 |
|---|---|
| `src/app/` | 화면. 파일 위치가 곧 주소 (Expo Router) |
| `src/app/(tabs)/` | 탭 4개: 01 홈 · 02 알람 · 03 그룹 · 04 AI (D110 — 목업의 04 기록은 홈 맨 아래로) |
| `src/features/alarm/` | ① 약속 기반 알람 |
| `src/features/social/` | ② 알람 공유 · 기상 확인 |
| `src/features/voice/` | ③ 수면 전후 음성 AI |
| `src/features/records/` | ④ 일정 · 하루 기록 |
| `src/features/routine/` | ⑥ AI 일기 · 루틴 |
| `src/components/ui/` | 여러 화면에서 같이 쓰는 UI (글자 · 카드 · 버튼 · 칩 · 스위치 · 탭 막대 등). 견본은 `/dev/ui` |
| `src/lib/` | Supabase 클라이언트 · 서버 함수 호출(`edge`) · 폰 예약 맞추기(`alarmSync`) · 실시간(`realtime`) 같은 공용 코드 |
| `src/mocks/` | 목업용 가짜 데이터 |
| `src/theme/` | 색 · 간격 · 글자 크기 (목업 `mockup.html`의 :root 값). 글꼴은 Pretendard(`assets/fonts`) |

기능 폴더 안에는 `api.ts`(데이터) · `types.ts` · `components/` · `hooks/`가 있습니다.
`api.ts`는 목업 데이터를 돌려주고, 실데이터는 옆 파일 `real.ts`(쿼리) · `map.ts`(DB 행 → 화면 타입)에 있습니다. 함수 맨 앞의 `if (!isMock()) return real.함수()`가 둘을 나눕니다 (`docs/screen-data-map.md` "실데이터 연결 규칙").

## 배포

| 무엇 | 어디 | 주소 |
|---|---|---|
| 웹 미리보기 | Cloudflare Workers | main: [respec-alarm-capstone.vmgfh878.workers.dev](https://respec-alarm-capstone.vmgfh878.workers.dev) · PR: Cloudflare 봇 댓글의 미리보기 주소 |
| 클릭 목업 | 같은 사이트 | `/mockup.html` |
| 최신 데모 APK | GitHub Releases | [releases/latest](https://github.com/403-forbidden-capstone/respec-alarm-capstone/releases/latest) (QR은 누구나, 파일은 레포 멤버) |
| 테스트 APK | EAS Build | Actions 실행 요약의 QR → 빌드 페이지 Install 버튼. Expo 조직 멤버는 expo.dev 빌드 목록 |

### 웹

- main에 머지되면 고정 주소가 바뀜. PR을 열면 브랜치마다 미리보기 주소가 생김
- PR 아래 검사 목록의 Workers Builds → Details를 누르면 미리보기로 감
- Cloudflare Worker `respec-alarm-capstone`의 빌드 설정: Root directory는 비우고 레포 맨 위에서 돔. main은 빌드 `cd mobile && npm ci && npm run build:web` · 배포 `npx wrangler deploy -c mobile/wrangler.jsonc`. Node 버전은 맨 위 `.nvmrc`(`mobile/.nvmrc`와 같게). 출력 폴더(`dist`)와 없는 주소 처리는 `wrangler.jsonc`
- PR 브랜치 빌드는 Cloudflare의 옛 규칙이 대시보드 수정을 안 따르고 맨 위에서 `npm run build:web` → `npx wrangler preview`로 돎. 그래서 레포 맨 위 `package.json`(mobile로 들어가는 build:web)과 `wrangler.jsonc`(결과 = `mobile/dist`)가 있음
- `public/` 안의 파일은 그대로 사이트에 실림(`public/mockup.html` → `/mockup.html`). `_headers`로 검색 엔진 색인을 막음
- 폰 전용 기능(알람 모듈 · 소리 · 알림)은 웹에서 부르면 깨짐. `Platform.OS === 'web'`이면 건너뛰게 씀

### 앱

APK 세 종류. 모두 Expo Go로는 안 되고 EAS 빌드 페이지에서 받음.

| 프로필 | 쓰임 | 폰에 보이는 이름 · 버전 | 언제 다시 빌드 |
|---|---|---|---|
| `development` | 개발용. 설치해 두고 `npx expo start`에 붙여 JS 수정을 바로 봄 | Re:Spec Alarm 개발 · 0.1.0 | 네이티브 모듈 · 플러그인 · 네이티브 패키지 · `app.json`이 바뀔 때 |
| `preview` | 개발자용 배포(팀 테스트 · 데모 릴리스). 설치하면 그대로 씀. 로그인 화면에 데모 계정 로그인 | Re:Spec Alarm 개발 · 0.1.0 | 위와 같음. JS만 바뀐 건 빌드 없이 `eas update`로 보냄 |
| `production` | 실배포 APK (v1). 데모 로그인 없음 | Re:Spec Alarm · 1.0.0 | 실배포할 때만 |

- 개발자용 · 실배포는 빌드 변수 `EXPO_PUBLIC_APP_VARIANT`(`eas.json` 프로필의 `env`)로 갈림. `release`만 실배포이고 비었거나 다른 값은 개발자용 (`app.config.js` · `src/lib/modePolicy.ts`)
- 개발자용 APK의 [데모 계정으로 로그인]은 EAS 환경 변수(preview) `EXPO_PUBLIC_DEMO_PASSWORD`(= 시드 `SEED_PASSWORD`)가 있으면 한 번에 `demo-me`로 들어감. 없으면 개발 메뉴의 입력 칸으로 감. 실배포(production) 환경에는 넣지 않음

빌드 시작은 둘 중 하나
- GitHub: Actions → APK 빌드 → Run workflow → 프로필 선택
- 터미널: `npx eas-cli build -p android --profile development` (Expo 로그인 필요)

JS만 바뀐 걸 설치된 preview 앱에 보내기

```bash
npx eas-cli update --channel preview --environment preview --message "무엇을 고쳤는지"
```

- `--environment preview`: EAS 환경 변수(`KAKAO_NATIVE_APP_KEY` 등)를 읽어 APK와 같은 설정으로 업데이트를 만듦. 빼면 키가 든 APK와 runtimeVersion(fingerprint)이 달라 업데이트가 안 닿음

- EAS 무료 플랜은 한 달 Android 빌드 15회. 네이티브가 안 바뀌면 빌드하지 않음
- 데모 릴리스는 `v0.1.0`처럼 태그를 달면 release.yml이 preview APK를 빌드해 Releases에 QR과 함께 붙임. 레포 멤버 누구나 GitHub → Actions → 데모 릴리즈 → Run workflow에 다음 태그를 넣어도 됨(Expo 로그인 필요 없음)
- 처음 한 번은 Expo 조직 Owner가 터미널에서 `development` 빌드를 직접 돌려 키스토어를 만듦(이후 빌드는 버튼으로 됨)
- 설정값: `eas.json`(프로필 · 채널 · 환경), `app.json`(`runtimeVersion` fingerprint · `owner` · `projectId` · `updates.url`), Secret `EXPO_TOKEN`(Expo 조직 로봇 토큰)
- Expo 프로젝트: [@respec-alarm-capstone/respec-alarm](https://expo.dev/accounts/respec-alarm-capstone/projects/respec-alarm). 빌드 프로필마다 같은 이름의 EAS 환경(development · preview · production) 변수를 씀

### 환경 변수

```bash
cp .env.example .env
```

- 값을 받는 곳과 넣는 곳은 루트 README의 "관리자 설정 · 비밀값" 표에 있음. `.env`는 커밋되지 않음
- 안드로이드 푸시(FCM)용 `google-services.json`은 키 파일이라 커밋하지 않음(`.gitignore`). `app.config.js`가 파일이 있을 때만 `android.googleServicesFile`에 넣고, 없으면 그대로 빌드됨
  - 로컬 빌드(`npx expo run:android`): 받은 파일을 `mobile/google-services.json`에 둠
  - EAS 빌드: 파일 종류 환경 변수 `GOOGLE_SERVICES_JSON`으로 올림 — `eas env:create --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --environment preview` (development · production도 같은 방식). 이 파일을 넣거나 바꾸면 네이티브 설정이 바뀌어 `runtimeVersion` fingerprint가 달라지므로 새 빌드가 필요함
  - `eas build`를 거는 PC에도 같은 파일을 `mobile/google-services.json`에 둬야 함(EAS 변수와 같은 파일). 빌드 서버는 `GOOGLE_SERVICES_JSON` 파일이 fingerprint에 들어가는데, 이 PC에 파일이 없으면 지문이 달라 `Runtime version mismatch`로 실패함
  - GitHub 버튼 빌드(release.yml · eas-build.yml)는 Secret `GOOGLE_SERVICES_JSON_B64`(같은 파일을 base64로 바꾼 값)를 빌드 직전에 `mobile/google-services.json`으로 꺼냄. 파일을 바꾸면 EAS 변수와 이 Secret을 같이 바꿈 — `base64 -w0 google-services.json | gh secret set GOOGLE_SERVICES_JSON_B64`
  - `mobile/.gitignore`(expo가 만든 블록 + `/android` `/ios`)는 레포에 올려 둠. 로컬과 EAS 서버에 이 파일이 같이 있어야 fingerprint가 같음(없으면 한쪽만 `bareGitIgnore`로 세어짐). `app.config.js` · `runtimeVersion` 정책은 그대로
- `EXPO_PUBLIC_` 값은 빌드할 때 번들에 박힘. 로컬은 `.env`, 웹 미리보기는 Cloudflare 변수, APK는 EAS 환경 변수에 같은 값을 넣음
- 카카오 SDK 로그인 키 `KAKAO_NATIVE_APP_KEY`(로그인용 카카오 앱의 네이티브 앱 키, `EXPO_PUBLIC_` 아님): 있으면 폰에서 카카오톡 앱으로 바로 로그인, 없으면 브라우저 로그인 (`app.config.js` · `src/lib/kakaoSdk.ts`)
  - EAS 환경 변수 development · preview · production에 Plain text로 넣음 (Secret이면 `eas build` · `eas update`를 거는 PC가 못 읽어 fingerprint가 갈림)
  - 개발용 APK에서 시험하려면 `npx expo start`를 띄우는 PC의 `.env`에도 넣음
  - 키를 넣거나 바꾸면 네이티브 설정이 바뀌어 새 빌드가 필요함. 카카오 디벨로퍼스의 Android 키 해시는 로컬 빌드(RN 기본 debug.keystore)와 EAS 키스토어 둘 다 등록

### 데이터 모드 · 개발 메뉴 로그인

- 폰 출시용 빌드(`__DEV__` false)는 실데이터만 쓰고 로그인이 필수입니다. Supabase 값이 없으면 "앱 설정이 빠져 있어요" 화면이 뜹니다. 웹 · 폰 개발용은 가짜 데이터로 바꿀 수 있고, 웹은 기본이 가짜 데이터이며 주소 `?mode=real`이면 실데이터입니다 (규칙 표: `src/lib/modePolicy.ts`)
- 시드 계정으로 실데이터를 시험하려면 로그인 화면의 [데모 계정으로 로그인](웹 · 폰 개발용 · 개발자용 APK)을 누릅니다. 빌드에 `EXPO_PUBLIC_DEMO_PASSWORD`가 있으면 바로 `demo-me@example.com`으로 들어가고, 없거나 다른 데모 계정이면 `/dev/screens`의 "개발용 이메일 로그인"에 시드 비밀번호(`SEED_PASSWORD`)를 넣습니다. 비밀번호는 코드에 없습니다. 로그아웃은 폰에 걸린 알람 · 쌓인 기록까지 정리합니다
- 서버 함수와 앱이 같이 쓰는 계산 파일(`supabase/functions/_shared/`)은 경로 별칭 `@shared/*`로 가져옵니다 (`tsconfig.json` paths · `metro.config.js` watchFolders)
