// 이슈 · PR 이벤트를 조직 보드(Re:Spec Alarm 보드)의 상태와 필드에 반영한다.
// .github/workflows/project-sync.yml 에서 actions/github-script 로 불러 쓴다.

const OWNER = '403-forbidden-capstone';
const PROJECT_NUMBER = 1;
const PARTS = ['FE', 'BE', 'AI', 'DATA', 'DESIGN', 'PM'];
const PART_LABELS = ['FE', 'BE', 'DESIGN'];
const PRIORITIES = ['높음', '보통', '낮음'];
const SIZES = ['S', 'M', 'L'];
// feat/12-FE-alarm-list 처럼 우리 규칙의 브랜치와, 이슈 사이드바에서 만든 12-alarm-list 둘 다 받는다.
const BRANCH_ISSUE = /^(?:(?:feat|fix|docs|refactor|chore)\/)?(\d+)-/;
// PR 제목 머리말 → 보드 파트. ALL(공통)은 보드에 없어 비워 둔다.
const TITLE_PARTS = { FE: 'FE', BE: 'BE', DB: 'BE', AI: 'AI', DATA: 'DATA', DESIGN: 'DESIGN', PM: 'PM' };
// PR 틀의 비어 있는 'Closes #' 줄
const EMPTY_CLOSES = /^[ \t]*(?:closes|fixes|resolves)[ \t]*#[ \t]*$/im;

const STATUS = {
  backlog: '백로그',
  inProgress: '진행 중',
  review: '리뷰',
  done: '완료',
};
// 보드 칸 순서. 이슈 작성 · PR을 열 때의 브랜치 이슈는 카드를 앞으로만 옮긴다.
// 이슈를 만들고 바로 브랜치 · PR까지 올리면 늦게 끝난 실행이 카드를 되돌릴 수 있어서다.
const FLOW = ['백로그', '이번 주', '진행 중', '리뷰', '완료'];

// prClient: PR 본문을 고칠 때 쓰는 클라이언트(워크플로의 GITHUB_TOKEN). 이 토큰으로 고치면
// 다른 워크플로(edited 받는 Claude 리뷰 · 흐름 확인)가 새로 돌지 않는다. 없으면 github으로 고친다.
module.exports = async function projectSync({ github, context, core, prClient = github }) {
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

  if (eventName === 'pull_request') {
    return onPullRequest(sync, payload, { github, context, core, board, prClient });
  }
};

// 이슈 작성: 보드 등록 → 백로그 → 이슈 틀에 적은 값을 필드로
async function onIssueOpened(sync, issue, { github, context }) {
  const itemId = await sync.addItem(issue.node_id);
  await sync.moveForward(itemId, STATUS.backlog);

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

// 이슈 닫힘: 완료 + 주차는 끝낸 주('한 일' 보기가 주차로 묶임). Not planned · Duplicate로 닫으면 보드에서 보관(archive)
async function onIssueClosed(sync, issue) {
  const itemId = await sync.addItem(issue.node_id);
  if (['not_planned', 'duplicate'].includes(issue.state_reason)) return sync.archive(itemId);
  await sync.setStatus(itemId, STATUS.done);
  await sync.setIteration(itemId, todayInSeoul());
}

// PR을 열 때 브랜치 이름의 이슈 번호로 이슈를 찾아 진행 중, 빈 시작일 · 주차 · 담당자를 채운다
// (예전엔 브랜치 생성 이벤트에서 했는데, 10초짜리 실행이 브랜치마다 1분씩 청구돼서 PR 열 때로 옮김 #514)
async function startBranchIssue(sync, ref, sender, { github, context, core }) {
  const match = BRANCH_ISSUE.exec(ref);
  if (!match) return core.info(`브랜치 ${ref} 에 이슈 번호가 없어 건너뜁니다.`);
  const number = Number(match[1]);

  let issue;
  try {
    ({ data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: number }));
  } catch {
    return core.warning(`브랜치 ${ref} 의 #${number} 이슈를 찾지 못했어요.`);
  }
  if (issue.pull_request || issue.state !== 'open') return;

  const itemId = await sync.addItem(issue.node_id);
  await sync.moveForward(itemId, STATUS.inProgress);

  const today = todayInSeoul();
  const start = (await sync.readValue(itemId, '시작일'))?.date;
  if (!start) await sync.setDate(itemId, '시작일', today);
  if (!(await sync.readValue(itemId, '주차'))?.iterationId) await sync.setIteration(itemId, start || today);

  if (!issue.assignees?.length && sender?.type === 'User') {
    await github.rest.issues.addAssignees({ ...context.repo, issue_number: number, assignees: [sender.login] });
  }
}

