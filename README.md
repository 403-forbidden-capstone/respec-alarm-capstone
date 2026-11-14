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

<a href="https://github.com/403-forbidden-capstone/respec-alarm-capstone/releases/latest/download/respec-alarm.apk"><img src="https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=https%3A%2F%2Fgithub.com%2F403-forbidden-capstone%2Frespec-alarm-capstone%2Freleases%2Flatest%2Fdownload%2Frespec-alarm.apk" width="120" alt="최신 APK 설치 QR" /></a>

<sub>폰 카메라로 찍으면 최신 APK 다운로드 (GitHub 로그인 필요)</sub>

**앱** &nbsp; [웹 미리보기](https://respec-alarm-capstone.vmgfh878.workers.dev) · [최신 APK](https://github.com/403-forbidden-capstone/respec-alarm-capstone/releases/latest)<br />
**현황** &nbsp; [동작 현황](https://respec-alarm-capstone.vmgfh878.workers.dev/board) · [결정 안건](https://respec-alarm-capstone.vmgfh878.workers.dev/decisions/) · [AI 실험실](https://respec-alarm-capstone.vmgfh878.workers.dev/lab/)<br />
**관리** &nbsp; [작업 보드](https://github.com/orgs/403-forbidden-capstone/projects/1) · [마일스톤](https://github.com/403-forbidden-capstone/respec-alarm-capstone/milestones) · [제출 문서](docs/제출물)

<sub>2026-2 캡스톤디자인 · 포텐셜랩스 산학 협력 · 팀 403 Forbidden</sub>

</div>

---

## 실행

```bash
cd mobile
npm install
npm run web
```

브라우저에서 휴대폰 틀 안의 앱이 열립니다. 폰에는 위 최신 APK를 설치합니다.

| 문서 | 내용 |
|---|---|
| [`mobile/README.md`](mobile/README.md) | 앱 실행 옵션 · 폴더 구조 · 배포 |
| [`supabase/README.md`](supabase/README.md) | DB 변경 · 서버 함수 · 배치 · 데모 시드 |
| [`docs/decisions.md`](docs/decisions.md) | 결정 안건과 결과 |
| [`docs/alarm-core.md`](docs/alarm-core.md) | 앱 ↔ 알람 코어 연결 |
| [`docs/screen-data-map.md`](docs/screen-data-map.md) | 화면별 데이터 · API 연결 |

## 작업 흐름

| 단계 | 작업 | 보드 상태 |
|:-:|---|---|
| 1 | 이슈 틀 선택 후 작성 | 백로그 |
| 2 | 이번 주 할 일로 이동, 담당자 지정 | 이번 주 |
| 3 | 브랜치 `feat/12-FE-alarm-list`에서 작업, 초안 PR 생성 | 진행 중 |
| 4 | PR 생성(또는 초안 해제), 본문에 `Closes #12` | 리뷰 |
| 5 | 승인 1명 뒤 작성자가 Squash 머지 | 완료 |

보드 이동은 2단계만 수동입니다. 브랜치를 만들 때는 보드가 움직이지 않고, PR을 열 때 브랜치 이름의 이슈가 진행 중으로 갑니다(Actions 분량 #514). 비어 있는 시작일 · 담당자는 PR을 연 날짜 · 사람으로 채워집니다.

- `Closes #` 없이 연 PR은 PR 자체가 카드로 올라갑니다(초안 = 진행 중). 브랜치 이름에 이슈 번호가 있으면 본문에 `관련 이슈 #12`가 자동으로 달립니다. 이슈까지 닫으려면 `Closes #12`로 바꿉니다.
- PR 담당자는 작성자로 자동 지정됩니다(초안 포함).
- 완료 카드의 주차는 끝낸 주로 바뀝니다. 보드의 '한 일' 보기에서 주차별로 봅니다.

## 이슈

| 틀 | 유형 | 용도 |
|---|---|---|
| 기능 요청 · 추가 · 개선 | Feature | 새 기능 · 새 화면, 기존 기능 개선 |
| 버그 이슈 | Bug | 의도와 다른 동작 |
| 디자인 요청 | Design | 피그마 · UI · 화면 흐름 |
| 작업 | Task | 설정 · 문서 · 리팩토링 |

틀의 파트 · 우선순위 · 크기 · 시작일 · 목표일은 보드의 같은 칸으로 옮겨집니다. 파트 `FE` `BE` `DESIGN`은 같은 이름의 라벨로도 붙습니다. 담당자 · 마일스톤은 이슈 오른쪽 사이드바에서 지정합니다.

## 브랜치와 PR

```text
브랜치    {유형}/{이슈번호}-{파트}-{설명}     feat/12-FE-alarm-list
PR 제목   [파트] [유형] 작업 내용             [FE] [FEAT] 알람 목록 화면 구현
```

- 유형 `feat` `fix` `docs` `refactor` `chore`, 파트 `FE` `BE` `AI` `DATA` `DESIGN` `PM` `ALL`(공통)
- 보드 연동은 브랜치 이름의 이슈 번호 기준입니다.
- Squash 머지만 허용합니다. PR 제목이 그대로 `main`의 커밋 한 줄이 됩니다.
- 승인 1명 · 리뷰 대화 해결 뒤 작성자가 머지합니다. 머지된 브랜치는 자동 삭제됩니다.
- 리뷰 전 단계의 PR은 제목 앞에 `[WIP]`를 붙입니다.
- 위 규칙(PR 필수 · 승인 1명 · Squash만 · 강제 push 금지)은 무료 플랜 private 레포라 GitHub가 강제하지 않아 팀 약속으로 지킵니다. `main` 직접 push는 push 전 검사(레포 맨 위 `lefthook.yml`)가 막습니다. 급할 때만 `git push --no-verify`. 플랜 변경 시 [`.github/rulesets/main.json`](.github/rulesets/main.json)을 Settings → Rules → Rulesets → Import a ruleset으로 적용합니다.

## 리뷰

- PR을 열면 Claude가 `pr-review` 스킬과 [레포 체크리스트](.claude/review-checklist.md)로 검수해 댓글을 남깁니다. `[WIP]` · 문서만 바꾼 PR은 제외됩니다.
- 새 커밋마다 다시 돌지 않습니다. 재검수는 PR 댓글에 `@claude 다시 리뷰해줘`, 코드 줄 질문은 줄 댓글에 `@claude`를 붙입니다.
- 기능 흐름을 바꾸는 PR에는 `흐름 확인 필요` 라벨과 "흐름 확인" 검사가 붙습니다. 작업자가 흐름을 확인하고 PR 본문의 확인 줄을 체크하면 통과합니다.
- 로컬 리뷰 대상(현재 지형)의 PR은 Actions 대신 로컬 Claude Code의 [`local-review`](.claude/skills/local-review/SKILL.md) 스킬이 같은 기준으로 검수합니다.

<details>
<summary>리뷰 세부 규칙</summary>

<br />

- 보고 구성: 방향성(다음 이슈 · 설계 문서 · 스키마와 충돌하는 곳) + 자가 검수(안 읽은 파일 · 안 걸린 검사 · PR 설명과 코드 대조 · 미확인 항목). 기능 흐름 PR은 흐름과 판단 근거(문서 경로 · 절)가 붙고, 머지 판단이 "흐름 확인 후 머지"로 나옵니다.
- 다른 PR 위에 쌓인 PR: 받는 브랜치가 main으로 바뀔 때, 리뷰 판단을 아직 받지 못한 PR만 자동 검수합니다.
- 리뷰 누락: 브랜치의 리뷰 워크플로가 main과 다르거나 사용량 한도에 걸리면 "Claude 리뷰" 검사가 실패하고, PR에 원인과 재요청 방법이 남습니다.
- 큰 변경 · 위험 영역: 보고 끝에 `/code-review ultra` 추천이 붙습니다. 로컬 Claude Code에서 실행합니다.
- 로컬 리뷰: `[WIP]`를 뗀 PR이나 웹에서 연 PR은 로컬에서 "로컬 리뷰해줘"로 실행합니다. 기능 흐름 PR이면 라벨과 확인 줄만 붙고 검사는 없습니다. 대상 목록은 `claude-review.yml` · `claude.yml` · `flow-check.yml`의 `fromJSON('[...]')` 세 곳을 같이 고칩니다.

</details>

## 자동화

| 시점 | 동작 |
|---|---|
| 이슈 생성 | 보드 등록, 이슈 틀 값으로 보드 칸 채움 |
| PR 생성 | 브랜치 이슈 → 진행 중(빈 시작일 · 담당자 채움), 닫는 이슈 → 리뷰(초안이면 진행 중), 파트 라벨 복사, 빈 담당자 채움, Claude 리뷰, 웹 미리보기 주소(검사 목록의 Workers Builds → Details) |
| 기능 흐름 PR 판정 | `흐름 확인 필요` 라벨, "흐름 확인" 검사 대기 → 본문 확인 줄 체크 시 통과 |
| `supabase/` 변경 PR · 머지 | DB 검사(초안 PR은 초안을 풀 때), 머지되면 검사 없이 실제 DB에 적용 (서버 함수 · 시드만 바꾼 경우 제외) |
| 머지 | 이슈 → 완료, 웹 미리보기 고정 주소 갱신 |
| 매주 월요일 오전 9시 | `주간 요약` 이슈에 지난주 완료 · 머지 · 리뷰 대기 · 정체 작업 정리 |
| 매주 월요일 오전 10시 | 보안 검사 (비밀값 유출 · 패키지 취약점) |
| `v` 태그 | Releases에 데모 버전, APK와 설치 QR 첨부 |
| 매달 | 워크플로 부품 버전 업데이트 PR (Dependabot) |

Actions 분량을 아끼려고 아래 넷은 Actions → 워크플로 선택 → Run workflow로만 실행합니다.

| 워크플로 | 용도 |
|---|---|
| 앱 검사 | 타입 · 린트 · 단위 테스트 · 웹 빌드, 실행 요약에 커버리지 표. 평소에는 push 전 훅(`lefthook.yml`)이 로컬에서 같은 검사를 돌림 |
| 안드로이드 빌드 검사 | 네이티브 디버그 빌드, 개발용 APK 보관 |
| APK 빌드 | EAS 개발용 · 테스트용 APK, 실행 요약에 설치 QR |
| 데모 릴리즈 | 태그 입력 → main 최신 커밋으로 릴리스 생성 |

데모 버전은 main에서 태그로도 만듭니다.

```bash
git tag v0.1.0
git push origin v0.1.0
```

<details>
<summary>관리자 설정 · 비밀값</summary>

<br />

| 값 | 저장 위치 | 발급처 |
|---|---|---|
| `PROJECT_TOKEN` | GitHub Secret | classic 토큰, 권한 `repo` · `project` |
| `CLAUDE_CODE_OAUTH_TOKEN` | GitHub Secret | `npx @anthropic-ai/claude-code setup-token` |
| `EXPO_TOKEN` | GitHub Secret | expo.dev → 조직 → Access tokens → 로봇 사용자 |
| `SUPABASE_ACCESS_TOKEN` | GitHub Secret | Supabase → Account → Access Tokens |
| `EXPO_PUBLIC_SUPABASE_URL` · `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `mobile/.env` · Cloudflare 변수 · EAS 환경 변수 | Supabase → Project Settings → API Keys |
| `KAKAO_REST_API_KEY` · `GEMINI_API_KEY` | Supabase Edge Function secrets | 카카오 디벨로퍼스 · Google AI Studio |
| 카카오 · 구글 로그인 키 | Supabase → Authentication → Providers | 카카오 디벨로퍼스 · Google Cloud Console |
| `google-services.json` · FCM 서비스 계정 키 | EAS 파일 환경 변수 · credentials, GitHub Secret `GOOGLE_SERVICES_JSON_B64`(base64) | Firebase 콘솔 |

공개 가능한 값은 `EXPO_PUBLIC_`으로 시작하는 두 개뿐입니다. 나머지는 레포와 앱에 넣지 않습니다. 예시 파일: [`mobile/.env.example`](mobile/.env.example) · [`supabase/functions/.env.example`](supabase/functions/.env.example)

워크플로 파일은 `.github/workflows/`에 있습니다. 웹 미리보기 빌드 설정은 Cloudflare Worker `respec-alarm-capstone`(대시보드), [`mobile/wrangler.jsonc`](mobile/wrangler.jsonc)(main), 맨 위 [`wrangler.jsonc`](wrangler.jsonc) · `package.json`(PR 미리보기)에 나뉘어 있습니다.

</details>

## 라이선스

팀 403 Forbidden(김지형 · 유혜린 · 이수연 · 전준성)의 저작물입니다. 포텐셜랩스와의 산학 협력 범위 안에서만 사용할 수 있습니다. 자세한 내용은 [LICENSE](LICENSE)를 참고합니다.
