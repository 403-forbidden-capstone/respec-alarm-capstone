# Re:Spec Alarm — Claude 공통 안내

팀원 4명이 모두 Claude를 씁니다. 이 파일은 모두의 Claude가 같이 읽는 공통 규칙입니다.

## 프로젝트

- 포텐셜랩스 Re:Spec 음성 알람 앱에 대학생용 기능을 더하는 산학 캡스톤입니다. 기능 번호는 ①~④, ⑥ (README의 마일스톤 참고)
- Android 전용입니다. iOS는 범위 밖입니다.
- 앱: Expo SDK 57 · React Native · Expo Router · TypeScript
- 알람: 자체 Kotlin 네이티브 모듈 (AlarmManager)
- 서버 · AI: Supabase(Auth · Postgres · Edge Functions), Gemini API, 카카오 길찾기 API
- 폴더 구조는 역할 분담 뒤에 정해서 이 파일에 추가합니다.

## Expo

- Expo는 버전마다 API가 많이 바뀝니다. 코드를 쓰기 전에 v57 문서를 확인합니다: https://docs.expo.dev/versions/v57.0.0/
- 패키지는 `npx expo install <패키지>`로 추가합니다. SDK에 맞는 버전이 들어갑니다.
- Expo Go로는 실행되지 않고 개발용 APK가 필요합니다. 네이티브 모듈 · 플러그인 · `app.json` · 네이티브 패키지를 바꾸면 팀원 모두 APK를 다시 받아야 하므로 PR 설명에 적습니다.

## 화면

- 동작 · 흐름은 클릭 목업(`mobile/public/mockup.html`, 화면 번호 H01 · G01 등), 모양은 피그마를 기준으로 합니다.
- 색 · 간격 · 글자 크기는 `mobile/src/theme`, 공용 부품은 `mobile/src/components/ui`에서 가져옵니다. 화면 파일에 색 값 · 글꼴을 직접 적지 않습니다. 글자는 `Text`로 씁니다.
- 부품 견본은 `/dev/ui`(앱은 `respecalarm://dev/ui`)에서 봅니다.
- 화면은 데이터를 `mobile/src/features/*/api.ts`로만 읽습니다. 지금은 `mobile/src/mocks`의 가짜 데이터를 돌려주고, 실데이터가 붙으면 api.ts만 바꿉니다. 옮긴 목업 화면은 `/dev/screens`에서 번호로 엽니다.
- 부품(`components/ui`, `features/*/components/`)은 api.ts를 부르지 않고 값 · 콜백만 받습니다. 저장은 화면이나 `features/*/hooks/`가 합니다. 개발 패널(`components/dev`)은 예외입니다.
- 화면 · `features/` 코드는 `supabase.auth`를 직접 부르지 않습니다. 로그인 · 세션 구독은 `lib/auth`, 지금 사용자 id는 `lib/user`를 씁니다. `lib/`의 낮은 층(`user` · `realtime` · `supabase`)은 가볍게 쓰려고 `supabase.auth`를 직접 부릅니다(`lib/auth`는 불러올 때 expo-linking을 씀).
- 시각 · 날짜 글자는 `mobile/src/lib/format`(오전 7:55 · 5월 22일 목요일), 지금 시각은 `lib/clock`의 `now()`를 씁니다.
- 쓰기 버튼은 `lib/useAction`(두 번 누름 막기 · 실패 토스트), 못 읽으면 `components/ui`의 `LoadError`, "← 이전"은 `lib/nav`의 `backOrHome`을 씁니다. 사용자에게 보여 줄 실패 이유는 api.ts가 `lib/errors`의 `UserError`로 던지고, 그 밖의 오류(DB · 네트워크 원문)는 화면이 기본 문구로 바꿔 보여 줍니다.
- 피그마 화면은 `docs/design/figma/`의 PNG(목업 번호 대응표 포함)를 먼저 봅니다. 피그마 MCP는 한 달 호출 수가 적어서(View 자리 20회) PNG에 없는 걸 꼭 봐야 할 때만 씁니다.

## Git 흐름

- 이슈 → 브랜치 → PR → 리뷰 → Squash 머지 (자세한 규칙은 README)
- 브랜치 `{유형}/{이슈번호}-{파트}-{설명}`, PR 제목 `[파트] [유형] 작업 내용`, 본문 `Closes #이슈번호`
- PR 본문은 `.github/pull_request_template.md` 틀대로 씁니다. `gh pr create --body`로 만들 때도 틀을 읽어서 채웁니다.
- main에 직접 push하지 않습니다. 커밋 · push · PR · 이슈 생성은 작업자에게 확인받고 합니다.

## 4명이 같이 쓸 때

