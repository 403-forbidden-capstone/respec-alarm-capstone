// mobile/src 모듈 의존 그래프를 SVG로 그리고, 순환 의존을 검사합니다.
//   npm run graph   → out/deps.svg · out/deps.json
//   npm run check   → 순환 의존이 있으면 실패(종료 코드 1)
// Graphviz 설치 없이 wasm(@viz-js/viz)으로 그립니다.

import madge from 'madge';
import { instance } from '@viz-js/viz';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '../../mobile');
const src = resolve(mobile, 'src');
const outDir = resolve(here, 'out');
const checkOnly = process.argv.includes('--check');

// `@/` 같은 별칭은 mobile/tsconfig.json의 paths를 그대로 쓰되, madge가 풀 수 있게 baseUrl을 붙임
const mobileTsconfig = JSON.parse(readFileSync(resolve(mobile, 'tsconfig.json'), 'utf8'));
const tsConfig = {
  compilerOptions: {
    baseUrl: mobile,
    paths: Object.fromEntries(
      Object.entries(mobileTsconfig.compilerOptions?.paths ?? {}).map(([k, v]) => [
        k,
        v.map((p) => p.replace(/^\.\//, '')),
      ]),
    ),
    module: 'esnext',
    moduleResolution: 'bundler',
    jsx: 'react-jsx',
    allowJs: true,
  },
};

// 맨 위 폴더별 색. 새 폴더는 회색
const GROUP_COLORS = {
  app: '#E6F1FB',
  components: '#EEEDFE',
  features: '#E1F5EE',
  lib: '#FAEEDA',
  theme: '#FBEAF0',
  hooks: '#FAECE7',
  mocks: '#F1EFE8',
};

const result = await madge(src, {
  fileExtensions: ['ts', 'tsx'],
  tsConfig,
  excludeRegExp: [/\.d\.ts$/],
  detectiveOptions: {
    ts: { skipTypeImports: true },
    tsx: { skipTypeImports: true },
  },
});

const graph = result.obj();
const cycles = result.circular();
const modules = Object.keys(graph).sort();
const edgeCount = modules.reduce((n, m) => n + graph[m].length, 0);

console.log(`모듈 ${modules.length}개 · 의존 ${edgeCount}개 · 순환 ${cycles.length}개`);
for (const cycle of cycles) console.log('  순환:', cycle.join(' → '));

// 경로를 못 푼 import(예: tsconfig paths가 틀어져 `@/` 별칭이 안 풀릴 때)는 그래프에서 조용히 빠지므로 check에서는 실패로 침
const skipped = result.warnings().skipped;
if (skipped.length) console.log(`  경로를 못 푼 import ${skipped.length}개:`, skipped.join(', '));

if (checkOnly) {
  process.exit(cycles.length || skipped.length ? 1 : 0);
}

const groupOf = (m) => (m.includes('/') ? m.split('/')[0] : '(root)');
const label = (m) => m.replace(/\.(tsx?|js)$/, '');
const id = (m) => JSON.stringify(m);
const inCycle = new Set(cycles.flat());
// 순환을 이루는 화살표만 빨갛게: 순환마다 이웃한 쌍(마지막 → 첫 번째 포함)
const cycleEdges = new Set(cycles.flatMap((c) => c.map((m, k) => `${m}\0${c[(k + 1) % c.length]}`)));

const groups = new Map();
for (const m of modules) {
  const g = groupOf(m);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(m);
}

const lines = [
  'digraph deps {',
  '  rankdir=LR; splines=true; nodesep=0.25; ranksep=0.9;',
  '  node [shape=box, style="rounded,filled", fontname="Pretendard, Helvetica", fontsize=11, color="#B4B2A9"];',
  '  edge [color="#888780", arrowsize=0.7];',
];
let i = 0;
for (const [g, members] of groups) {
  const fill = GROUP_COLORS[g] ?? '#F1EFE8';
  lines.push(`  subgraph cluster_${i++} { label="${g}"; style="rounded"; color="#D3D1C7"; fontname="Pretendard, Helvetica"; fontsize=12;`);
  for (const m of members) {
    const extra = inCycle.has(m) ? ', color="#E24B4A", penwidth=2' : '';
    lines.push(`    ${id(m)} [label="${label(m)}", fillcolor="${fill}"${extra}];`);
  }
  lines.push('  }');
}
for (const m of modules) {
  for (const dep of graph[m]) {
    const red = cycleEdges.has(`${m}\0${dep}`) ? ' [color="#E24B4A"]' : '';
    lines.push(`  ${id(m)} -> ${id(dep)}${red};`);
  }
}
lines.push('}');
const dot = lines.join('\n');

const viz = await instance();
const svg = viz.renderString(dot, { format: 'svg' });

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'deps.svg'), svg);
writeFileSync(resolve(outDir, 'deps.dot'), dot);
writeFileSync(
  resolve(outDir, 'deps.json'),
  JSON.stringify({ generatedFrom: 'mobile/src', modules: graph, cycles }, null, 2),
);
console.log(`저장: tools/deps-graph/out/deps.svg (${Math.round(svg.length / 1024)}KB), deps.json`);
