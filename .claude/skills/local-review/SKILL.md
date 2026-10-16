---
name: local-review
description: 로컬 리뷰 대상(지금은 지형 `vmgfh878-art`) PR을 GitHub Actions 대신 로컬 Claude Code로 검수하고, 의견을 걸러 결과 댓글 하나만 PR에 남김. "로컬 리뷰", "내 PR 리뷰해줘", "로컬로 리뷰 돌려", PR을 만든 직후 훅 안내("local-review 스킬로 #N")일 때 사용. Actions 리뷰가 도는 다른 팀원 PR에는 쓰지 않음.
---

# 로컬 리뷰

Actions의 Claude 자동 리뷰(`.github/workflows/claude-review.yml`)와 같은 기준(`pr-review` 스킬 + `.claude/review-checklist.md`)으로 검수함. 다른 점은 셋.

- 로컬 Claude Code 구독으로 돌아서 Actions 분을 안 씀
- 검수 의견을 그대로 붙이지 않고, 확인해서 거른 결과만 댓글 하나로 남김
- 판단이 필요 없는 확실한 문제는 같은 PR에서 바로 고침

대상 = 워크플로 `fromJSON('[...]')` 목록에 있는 사람의 PR (`claude-review.yml` · `claude.yml` · `flow-check.yml`, 지금 `vmgfh878-art`). 목록에 없는 사람의 PR은 Actions 리뷰가 돌기 때문에 이 스킬을 쓰지 않음.

## 0. 대상 확인

```bash
gh pr view <N> --json number,title,isDraft,author,baseRefName,headRefName,headRefOid,files,labels,body,url
```

- 건너뜀 (댓글 없이 채팅에 한 줄): 초안 · 제목 `[WIP]` · 바뀐 파일이 전부 `.md` 또는 `docs/` 아래 (Actions 리뷰와 같은 기준)
- 이미 로컬 리뷰 댓글(`<!-- local-review -->`)이 있으면 다시 돌리지 않음. 작업자가 "다시 리뷰"라고 할 때만 (아래 "다시 리뷰")
- 작성자가 목록에 없으면 하지 않음

## 1. 검수 — 새 서브에이전트 하나

PR을 만든 세션의 맥락이 섞이지 않게 `Agent`(general-purpose) 하나에 맡김.

- 작업 폴더: 지금 폴더가 PR 브랜치면 그대로. 아니면 `git fetch origin <headRefName>` → `git worktree add ../respec-review-<N> <headRefOid>`, 끝나면 `git worktree remove ../respec-review-<N>`
- 서브에이전트 프롬프트 (빈칸 채움):

```
REPO: 403-forbidden-capstone/respec-alarm-capstone
PR 번호: <N> / 제목: <title> / 기준 브랜치: <base>
작업 폴더: <path> (PR 브랜치가 체크아웃되어 있음)

이 PR을 검수하고 결과를 메시지로 돌려줘. GitHub 댓글 · 커밋 · push는 하지 않음.
1. `pr-review` 스킬로 기본 검수. 브라우저 · Lighthouse · 이중 빌드가 필요한 항목은 "건너뜀: 사유"
2. `.claude/review-checklist.md`의 레포 전용 항목. 기능 흐름 PR(체크리스트 기준, 애매하면 해당)이면
   "기능 흐름 · 판단 근거" 칸을 체크리스트 형식대로 (레포 문서 근거는 열어서 실제로 맞는지 확인,
   없으면 "근거 없음 — 작성자 판단"), 머지 판단은 "흐름 확인 후 머지"
3. 방향성: 스킬 Step 5a — 연결 이슈, 이 코드 위에 올라갈 열린 이슈 · PR, docs/ · 스키마와 부딪히는 곳.
   작은 수정이면 "방향성: 해당 없음 — 이유" 한 줄
4. 자가 검수: 스킬 Step 5b (references/self-check.md)
5. 돌려줄 것 (한국어): 한 줄 요약 / 머지 판단(머지 가능 · 흐름 확인 후 머지 · 수정 후 머지 · 막힘) /
   기능 흐름 PR 여부 / 기능 흐름 · 판단 근거 / 방향성 / 발견 사항(심각도 · 파일:줄 · 근거) /
   자가 검수 / 건너뛴 항목 / `/code-review ultra` 추천 여부와 이유
   (추천 기준: 바뀐 파일 15개 이상 또는 500줄 이상, 인증 · RLS · 비밀값 · 외부 입력 · 알람 예약, 확신 낮은 발견 여럿)
```