- **한 폴더에 Claude 세션 하나.** 동시에 두 작업을 하면 작업 폴더를 나눕니다: `git worktree add ../respec-<이슈번호> -b <브랜치>`
- 커밋은 파일을 지정해서 합니다. `git add .` · `git add -A`는 다른 작업 파일까지 섞여 들어가므로 쓰지 않습니다. 커밋 전에 `git status`로 확인합니다.
- 이슈 범위 밖 파일은 고치지 않습니다. 꼭 고쳐야 하면 먼저 작업자에게 알리고 PR에 이유를 적습니다.
- 여럿이 같이 고치는 파일(`package.json`, 잠금 파일, `app.json`, DB 마이그레이션)은 작은 PR로 따로 올립니다. 잠금 파일 충돌은 손으로 고치지 말고 `npm install`로 다시 만듭니다.
- 작업 시작 전에 main을 받아 오고(`git pull`), PR 전에는 main을 반영합니다(`git pull origin main` 또는 `git rebase origin/main`). rebase했으면 `--force-with-lease`로만 push합니다.
- 앱 검사 · 안드로이드 빌드 검사는 PR에서 자동으로 돌지 않습니다(Actions 분량). 대신 `mobile/`이 바뀐 push마다 push 전 훅(`lefthook.yml`)이 `npm run typecheck` · `npm run lint` · `npm test`를 돌리고 실패하면 막습니다. 막히면 고쳐서 다시 push하고, `--no-verify`는 작업자가 하라고 할 때만 씁니다. 훅이 안 깔린 곳(`mobile/`에서 `npm ci`를 하기 전, `CI=true`인 환경)에서는 PR 전에 세 명령을 직접 돌립니다. 네이티브(`app.json` · `package.json`의 네이티브 패키지 · `modules/` · `plugins/`)를 바꿨으면 Actions → 안드로이드 빌드 검사 → Run workflow로 그 브랜치를 한 번 돌리고, 성공한 실행 링크를 PR 본문 "검증" 칸에 적습니다.
- Claude의 기억은 사람마다 따로라 서로 공유되지 않습니다. 팀이 알아야 할 결정은 이 파일이나 문서에 PR로 남깁니다.

## 비밀값

- `.env`는 커밋하지 않습니다.
- `EXPO_PUBLIC_`로 시작하는 값은 앱에 그대로 들어가 공개되므로 비밀값을 넣지 않습니다.
- 외부 API 키와 Supabase `service_role` 키는 서버(Edge Functions) 비밀값으로만 씁니다.

## 리뷰

- PR을 열면 Claude가 자동으로 한 번 검수합니다: `pr-review` 스킬 + `.claude/review-checklist.md`
- 로컬 리뷰 대상(`claude-review.yml` · `claude.yml` · `flow-check.yml` 세 파일의 `fromJSON` 목록, 지금 지형 `vmgfh878-art`)이 연 PR · 이슈에서는 Actions 리뷰 · `@claude` · "흐름 확인" 검사가 돌지 않습니다. 그 사람의 로컬 Claude가 `local-review` 스킬로 같은 기준으로 검수하고, 걸러 낸 결과 댓글 하나만 남깁니다. 지형 PR은 그 뒤 머지 판단대로 처리합니다(10/17 지형 결정, 위 커밋 · push 확인 규칙의 예외): 수정 후 머지면 "고칠 것"을 고쳐 push, 흐름 확인 후 머지면 지형이 볼 때까지 둠, 머지 가능이면 squash 머지. 기능 흐름 PR이면 라벨 · 확인 줄까지 로컬에서 붙입니다. 이런 PR에 `@claude 다시 리뷰해줘`를 달지 않습니다.
- 로컬에서 같은 기준으로 보려면 "pr-review로 이 브랜치 검수해줘"라고 합니다.
- 기능 흐름 PR(앱 안에서 기능이 흘러가는 길을 만들거나 바꾸는 PR, 기준은 체크리스트)은 PR 본문의 "기능 흐름 · 판단 근거" 칸을 채웁니다. 문서에서 가져온 값 · 규칙에는 문서 경로 · 절을 달고, 근거가 없으면 "근거 없음 — 작성자 판단"이라고 적습니다. 이런 PR은 작업자가 흐름을 직접 확인한 뒤 머지합니다.
- 리뷰가 기능 흐름 PR로 판단하면 `흐름 확인 필요` 라벨과 "흐름 확인" 검사(대기)가 붙습니다(로컬 리뷰 대상은 라벨 · 확인 줄만). PR 본문의 "흐름 · 판단 근거를 작업자가 직접 확인했어요" 줄은 작업자만 체크합니다. Claude는 이 줄을 체크하지 않고, "흐름 확인" 대기는 고칠 CI가 아닙니다.

## 말투

- 사용자에게 보이는 문구, 코드 주석, 커밋, PR은 한국어로 씁니다.