// PR: 이슈를 닫는 PR(Closes #번호)은 그 이슈 카드를, 아닌 PR은 PR 자체를 카드로 움직인다.
//   처음 열림 → 브랜치 이름의 이슈를 먼저 진행 중으로(빈 시작일 · 주차 · 담당자 채움)
//   열림 · 다시 열림 · 초안 해제 → 이슈 카드 리뷰 / PR 카드 리뷰(초안이면 진행 중)
//   머지 → 완료, 머지 없이 닫힘 → 이슈 카드 다시 진행 중 / PR 카드 보관
// 열 때: 이슈의 파트 라벨을 PR에, 빈 담당자는 PR 작성자(초안 포함),
//        닫는 이슈가 없으면 브랜치 이름의 이슈 번호를 본문에 '관련 이슈 #번호'로 단다.
async function onPullRequest(sync, payload, { github, context, core, board, prClient }) {
  const { action, pull_request: pr } = payload;
  const opening = ['opened', 'reopened', 'ready_for_review'].includes(action) && pr.state === 'open';
  const closing = action === 'closed';
  if (!opening && !closing) return;

  const { issues, card } = await loadPullRequest(github, context, board, pr.number);
  const human = pr.user?.type === 'User';

  // 리뷰로 옮기기 전에 진행 중을 먼저 거쳐 둠 — 아래에서 닫는 이슈면 리뷰로, 아니면(관련 이슈) 진행 중으로 남음
  // 예전엔 따로 돌던 실행이라, 여기서 실패해도(담당자 지정 422 등) 아래 PR 처리는 그대로 함
  if (action === 'opened' && human) {
    try {
      await startBranchIssue(sync, pr.head?.ref ?? '', pr.user, { github, context, core });
    } catch (error) {
      core.warning(`브랜치 이슈를 진행 중으로 옮기지 못했어요: ${error.message}`);
    }
  }

  let status = null;
  if (opening && !pr.draft) status = STATUS.review;
  else if (closing) status = pr.merged ? STATUS.done : STATUS.inProgress;
  for (const issue of status ? issues : []) {
    if (status !== STATUS.done && issue.state !== 'OPEN') continue;
    const itemId = await sync.addItem(issue.id);
    await sync.setStatus(itemId, status);
  }

  // PR 카드: 닫는 이슈가 없는 사람 PR. 이미 카드가 있으면(나중에 Closes를 적은 경우 등) 그 카드도 마저 옮긴다.
  if (human && (issues.length === 0 || card)) await syncPullRequestCard(sync, pr, card, { opening });

  if (opening) await fillPullRequest(pr, issues, { github, context, human });
  if (opening && human && issues.length === 0) await linkBranchIssue(pr, { github, context, core, prClient });
}

async function loadPullRequest(github, context, board, number) {
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
          projectItems(first: 10, includeArchived: true) {
            nodes { id isArchived project { id } }
          }
        }
      }
    }`,
    { ...context.repo, number },
  );
  const { closingIssuesReferences, projectItems } = repository.pullRequest;
  const card = projectItems.nodes.find((item) => item.project.id === board.id) ?? null;
  return { issues: closingIssuesReferences.nodes, card };
}

// PR 카드. 처음 올릴 때 파트(제목 머리말) · 시작일(PR 연 날) · 주차를 채우고,
// 머지되면 완료 + 목표일 · 주차를 머지한 날로('한 일' 보기가 주차로 묶임), 그냥 닫히면 보관.
async function syncPullRequestCard(sync, pr, card, { opening }) {
  if (!opening && !pr.merged) {
    if (card && !card.isArchived) await sync.archive(card.id);
    return;
  }
  const itemId = card?.id ?? (await sync.addItem(pr.node_id));
  if (card?.isArchived) await sync.unarchive(itemId);

  if (!card) {
    const part = partFromTitle(pr.title);
    if (part) await sync.setOption(itemId, '파트', (name) => name === part);
    const start = seoulDate(pr.created_at);
    await sync.setDate(itemId, '시작일', start);
    await sync.setIteration(itemId, start);
  }

  if (opening) return sync.setStatus(itemId, pr.draft ? STATUS.inProgress : STATUS.review);
  const merged = seoulDate(pr.merged_at);
  await sync.setStatus(itemId, STATUS.done);
  await sync.setDate(itemId, '목표일', merged);
  await sync.setIteration(itemId, merged);
}

// 닫는 이슈 없이 연 PR: 브랜치 이름(feat/12-...)의 번호가 이슈면 본문에 '관련 이슈 #12'를 단다.
// Closes는 자동으로 넣지 않는다 — PR 여러 개가 붙는 이슈(#42 등)가 첫 PR 머지 때 닫혀 버려서.
// 비어 있는 'Closes #' 줄이 있으면 그 줄을 바꾸고, 본문에 이미 그 번호가 있거나 번호가 PR이면 건너뛴다.
// 본문은 고치기 직전에 다시 읽는다 — 이벤트에 실린 본문은 PR을 연 순간 것이라, 그 사이 작성자가 적은 Closes를 덮어쓸 수 있어서.
async function linkBranchIssue(pr, { github, context, core, prClient }) {
  const match = BRANCH_ISSUE.exec(pr.head?.ref ?? '');
  if (!match) return;
  const number = Number(match[1]);
  const mentioned = new RegExp(`#${number}(?!\\d)`);
  if (mentioned.test(pr.body ?? '') || mentioned.test(pr.title)) return;

  let issue;
  try {
    ({ data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: number }));
  } catch {
    return core.info(`브랜치 ${pr.head.ref} 의 #${number} 를 찾지 못해 연결을 건너뜁니다.`);
  }
  if (issue.pull_request) return;

  const { data: latest } = await github.rest.pulls.get({ ...context.repo, pull_number: pr.number });
  const body = latest.body ?? '';
  if (mentioned.test(body) || mentioned.test(latest.title)) return;

  const line = `관련 이슈 #${number} <!-- 브랜치 이름에서 자동 연결. 이 PR로 이슈를 닫으려면 Closes #${number} 로 바꿔 주세요 -->`;
  const next = EMPTY_CLOSES.test(body) ? body.replace(EMPTY_CLOSES, line) : `${body.trimEnd()}\n\n${line}`.trimStart();
  await prClient.rest.pulls.update({ ...context.repo, pull_number: pr.number, body: next });
}

