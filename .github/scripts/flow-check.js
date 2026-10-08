// 기능 흐름 PR 확인 — 리뷰가 기능 흐름 PR로 판단하면 `흐름 확인 필요` 라벨과 "흐름 확인" 검사를 붙이고,
// 작업자가 PR 본문의 확인 줄을 체크하면 검사가 통과한다. (규칙: .claude/review-checklist.md "기능 흐름 PR")
// claude-review.yml · claude.yml(리뷰 직후) · flow-check.yml(PR 이벤트)에서 actions/github-script 로 불러 쓴다.
//
// mode
//   review  자동 리뷰 직후. 리뷰 댓글이 없으면 실패로 남기고(조용히 건너뛴 리뷰를 드러냄), 표시가 있으면 라벨 · 확인 줄을 붙임
//   mention @claude 직후. 표시가 있으면 라벨 · 확인 줄을 붙임
//   sync    PR 본문 수정 · 새 커밋 · 라벨 변경 때 검사만 다시 계산

const LABEL = '흐름 확인 필요';
const MARKER = '<!-- flow-check:required -->';
const CHECK_TEXT = '흐름 · 판단 근거를 작업자가 직접 확인했어요';
const CHECK_LINE = `- [ ] (기능 흐름 PR만) ${CHECK_TEXT}`;
const CONTEXT = '흐름 확인';
const REVIEW_WORKFLOW = '.github/workflows/claude-review.yml';

module.exports = async function flowCheck({ github, context, core, mode, prNumber, since }) {
  const { owner, repo } = context.repo;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  let labeled = pr.labels.some((label) => label.name === LABEL);
  let body = pr.body ?? '';

  const setStatus = (state, description) =>
    github.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: pr.head.sha,
      state,
      context: CONTEXT,
      description,
      target_url: pr.html_url,
    });

  if (mode === 'review' || mode === 'mention') {
    // since 뒤에 달리거나 고쳐진 봇 댓글 (@claude는 진행 댓글 하나를 고쳐 가며 보고함)
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      since,
      per_page: 100,
    });
    const botComments = comments.filter((c) => c.user?.type === 'Bot' && c.user.login.startsWith('claude'));

    if (mode === 'review' && botComments.length === 0) {
      const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: prNumber, per_page: 100 });
      if (files.some((f) => f.filename === REVIEW_WORKFLOW)) {
        core.notice('이 PR이 리뷰 워크플로를 바꿔서 Claude 리뷰는 머지 뒤부터 동작함');
        return;
      }
      core.setFailed('Claude 리뷰 댓글이 달리지 않음');
      return;
    }

    if (!botComments.some((c) => c.body?.includes(MARKER))) return;
    if (!labeled) {
      await github.rest.issues.addLabels({ owner, repo, issue_number: prNumber, labels: [LABEL] });
      labeled = true;
    }
  }

  // 라벨이 있는데 본문에 확인 줄이 없으면(틀에서 지웠거나 라벨을 손으로 붙임) 끝에 붙임
  if (labeled && !body.includes(CHECK_TEXT)) {
    body = `${body.trimEnd()}\n\n${CHECK_LINE}\n`;
    await github.rest.pulls.update({ owner, repo, pull_number: prNumber, body });
  }

  if (!labeled) {
    // 라벨을 빼면 전에 남긴 대기 검사를 풂
    const { action, label } = context.payload;
    if (mode === 'sync' && action === 'unlabeled' && label?.name === LABEL) {
      await setStatus('success', '라벨을 뺌 — 기능 흐름 PR 아님');
    }
    return;
  }

  // 작업자만 체크함. 실패가 아니라 대기로 둬서 자동 수정이 "고칠 CI"로 보지 않게
  const checked = body.split('\n').some((line) => line.includes(CHECK_TEXT) && /\[[xX]\]/.test(line));
  await setStatus(
    checked ? 'success' : 'pending',
    checked ? '작업자가 흐름을 확인함' : '작업자 확인 전 — 리뷰의 기능 흐름 · 판단 근거를 보고 PR 본문 확인 줄 체크',
  );
};