## 2. 의견 정리

- 발견마다 해당 줄을 직접 열어 맞는지 확인 → 틀린 지적은 뺌 (댓글엔 뺀 개수만)
- 판단이 필요 없는 확실한 문제(오타 · 명백한 버그 · 틀린 문서 경로 · 타입 오류)는 같은 PR에서 고침
  - 파일을 지정해서 `git add`, 커밋 메시지 한국어, push
  - 고친 범위만 검사: `npx tsc --noEmit` · lint · 관련 테스트
- 기능 · 화면 · 기술 판단이 걸린 것은 고치지 않고 "확인 필요"로 남김 (결정은 작업자 · 팀)
- 서브에이전트를 다시 부르지 않음 (리뷰는 1번)

## 3. 댓글 하나

임시 파일에 쓰고 `gh pr comment <N> --body-file <파일>`. 줄 단위 댓글은 달지 않음.

```markdown
## 로컬 리뷰

**머지 판단: <머지 가능 | 흐름 확인 후 머지 | 수정 후 머지 | 막힘>** — <한 줄 요약>

### 고침
- <무엇> (`파일:줄`) — <커밋 짧은 해시>

### 확인 필요
- [높음 | 중간 | 낮음] <무엇> (`파일:줄`) — <이유 · 근거>

### 기능 흐름 · 판단 근거
<기능 흐름 PR만. 체크리스트 형식 그대로>

### 방향성
- <다음 이슈 · 문서 · 스키마와 부딪히는 곳, 근거와 함께>

<details><summary>자가 검수 · 건너뛴 항목</summary>

- <다시 확인한 것 · 뺀 지적 N개 · 이 환경에서 못 본 것>

</details>

<sub>로컬 Claude Code · pr-review + 레포 체크리스트 · 기준 커밋 <headRefOid 앞 7자리></sub>
<!-- local-review -->
```

- 빈 칸은 지움 ("고침"이 없으면 그 칸 통째로, "확인 필요"가 없으면 "없음")
- `/code-review ultra` 추천 대상이면 방향성 아래 한 줄: "더 깊은 검수가 필요하면 로컬에서 `/code-review ultra <N>` — 이유: …" (실행은 작업자)
- 기능 흐름 PR이면 맨 마지막 줄에 `<!-- flow-check:required -->`도 넣음

## 4. 기능 흐름 PR 표시

Actions의 "흐름 확인" 검사는 이 PR에서 돌지 않으므로 표시만 붙임.

- `gh pr edit <N> --add-label "흐름 확인 필요"`
- PR 본문에 확인 줄이 없으면 끝에 붙임 (`gh pr edit <N> --body-file`): `- [ ] (기능 흐름 PR만) 흐름 · 판단 근거를 작업자가 직접 확인했어요` (`.github/scripts/flow-check.js`의 `CHECK_LINE`과 같은 글자)
- 이 줄은 작업자만 체크함. "흐름 확인" 상태 검사는 만들지 않음

## 5. 채팅 보고

몇 줄: 머지 판단 · 고친 것 개수 · 확인 필요 개수 + 댓글 링크.

## 다시 리뷰

작업자가 "다시 리뷰"라고 할 때만. 같은 순서로 하고, 서브에이전트 프롬프트에 "지난 로컬 리뷰 댓글(<링크>) 뒤에 올라온 커밋과 지난 지적의 상태도 봄"을 더함. 새 댓글 하나를 남기고 지난 댓글은 고치지 않음. 지난 판단이 "흐름 확인 후 머지" · "머지 가능"이면 다시 돌리지 않고 작업자 확인 · 머지로 끝.