// 파트 라벨(릴리즈 노트 분류용)과 담당자(보드 카드에 누가 하는지 보이게).
// 이미 있으면 건드리지 않으므로 PR을 고쳐서 다시 돌아도 같은 결과다. 봇 PR은 라벨만.
async function fillPullRequest(pr, issues, { github, context, human }) {
  const { owner, repo } = context.repo;
  const ours = issues.filter((issue) => issue.repository.nameWithOwner === `${owner}/${repo}`);

  const current = (pr.labels ?? []).map((l) => l.name);
  const parts = new Set();
  for (const issue of ours) {
    for (const { name } of issue.labels.nodes) if (PART_LABELS.includes(name)) parts.add(name);
  }
  const missing = [...parts].filter((name) => !current.includes(name));
  if (missing.length) await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: missing });

  if (!human) return;
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

  const setStatus = (itemId, keyword) => setOption(itemId, 'Status', (name) => name.includes(keyword));

  const readValue = async (itemId, fieldName) => {
    const { node } = await github.graphql(
      `query($id: ID!, $name: String!) {
        node(id: $id) {
          ... on ProjectV2Item {
            fieldValueByName(name: $name) {
              ... on ProjectV2ItemFieldDateValue { date }
              ... on ProjectV2ItemFieldIterationValue { iterationId }
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
        }
      }`,
      { id: itemId, name: fieldName },
    );
    return node?.fieldValueByName ?? null;
  };

  const stage = (name) => FLOW.findIndex((word) => name.includes(word));

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
    setStatus,
    readValue,
    async moveForward(itemId, keyword) {
      const current = (await readValue(itemId, 'Status'))?.name;
      if (current && stage(current) >= stage(keyword)) return;
      await setStatus(itemId, keyword);
    },
    setDate: (itemId, fieldName, date) => update(itemId, fieldName, { date }),
    async setIteration(itemId, date) {
      const config = board.field('주차')?.configuration;
      const iterations = [...(config?.iterations ?? []), ...(config?.completedIterations ?? [])];
      const iteration = iterations.find((it) => isWithin(date, it.startDate, it.duration));
      if (iteration) await update(itemId, '주차', { iterationId: iteration.id });
    },
    async archive(itemId) {
      await github.graphql(
        `mutation($projectId: ID!, $itemId: ID!) {
          archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { item { id } }
        }`,
        { projectId: board.id, itemId },
      );
    },
    async unarchive(itemId) {
      await github.graphql(
        `mutation($projectId: ID!, $itemId: ID!) {
          unarchiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { item { id } }
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

// "[WIP] [FE] [FEAT] ..." → FE. 머리말이 없거나 [ALL]뿐이면 null
function partFromTitle(title) {
  for (const [, tag] of (title ?? '').matchAll(/\[([A-Za-z]+)\]/g)) {
    const part = TITLE_PARTS[tag.toUpperCase()];
    if (part) return part;
  }
  return null;
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
  return seoulDate(new Date());
}

// ISO 시각(PR created_at · merged_at) → 서울 날짜 YYYY-MM-DD
function seoulDate(time) {
  return new Date(time).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

module.exports.parseForm = parseForm;
module.exports.parseDate = parseDate;
module.exports.pick = pick;
module.exports.partFromTitle = partFromTitle;
module.exports.seoulDate = seoulDate;
module.exports.BRANCH_ISSUE = BRANCH_ISSUE;
