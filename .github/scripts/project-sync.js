// 이슈 · 브랜치 · PR 이벤트를 조직 보드(Re:Spec Alarm 보드)의 상태와 필드에 반영한다.
// .github/workflows/project-sync.yml 에서 actions/github-script 로 불러 쓴다.

const OWNER = '403-forbidden-capstone';
const PROJECT_NUMBER = 1;
const PARTS = ['FE', 'BE', 'AI', 'DATA', 'DESIGN', 'PM'];
const PART_LABELS = ['FE', 'BE', 'DESIGN'];
const PRIORITIES = ['높음', '보통', '낮음'];
const SIZES = ['S', 'M', 'L'];
// feat/12-FE-alarm-list 처럼 우리 규칙의 브랜치와, 이슈 사이드바에서 만든 12-alarm-list 둘 다 받는다.
const BRANCH_ISSUE = /^(?:(?:feat|fix|docs|refactor|chore)\/)?(\d+)-/;

const STATUS = {
  backlog: '백로그',
  inProgress: '진행 중',
  review: '리뷰',
  done: '완료',
};

module.exports = async function projectSync({ github, context, core }) {
  const board = await loadBoard(github);
  const sync = makeSync({ github, core, board });
  const { eventName, payload } = context;

  if (eventName === 'issues') {
    const { action, issue } = payload;
    if (action === 'opened') return onIssueOpened(sync, issue, { github, context });
    if (action === 'closed') return onIssueClosed(sync, issue);
    if (action === 'reopened') {
      const itemId = await sync.addItem(issue.node_id);
      return sync.setStatus(itemId, STATUS.inProgress);
    }
    return;
  }

  if (eventName === 'create' && payload.ref_type === 'branch') {
    return onBranchCreated(sync, payload, { github, context, core });
  }

  if (eventName === 'pull_request') {
    return onPullRequest(sync, payload, { github, context });
  }
};

// 이슈 작성: 보드 등록 → 백로그 → 이슈 틀에 적은 값을 필드로
async function onIssueOpened(sync, issue, { github, context }) {
  const itemId = await sync.addItem(issue.node_id);
  await sync.setStatus(itemId, STATUS.backlog);

  const form = parseForm(issue.body ?? '');

  let part = pick(form, '파트');
  if (!PARTS.includes(part)) part = partFromIssue(issue);
  if (part) {
    await sync.setOption(itemId, '파트', (name) => name === part);
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
    if (PART_LABELS.includes(part) && !labels.includes(part)) {
      await github.rest.issues.addLabels({ ...context.repo, issue_number: issue.number, labels: [part] });
    }
  }

  const priority = pick(form, '우선순위');
  const priorityWord = PRIORITIES.find((word) => priority.includes(word));
  if (priorityWord) await sync.setOption(itemId, '우선순위', (name) => name.includes(priorityWord));

  const size = pick(form, '크기').trim().charAt(0).toUpperCase();
  if (SIZES.includes(size)) await sync.setOption(itemId, '크기', (name) => name === size);

  const start = parseDate(pick(form, '시작일'));
  const due = parseDate(pick(form, '목표일'));
  if (start) await sync.setDate(itemId, '시작일', start);
  if (due) await sync.setDate(itemId, '목표일', due);
  if (start || due) await sync.setIteration(itemId, start || due);
}

// 이슈 닫힘: 완료. Not planned로 닫으면 보드에서 보관(archive)
async function onIssueClosed(sync, issue) {
  const itemId = await sync.addItem(issue.node_id);
  if (issue.state_reason === 'not_planned') return sync.archive(itemId);
  return sync.setStatus(itemId, STATUS.done);
}

