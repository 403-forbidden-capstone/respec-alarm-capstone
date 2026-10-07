// 빌드 때 GitHub 보드 · PR · main 파일 목록을 읽어 dist/board-snapshot.json으로 남깁니다.
// 배포된 /board가 이 파일을 먼저 읽으므로, main에 머지될 때마다 할 일 탭이 그 시점으로 갱신됩니다.
//   토큰: 환경 변수 BOARD_GITHUB_TOKEN (fine-grained 읽기 전용: 이 레포 Contents · Issues · Pull requests, 조직 Projects)
//   토큰이 없거나 실패하면 파일을 만들지 않고 종료 코드 0 — 빌드는 막지 않습니다.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORG = '403-forbidden-capstone';
const REPO = 'respec-alarm-capstone';
const PROJECT = 1;
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', process.env.BOARD_SNAPSHOT_DIR || 'dist');
const token = process.env.BOARD_GITHUB_TOKEN; // Actions의 GITHUB_TOKEN은 조직 Projects 권한이 없어 대신 쓰지 않음

if (!token) {
  console.log('board-snapshot: BOARD_GITHUB_TOKEN 없음 → 스냅샷 건너뜀 (HTML 안 스냅샷 사용)');
  process.exit(0);
}

// 아래 질의 · 매핑은 mobile/public/board.html의 GQL · sync()와 같은 모양이어야 함 — 한쪽을 고치면 둘 다
const GQL = `query($org:String!,$repo:String!,$num:Int!){
  organization(login:$org){ projectV2(number:$num){ items(first:100){ nodes{
    fieldValues(first:20){ nodes{
      ... on ProjectV2ItemFieldSingleSelectValue{ field{ ... on ProjectV2FieldCommon{ name } } name }
      ... on ProjectV2ItemFieldDateValue{ field{ ... on ProjectV2FieldCommon{ name } } date } } }
    content{ ... on Issue{ number title state milestone{ title } labels(first:10){ nodes{ name } } } } } } } }
  repository(owner:$org,name:$repo){ pullRequests(first:50,states:[OPEN],orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{
    number title isDraft headRefName reviewDecision closingIssuesReferences(first:5){ nodes{ number } }
    commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } } } } } }`;

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'respec-board-snapshot' };

try {
  const gr = await fetch('https://api.github.com/graphql', {
    method: 'POST', headers, body: JSON.stringify({ query: GQL, variables: { org: ORG, repo: REPO, num: PROJECT } }),
  });
  if (!gr.ok) throw new Error(`GitHub ${gr.status} ${gr.statusText}`);
  const g = await gr.json();
  if (g.errors) throw new Error(g.errors.map((e) => e.message).join('; '));

  const items = g.data.organization.projectV2.items.nodes.map((it) => {
    const fv = {};
    for (const v of it.fieldValues.nodes) if (v.field) fv[v.field.name] = v.name ?? v.date;
    const c = it.content || {};
    return {
      n: c.number, t: c.title || '', st: c.state || 'DRAFT', status: fv['Status'], ms: c.milestone && c.milestone.title,
      start: fv['시작일'], due: fv['목표일'], part: fv['파트'], labels: c.labels ? c.labels.nodes.map((l) => l.name) : [],
    };
  });
  const prs = g.data.repository.pullRequests.nodes.map((p) => ({
    number: p.number, title: p.title, state: 'OPEN', draft: p.isDraft, branch: p.headRefName, review: p.reviewDecision,
    closes: p.closingIssuesReferences.nodes.map((x) => x.number),
    checks: p.commits.nodes[0]?.commit?.statusCheckRollup?.state || null,
  }));

  if (items.length >= 100) console.log('board-snapshot: 경고 — 카드가 100개에 닿음. 넘는 카드는 빠짐 (pageInfo 처리 필요, board.html 질의도 같이)');
  // 파일 목록은 못 읽으면 null → 보드에서 "없음"이 아니라 "모름"으로 보임 (브라우저 동기화와 같은 규칙)
  const tr = await fetch(`https://api.github.com/repos/${ORG}/${REPO}/git/trees/main?recursive=1`, { headers });
  const t = tr.ok ? await tr.json() : null;
  const tree = t && t.tree ? t.tree.filter((x) => x.type === 'blob').map((x) => x.path)
    .filter((p) => p.startsWith('mobile/src/') || p.startsWith('supabase/') || p.startsWith('docs/')) : null;
  if (!tree) console.log(`board-snapshot: 파일 목록 못 읽음 (${tr.status}) → tree 없이 저장`);

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, 'board-snapshot.json');
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), items, prs, tree }));
  console.log(`board-snapshot: 카드 ${items.length} · PR ${prs.length} · 파일 ${tree ? tree.length : '없음'} → ${out}`);
} catch (e) {
  console.log(`board-snapshot: 실패 (${e.message}) → 스냅샷 건너뜀`);
}
process.exit(0);
