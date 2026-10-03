# Re:Spec Alarm — Claude 공통 안내

팀원 4명이 모두 Claude를 씁니다. 이 파일은 모두의 Claude가 같이 읽는 공통 규칙입니다.

- 내 역할과 지금 하는 일: 각자의 `CLAUDE.local.md` (레포에 안 올라감, 본인 카드를 불러옴)
- 누가 무엇을 맡았는지: `.claude/team/<이름>.md`

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

## Git 흐름

- 이슈 → 브랜치 → PR → 리뷰 → Squash 머지 (자세한 규칙은 README)
- 브랜치 `{유형}/{이슈번호}-{파트}-{설명}`, PR 제목 `[파트] [유형] 작업 내용`, 본문 `Closes #이슈번호`
- PR 본문은 `.github/pull_request_template.md` 틀대로 씁니다. `gh pr create --body`로 만들 때도 틀을 읽어서 채웁니다.
- main에 직접 push하지 않습니다. 커밋 · push · PR · 이슈 생성은 작업자에게 확인받고 합니다.

## 4명이 같이 쓸 때

- **한 폴더에 Claude 세션 하나.** 동시에 두 작업을 하면 작업 폴더를 나눕니다: `git worktree add ../respec-<이슈번호> -b <브랜치>`
- 커밋은 파일을 지정해서 합니다. `git add .` · `git add -A`는 다른 작업 파일까지 섞여 들어가므로 쓰지 않습니다. 커밋 전에 `git status`로 확인합니다.
- 이슈 범위 밖 파일은 고치지 않습니다. 다른 사람 카드에 적힌 담당 영역이면 먼저 작업자에게 알립니다.
- 여럿이 같이 고치는 파일(`package.json`, 잠금 파일, `app.json`, DB 마이그레이션)은 작은 PR로 따로 올립니다. 잠금 파일 충돌은 손으로 고치지 말고 `npm install`로 다시 만듭니다.
- 작업 시작 전에 main을 받아 오고(`git pull`), PR 전에는 `git rebase origin/main` 합니다. 밀어 넣을 때는 `--force-with-lease`만 씁니다.
- Claude의 기억은 사람마다 따로라 서로 공유되지 않습니다. 팀이 알아야 할 결정은 이 파일이나 문서에 PR로 남깁니다.

## 비밀값

- `.env`는 커밋하지 않습니다.
- `EXPO_PUBLIC_`로 시작하는 값은 앱에 그대로 들어가 공개되므로 비밀값을 넣지 않습니다.
- 외부 API 키와 Supabase `service_role` 키는 서버(Edge Functions) 비밀값으로만 씁니다.

## 리뷰

- PR을 열면 Claude가 자동으로 한 번 검수합니다: `pr-review` 스킬 + `.claude/review-checklist.md`
- 로컬에서 같은 기준으로 보려면 "pr-review로 이 브랜치 검수해줘"라고 합니다.

## 말투

- 사용자에게 보이는 문구, 코드 주석, 커밋, PR은 한국어로 씁니다.