// 브랜치 생성: 이름의 이슈 번호로 이슈를 찾아 진행 중, 빈 시작일 · 주차 · 담당자를 채운다
async function onBranchCreated(sync, payload, { github, context, core }) {
  const match = BRANCH_ISSUE.exec(payload.ref);
  if (!match) return core.info(`브랜치 ${payload.ref} 에 이슈 번호가 없어 건너뜁니다.`);
  const number = Number(match[1]);

  let issue;
  try {
    ({ data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: number }));
  } catch {
    return core.warning(`브랜치 ${payload.ref} 의 #${number} 이슈를 찾지 못했어요.`);
  }
  if (issue.pull_request || issue.state !== 'open') return;

  const itemId = await sync.addItem(issue.node_id);
  await sync.setStatus(itemId, STATUS.inProgress);

  const today = todayInSeoul();
  const start = (await sync.readValue(itemId, '시작일'))?.date;
  if (!start) await sync.setDate(itemId, '시작일', today);
  if (!(await sync.readValue(itemId, '주차'))?.iterationId) await sync.setIteration(itemId, start || today);

  const sender = payload.sender;
  if (!issue.assignees?.length && sender?.type === 'User') {
    await github.rest.issues.addAssignees({ ...context.repo, issue_number: number, assignees: [sender.login] });
  }
}

// PR: 연결된 이슈(Closes #번호)를 리뷰 → 머지면 완료, 머지 없이 닫히면 다시 진행 중
// 리뷰로 옮길 때 이슈의 파트 라벨을 PR에 붙이고, 비어 있는 담당자를 PR 작성자로 채운다
async function onPullRequest(sync, payload, { github, context }) {
  const { action, pull_request: pr } = payload;
  const { repository } = await github.graphql(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          closingIssuesReferences(first: 10) {
            nodes {
              id number state
              repository { nameWithOwner }
              labels(first: 20) { nodes { name } }
              assignees(first: 1) { totalCount }
            }
          }
        }
      }
    }`,
    { ...context.repo, number: pr.number },
  );
  const issues = repository.pullRequest.closingIssuesReferences.nodes;

  let status = null;
  if (['opened', 'reopened', 'edited', 'ready_for_review'].includes(action) && pr.state === 'open' && !pr.draft) {
    status = STATUS.review;
  } else if (action === 'closed') {
    status = pr.merged ? STATUS.done : STATUS.inProgress;
  }
  if (!status) return;

  for (const issue of issues) {
    if (status !== STATUS.done && issue.state !== 'OPEN') continue;
    const itemId = await sync.addItem(issue.id);
    await sync.setStatus(itemId, status);
  }

  if (status === STATUS.review) await fillPullRequest(pr, issues, { github, context });
}

// 파트 라벨(릴리즈 노트 분류용)과 담당자(보드 카드에 누가 하는지 보이게).
// 이미 있으면 건드리지 않으므로 PR을 고쳐서 다시 돌아도 같은 결과다.
async function fillPullRequest(pr, issues, { github, context }) {
  const { owner, repo } = context.repo;
  const ours = issues.filter((issue) => issue.repository.nameWithOwner === `${owner}/${repo}`);

  const current = (pr.labels ?? []).map((l) => l.name);
  const parts = new Set();
  for (const issue of ours) {
    for (const { name } of issue.labels.nodes) if (PART_LABELS.includes(name)) parts.add(name);
  }
  const missing = [...parts].filter((name) => !current.includes(name));
  if (missing.length) await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: missing });

  if (pr.user?.type !== 'User') return;
  const assignees = [pr.user.login];
  if (!pr.assignees?.length) await github.rest.issues.addAssignees({ owner, repo, issue_number: pr.number, assignees });
  for (const issue of ours) {
    if (issue.state === 'OPEN' && issue.assignees.totalCount === 0) {
      await github.rest.issues.addAssignees({ owner, repo, issue_number: issue.number, assignees });
    }
  }
}

// ---- 보드 GraphQL ----

async function loadBoard(github) {
  const { organization } = await github.graphql(
    `query($owner: String!, $number: Int!) {
      organization(login: $owner) {
        projectV2(number: $number) {
          id
          fields(first: 50) {
            nodes {
              ... on ProjectV2FieldCommon { id name }
              ... on ProjectV2SingleSelectField { options { id name } }
              ... on ProjectV2IterationField {
                configuration {
                  iterations { id startDate duration }
                  completedIterations { id startDate duration }
                }
              }
            }
          }
        }
      }
    }`,
    { owner: OWNER, number: PROJECT_NUMBER },
  );
  const project = organization.projectV2;
  return { id: project.id, field: (name) => project.fields.nodes.find((f) => f.name === name) };
}

function makeSync({ github, core, board }) {
  const update = async (itemId, fieldName, value) => {
    const field = board.field(fieldName);
    if (!field) return core.warning(`보드에 '${fieldName}' 필드가 없어요.`);
    await github.graphql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) {
          projectV2Item { id }
        }
      }`,
      { projectId: board.id, itemId, fieldId: field.id, value },
    );
  };

  const setOption = async (itemId, fieldName, matches) => {
    const option = board.field(fieldName)?.options?.find((o) => matches(o.name));
    if (!option) return core.warning(`'${fieldName}' 필드에 맞는 선택지가 없어요.`);
    await update(itemId, fieldName, { singleSelectOptionId: option.id });
  };

  return {
    async addItem(contentId) {
      const { addProjectV2ItemById } = await github.graphql(
        `mutation($projectId: ID!, $contentId: ID!) {
          addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
        }`,
        { projectId: board.id, contentId },
      );
      return addProjectV2ItemById.item.id;
    },
    setOption,
    setStatus: (itemId, keyword) => setOption(itemId, 'Status', (name) => name.includes(keyword)),
    setDate: (itemId, fieldName, date) => update(itemId, fieldName, { date }),
    async setIteration(itemId, date) {
      const config = board.field('주차')?.configuration;
      const iterations = [...(config?.iterations ?? []), ...(config?.completedIterations ?? [])];
      const iteration = iterations.find((it) => isWithin(date, it.startDate, it.duration));
      if (iteration) await update(itemId, '주차', { iterationId: iteration.id });
    },
    async readValue(itemId, fieldName) {
      const { node } = await github.graphql(
        `query($id: ID!, $name: String!) {
          node(id: $id) {
            ... on ProjectV2Item {
              fieldValueByName(name: $name) {
                ... on ProjectV2ItemFieldDateValue { date }
                ... on ProjectV2ItemFieldIterationValue { iterationId }
              }
            }
          }
        }`,
        { id: itemId, name: fieldName },
      );
      return node?.fieldValueByName ?? null;
    },
    async archive(itemId) {
      await github.graphql(
        `mutation($projectId: ID!, $itemId: ID!) {
          archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { item { id } }
        }`,
        { projectId: board.id, itemId },
      );
    },
  };
}

