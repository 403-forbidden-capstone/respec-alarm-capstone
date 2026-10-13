// docs/decisions.md(결정 안건)를 읽어 개발 보드의 DECISIONS 자리와 결정 안건 페이지(/decisions)의 DATA 자리에 JSON으로 넣습니다.
//   node scripts/board-decisions.mjs        → public/board.html · public/decisions/index.html (커밋용 · 로컬 npm run web)
//   node scripts/board-decisions.mjs dist   → dist/ 같은 두 파일 (웹 빌드 끝에 — 배포된 /board · /decisions가 늘 문서와 같게)
// 문서 모양은 docs/decisions.md 맨 아래 "쓰는 법". 모르는 줄은 건너뜀.
// dist는 실패해도 종료 코드 0 — 빌드는 막지 않음 (그때는 커밋된 DECISIONS가 그대로 나감)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const docPath = resolve(here, '..', '..', 'docs', 'decisions.md');
const toDist = process.argv[2] === 'dist';
const htmlPath = resolve(here, '..', toDist ? 'dist' : 'public', 'board.html');
const pagePath = resolve(here, '..', toDist ? 'dist' : 'public', 'decisions', 'index.html');
const SECTIONS = ['정할 것', '보류', '정한 것'];

export function parseDecisions(md) {
  const out = [];
  let status = null; // 지금 ## 섹션 (SECTIONS 밖이면 null → 아래 ###는 무시)
  let cur = null;    // 지금 ### 안건
  let block = null;  // 지금 #### 칸
  let inComment = false;
  const last = () => block.parts[block.parts.length - 1];
  const ensureBlock = () => { if (!block) { block = { h: '', parts: [] }; cur.blocks.push(block); } };

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }
    if (line.trim().startsWith('<!--')) { if (!line.includes('-->')) inComment = true; continue; }

    let m;
    if ((m = /^## (.+)$/.exec(line))) { status = SECTIONS.includes(m[1].trim()) ? m[1].trim() : null; cur = null; block = null; continue; }
    if ((m = /^### (D\d+)\s+(.+)$/.exec(line))) {
      if (!status) { cur = null; continue; }
      cur = { id: m[1], title: m[2].trim(), status, meta: {}, blocks: [] }; block = null; out.push(cur); continue;
    }
    if (!cur || !line.trim()) continue;
    if ((m = /^#### (.+)$/.exec(line))) { block = { h: m[1].trim(), parts: [] }; cur.blocks.push(block); continue; }
    // 칸 앞 "- 키: 값" = 안건 머리 정보
    if (!block && (m = /^- ([^:*`]+?):\s*(.*)$/.exec(line))) { cur.meta[m[1].trim()] = m[2].trim(); continue; }
    ensureBlock();
    // 선택지: - **A. 이름** (꼬리표) — 설명
    if ((m = /^- \*\*([A-Z])\.\s*(.+?)\*\*\s*(?:\(([^)]+)\))?\s*(?:[—–-]\s*(.*))?$/.exec(line))) {
      const opt = { key: m[1], name: m[2].trim(), tag: (m[3] || '').trim(), desc: (m[4] || '').trim(), sub: [] };
      if (last() && last().t === 'opts') last().v.push(opt); else block.parts.push({ t: 'opts', v: [opt] });
      continue;
    }
    // 들여 쓴 줄: 바로 앞 선택지 · 목록에 붙임
    if ((m = /^\s{2,}- (.+)$/.exec(line)) && last()) {
      const p = last();
      if (p.t === 'opts') p.v[p.v.length - 1].sub.push(m[1].trim());
      else if (p.t === 'ul') p.v[p.v.length - 1] += ' — ' + m[1].trim();
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      if (/^\|[\s:|-]+\|$/.test(line)) continue; // | --- | 줄
      const cells = line.slice(1, -1).split('|').map((c) => c.trim());
      if (last() && last().t === 'table') last().rows.push(cells); else block.parts.push({ t: 'table', head: cells, rows: [] });
      continue;
    }
    if ((m = /^- (.+)$/.exec(line))) { if (last() && last().t === 'ul') last().v.push(m[1].trim()); else block.parts.push({ t: 'ul', v: [m[1].trim()] }); continue; }
    if (last() && last().t === 'p') last().v += ' ' + line.trim(); else block.parts.push({ t: 'p', v: line.trim() });
  }
  return out;
}

function main() {
  const md = readFileSync(docPath, 'utf8');
  const list = parseDecisions(md);
  const seen = new Set();
  for (const d of list) { if (seen.has(d.id)) console.warn(`board-decisions: 번호 ${d.id}가 두 번 나옴`); seen.add(d.id); }
  if (!existsSync(htmlPath)) throw new Error(`${htmlPath} 없음`);
  const html = readFileSync(htmlPath, 'utf8');
  // </script>가 끼면 HTML이 깨지므로 <는 <로
  const json = JSON.stringify(list).replace(/</g, '\\u003c');
  const re = /^const DECISIONS = .*;$/m;
  if (!re.test(html)) throw new Error('board.html에 "const DECISIONS = …;" 줄이 없음');
  const next = html.replace(re, () => `const DECISIONS = /*DECISIONS*/${json};`);
  if (next !== html) writeFileSync(htmlPath, next);
  const n = (s) => list.filter((d) => d.status === s).length;
  console.log(`board-decisions: ${toDist ? 'dist' : 'public'}/board.html ← 정할 것 ${n('정할 것')} · 보류 ${n('보류')} · 정한 것 ${n('정한 것')}${next === html ? ' (그대로)' : ''}`);
  writePage(json);
}

// 결정 안건 페이지(/decisions) — 안건이 바뀔 때만 DATA와 날짜(BUILT)를 고침 (내용이 같으면 파일 그대로)
function writePage(json) {
  if (!existsSync(pagePath)) { console.warn('board-decisions: decisions/index.html 없음 — 건너뜀'); return; }
  const html = readFileSync(pagePath, 'utf8');
  const re = /^const DATA = .*;$/m;
  if (!re.test(html)) throw new Error('decisions/index.html에 "const DATA = …;" 줄이 없음');
  const line = `const DATA = /*DATA*/${json};`;
  if (html.match(re)[0] === line) { console.log(`board-decisions: ${toDist ? 'dist' : 'public'}/decisions/index.html (그대로)`); return; }
  const built = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });
  const next = html.replace(re, () => line).replace(/^const BUILT = .*;$/m, () => `const BUILT = /*BUILT*/${JSON.stringify(built)};`);
  writeFileSync(pagePath, next);
  console.log(`board-decisions: ${toDist ? 'dist' : 'public'}/decisions/index.html ← ${built}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) {
    console.error('board-decisions: ' + e.message);
    process.exit(toDist ? 0 : 1);
  }
}
