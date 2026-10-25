// 커버리지 요약 — jest --coverage가 만든 coverage/coverage-summary.json을 폴더별 표(마크다운)로 찍음 (#198)
//   폴더 = src/features/<기능> 은 기능 하나씩, 나머지는 src/<폴더> 한 칸 (app · lib · components …)
//   로컬: npm run test:cov / 앱 검사(ci.yml): 실행 요약에 이 표를 붙임
//   기준선(이하이면 실패)은 아직 없음. 숫자를 보고 정함
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

const file = process.argv[2] ?? 'coverage/coverage-summary.json';
const summary = JSON.parse(readFileSync(file, 'utf8'));
const KEYS = ['lines', 'functions', 'branches'];

function group(path) {
  const parts = relative(process.cwd(), path).split(sep);
  return parts[1] === 'features' ? parts.slice(0, 3).join('/') : parts.slice(0, 2).join('/');
}

const groups = new Map();
for (const [path, stats] of Object.entries(summary)) {
  if (path === 'total') continue;
  const name = group(path);
  const g = groups.get(name) ?? { files: 0, ...Object.fromEntries(KEYS.map((k) => [k, { covered: 0, total: 0 }])) };
  g.files += 1;
  for (const k of KEYS) {
    g[k].covered += stats[k].covered;
    g[k].total += stats[k].total;
  }
  groups.set(name, g);
}

const pct = ({ covered, total }) => (total === 0 ? '-' : `${((covered / total) * 100).toFixed(0)}%`);

const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
console.log('| 폴더 | 파일 | 줄 | 함수 | 갈래 |');
console.log('|---|--:|--:|--:|--:|');
for (const [name, g] of rows) console.log(`| \`${name}\` | ${g.files} | ${KEYS.map((k) => pct(g[k])).join(' | ')} |`);
const t = summary.total;
console.log(`| 전체 | ${rows.reduce((n, [, g]) => n + g.files, 0)} | ${KEYS.map((k) => pct(t[k])).join(' | ')} |`);