// ---- 이슈 틀 · 날짜 ----

// 이슈 틀로 만든 이슈 본문은 "### 질문\n\n답" 형태다. 비운 칸은 "_No response_".
function parseForm(body) {
  const form = {};
  for (const chunk of body.split(/^###\s+/m).slice(1)) {
    const newline = chunk.indexOf('\n');
    const label = (newline === -1 ? chunk : chunk.slice(0, newline)).trim();
    const value = newline === -1 ? '' : chunk.slice(newline + 1).trim();
    form[label] = value === '_No response_' ? '' : value;
  }
  return form;
}

function pick(form, keyword) {
  const label = Object.keys(form).find((l) => l.includes(keyword));
  return label ? form[label] : '';
}

function partFromIssue(issue) {
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  const fromLabel = PART_LABELS.find((p) => labels.includes(p));
  if (fromLabel) return fromLabel;
  return issue.type?.name === 'Design' ? 'DESIGN' : null;
}

// 2026-10-07 · 2026.10.7 · 10/7 · 10.7 · 10월 7일 → 2026-10-07
function parseDate(text, year = Number(todayInSeoul().slice(0, 4))) {
  const t = (text ?? '').trim();
  let m = t.match(/^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
  if (m) return toDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = t.match(/^(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
  if (m) return toDate(year, Number(m[1]), Number(m[2]));
  return null;
}

function toDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

function isWithin(date, startDate, durationDays) {
  const day = Date.parse(`${date}T00:00:00Z`);
  const start = Date.parse(`${startDate}T00:00:00Z`);
  return day >= start && day < start + durationDays * 86400000;
}

function todayInSeoul() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

module.exports.parseForm = parseForm;
module.exports.parseDate = parseDate;
module.exports.pick = pick;
module.exports.BRANCH_ISSUE = BRANCH_ISSUE;
