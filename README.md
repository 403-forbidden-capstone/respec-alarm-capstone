<div align="center">

<img src="https://github.com/403-forbidden-capstone.png?size=200" width="80" alt="403 Forbidden" />

# Re:Spec Alarm

혼자 깨는 알람에서, 함께 약속을 지키는 알람으로

![Expo](https://img.shields.io/badge/Expo_SDK_57-24292f?style=flat-square&logo=expo&logoColor=white)
![React Native](https://img.shields.io/badge/React_Native-24292f?style=flat-square&logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-24292f?style=flat-square&logo=typescript&logoColor=white)
![Kotlin](https://img.shields.io/badge/Kotlin-24292f?style=flat-square&logo=kotlin&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-24292f?style=flat-square&logo=supabase&logoColor=white)
![Gemini API](https://img.shields.io/badge/Gemini_API-24292f?style=flat-square&logo=googlegemini&logoColor=white)
![Android](https://img.shields.io/badge/Android-24292f?style=flat-square&logo=android&logoColor=white)

[웹 미리보기](https://respec-alarm-capstone.vmgfh878.workers.dev) · [최신 APK](https://github.com/403-forbidden-capstone/respec-alarm-capstone/releases/latest) · [보드](https://github.com/orgs/403-forbidden-capstone/projects/1) · [새 이슈](https://github.com/403-forbidden-capstone/respec-alarm-capstone/issues/new/choose) · [마일스톤](https://github.com/403-forbidden-capstone/respec-alarm-capstone/milestones) · [Pull Requests](https://github.com/403-forbidden-capstone/respec-alarm-capstone/pulls)

<sub>2026-2 캡스톤디자인 · 포텐셜랩스 산학 협력 · 팀 403 Forbidden</sub>

</div>

---

레포 안에서 지키는 GitHub 규칙을 정리했습니다. Git 사용법과 협업 가이드는 노션에 있습니다.

## 작업 흐름

| 단계 | 하는 일 | 보드 |
|:-:|---|---|
| 1 | 틀을 골라 이슈 작성 | 백로그 |
| 2 | 이번 주에 할 일로 옮기고 담당자 지정 | 이번 주 |
| 3 | 브랜치 만들기 `feat/12-FE-alarm-list` | 진행 중 |
| 4 | PR 열기, 본문에 `Closes #12` | 리뷰 |
| 5 | 승인 1명 후 작성자가 Squash 머지 | 완료 |

2단계를 뺀 보드 이동은 자동입니다. 시작일이 비어 있으면 브랜치를 만든 날이, 담당자가 없으면 브랜치를 만든 사람이 들어갑니다.

## 이슈

| 틀 | Type | 쓰는 때 |
|---|---|---|
| 기능 요청 · 추가 · 개선 | Feature | 새 기능 · 새 화면, 기존 기능 개선 |
| 버그 이슈 | Bug | 의도와 다르게 동작할 때 |
| 디자인 요청 | Design | 피그마 · UI · 화면 흐름 |
| 작업 | Task | 설정 · 문서 · 리팩토링 |

틀에 적은 파트 · 우선순위 · 크기 · 시작일 · 목표일은 보드의 같은 칸으로 들어갑니다. 파트가 `FE` `BE` `DESIGN`이면 같은 이름의 라벨이 붙습니다. 담당자와 마일스톤은 이슈 오른쪽에서 고릅니다.

## 브랜치와 PR

```text
브랜치    {유형}/{이슈번호}-{파트}-{설명}     feat/12-FE-alarm-list
PR 제목   [파트] [유형] 작업 내용             [FE] [FEAT] 알람 목록 화면 구현
```

- 유형은 `feat` `fix` `docs` `refactor` `chore`, 파트는 `FE` `BE` `AI` `DATA` `DESIGN` `PM` `ALL`(공통)입니다.
- 브랜치 이름에 이슈 번호가 있어야 보드가 따라 움직입니다.
- Squash 머지만 허용되어 PR 제목이 그대로 `main`의 커밋 한 줄이 됩니다.
- 승인 1명을 받고 리뷰 대화를 모두 해결한 뒤 작성자 본인이 머지합니다. 머지한 브랜치는 자동으로 지워집니다.
- 아직 리뷰받을 상태가 아니면 제목 앞에 `[WIP]`를 붙입니다.

## 리뷰

리뷰어 1명의 승인이 기본입니다.

- PR을 열면 Claude가 `pr-review` 스킬과 [레포 체크리스트](.claude/review-checklist.md)로 검수해 댓글을 남깁니다.
- 새 커밋마다 다시 돌지는 않습니다. 다시 받고 싶으면 PR 댓글에 `@claude 다시 리뷰해줘`라고 씁니다.
- 제목에 `[WIP]`가 있거나 문서만 바꾼 PR은 건너뜁니다. `[WIP]`를 빼는 순간 검수합니다.
- 변경이 크거나 위험한 영역이면 보고 끝에 `/code-review ultra` 추천이 붙습니다. 로컬 Claude Code에서 실행합니다.
- 코드 줄 댓글에서 `@claude 이거 왜 이렇게 했어?`처럼 물어볼 수도 있습니다.


## 자동화

| 언제 | 무엇이 |
|---|---|
| 이슈를 만들면 | 보드에 등록, 이슈 틀 값으로 보드 칸 채우기 |
| 브랜치를 만들면 | 이슈가 진행 중으로, 빈 시작일 · 담당자 채우기 |
| PR을 열면 | 이슈가 리뷰로, 이슈의 파트 라벨을 PR에, 빈 담당자 채우기, Claude 리뷰, 비밀값 유출 검사, 웹 미리보기 주소 (검사 목록의 Workers Builds → Details) |
| 머지하면 | 이슈가 완료로, 웹 미리보기 고정 주소 갱신 |
| Actions → APK 빌드 → Run workflow | EAS로 개발용 · 테스트용 APK 빌드, 실행 요약에 설치 QR |
| 매주 월요일 오전 9시 | `주간 요약` 이슈에 지난주 완료 · 머지 · 리뷰 대기 · 멈춘 일 정리 |
| `v`로 시작하는 태그를 달면 | Releases에 데모 버전, 앱이 있으면 APK와 설치 QR |
| 매달 | 워크플로 부품 버전 올리기 PR (Dependabot) |

데모 버전은 main에서 태그를 달아 만듭니다.

```bash
git tag v0.1.0
git push origin v0.1.0
```

## main 보호 규칙

PR 필수, 승인 1명(새 커밋이 올라오면 다시 승인), 리뷰 대화 해결, Squash만, 강제 push와 브랜치 삭제 금지.

무료 플랜의 private 레포는 GitHub가 보호 규칙을 지원하지 않아 지금은 팀 약속으로 지킵니다. 플랜이 바뀌면 [`.github/rulesets/main.json`](.github/rulesets/main.json)을 Settings → Rules → Rulesets → Import a ruleset으로 올려 바로 적용합니다.

## 마일스톤

| 마일스톤 | 내용 |
|---|---|
| M0 세팅 | 레포 · 협업 규칙 · 개발 환경 |
| M1 목업 화면 | 피그마 화면을 목업 데이터로 구현 |
| M2 기능① | 약속 기반 개인 알람 |
| M3 기능② | 알람 공유 · 기상 확인 |
| M4 기능③ | 수면 전후 Voice AI 대화 |
| M5 기능④ | 캘린더 · 하루 기록 |
| M6 기능⑥ | AI 대화형 일기 · 루틴 |
| 창의경진대회 데모 | 12/4 시연 |

<details>
<summary>관리자 설정 · 비밀값</summary>

<br />

| 값 | 넣는 곳 | 만드는 곳 |
|---|---|---|
| `PROJECT_TOKEN` | GitHub Secret | classic 토큰, 권한 `repo` · `project` |
| `CLAUDE_CODE_OAUTH_TOKEN` | GitHub Secret | `npx @anthropic-ai/claude-code setup-token` |
| `EXPO_TOKEN` | GitHub Secret | expo.dev → 조직 → Access tokens → 로봇 사용자 |
| `EXPO_PUBLIC_SUPABASE_URL` · `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `mobile/.env` · Cloudflare 변수 · EAS 환경 변수 | Supabase → Project Settings → API Keys |
| `KAKAO_REST_API_KEY` · `GEMINI_API_KEY` | Supabase Edge Function secrets | 카카오 디벨로퍼스 · Google AI Studio |
| 카카오 · 구글 로그인 키 | Supabase → Authentication → Providers | 카카오 디벨로퍼스 · Google Cloud Console |
| `google-services.json` · FCM 서비스 계정 키 | EAS 파일 환경 변수 · credentials | Firebase 콘솔 |

공개돼도 되는 값은 `EXPO_PUBLIC_`으로 시작하는 두 개뿐입니다. 나머지는 레포와 앱에 넣지 않습니다. 예시 파일은 [`mobile/.env.example`](mobile/.env.example)과 [`supabase/functions/.env.example`](supabase/functions/.env.example)입니다.

자동화 파일은 모두 `.github/workflows/`에 있습니다. 웹 미리보기 빌드 설정은 Cloudflare Worker `respec-alarm-capstone`(대시보드)과 [`mobile/wrangler.jsonc`](mobile/wrangler.jsonc)에 있습니다.

</details>

## 라이선스

팀 403 Forbidden(김지형 · 유혜린 · 이수연 · 전준성)의 저작물입니다. 포텐셜랩스와의 산학 협력 범위 안에서만 사용할 수 있습니다. 자세한 내용은 [LICENSE](LICENSE)를 봅니다.
