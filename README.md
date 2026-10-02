# Re:Spec Alarm

혼자 깨는 알람에서, 함께 약속을 지키는 알람으로 — 2026-2 캡스톤디자인 · 포텐셜랩스 산학 협력 · 팀 403 Forbidden

이 문서는 이 레포의 GitHub 규칙만 정리합니다. Git 사용법과 협업 가이드는 노션을 봐 주세요.

## 작업 흐름

```
이슈 생성 → 브랜치 생성 → 작업 · push → PR → 리뷰 승인 1명 → Squash 머지
```

- 이슈 없이 작업하지 않습니다.
- `main`에 직접 push하지 않습니다. 모든 변경은 PR로 들어옵니다.

## 이슈

[New issue](../../issues/new/choose)에서 틀을 골라 작성합니다. 틀을 고르면 이슈 Type이 자동으로 지정됩니다.

| 틀 | Type | 언제 |
|---|---|---|
| 기능 요청 · 추가 · 개선 | Feature | 새 기능 · 새 화면, 기존 기능 개선 |
| 버그 이슈 | Bug | 의도와 다르게 동작할 때 |
| 디자인 요청 | Design | 피그마 · UI · 화면 흐름 |
| 작업 | Task | 설정 · 문서 · 리팩토링 |

- 라벨은 파트만 씁니다: `FE` `BE` `DESIGN`
- 담당자(Assignees)를 지정하고, 사이드바 Projects에서 [Re:Spec Alarm 보드](https://github.com/orgs/403-forbidden-capstone/projects/1)를 선택합니다.
- 마일스톤이 있으면 함께 지정합니다.

## 브랜치

```
{유형}/{이슈번호}-{파트}-{설명}
```

예: `feat/12-FE-alarm-list`, `fix/27-BE-wake-status-null`

| 유형 | 파트 |
|---|---|
| `feat` `fix` `docs` `refactor` `chore` | `FE` `BE` `AI` `DATA` `DESIGN` `ALL`(공통) |

설명은 영어 소문자와 하이픈으로 짧게 씁니다.

## PR

- 대상 브랜치는 `main`입니다.
- 제목은 `[파트] [유형] 작업 내용` 형식으로 씁니다. 예: `[FE] [FEAT] 알람 목록 화면 구현`
- 머지는 Squash만 허용되어, **PR 제목이 그대로 `main`의 커밋 메시지**가 됩니다.
- 본문에 `Closes #이슈번호`를 적으면 머지할 때 이슈가 자동으로 닫힙니다.
- 아직 리뷰받을 상태가 아니면 제목 앞에 `[WIP]`를 붙입니다.
- 승인 1명을 받고 리뷰 대화를 모두 해결한 뒤, 작성자 본인이 머지합니다.
- 머지하면 브랜치는 자동으로 삭제됩니다.

## main 보호 규칙

| 규칙 | 내용 |
|---|---|
| PR 필수 | `main`에 직접 push 불가 |
| 승인 | 1명 이상, 새 커밋이 올라오면 기존 승인 무효 |
| 리뷰 대화 | 모두 해결(Resolve)해야 머지 가능 |
| 머지 방식 | Squash만 |
| 강제 push · 브랜치 삭제 | 금지 |

무료 플랜의 private 레포에서는 GitHub가 보호 규칙을 지원하지 않아, 지금은 **팀 약속으로 지킵니다.** 규칙은 [`.github/rulesets/main.json`](.github/rulesets/main.json)에 준비되어 있어서, 조직이 Team 플랜으로 바뀌거나 레포가 public이 되면 Settings → Rules → Rulesets → New ruleset → Import a ruleset으로 이 파일을 올리면 바로 적용됩니다.

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
| 창의경진대회 | 12/4 데모 |

## 보드

[Re:Spec Alarm 보드](https://github.com/orgs/403-forbidden-capstone/projects/1)에서 할 일 · 역할 · 진행 상태를 관리합니다.

```
백로그 → 이번 주 → 진행 중 → 리뷰 → 완료
```

카드에는 담당자, 파트, 우선순위, 크기, 주차를 지정합니다.
