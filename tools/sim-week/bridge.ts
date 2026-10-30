// 팀 레포의 L1(계산) · L2(위치 판정) 순수 함수를 한 곳에서 불러오는 다리. 다시 만들지 않고 그대로 부름.
//   · L1: supabase/functions/_shared/calc/* · plan-core.ts · route.ts (서버 · 앱이 같이 쓰는 순수 TS)
//   · L2: mobile/src/features/location/* · features/alarm/participantTimes.ts · adjust.ts (@/ 별칭을 씀)
//     → loader.mjs 를 먼저 등록해야 뜨므로 정적 import 대신 등록 뒤 동적 import (최상위 await)
// 앱 루트(APP_ROOT): 기본은 이 하네스가 든 레포. `--app-root <경로>` 또는 env SIM_APP_ROOT 로 다른 체크아웃(예: PR 브랜치를 합친 임시 worktree)을 가리키면
//   그 코드의 계산 · 판정 함수를 부름. AI 호출 관문(_shared/ai · prompts)은 하네스 레포 것을 씀 (#248).
// 앱 코드는 한 줄도 안 고침. 못 부르는 것은 docs.md 의 "불러올 수 없음" 표.
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../..');

function appRootFromArgs(): string {
  const i = process.argv.indexOf('--app-root');
  const given = (i >= 0 ? process.argv[i + 1] : undefined) ?? process.env.SIM_APP_ROOT;
  const root = given ? resolve(given) : REPO;
  if (!existsSync(resolve(root, 'mobile/src')) || !existsSync(resolve(root, 'supabase/functions/_shared'))) throw new Error(`--app-root 가 앱 체크아웃이 아님: ${root}`);
  return root;
}
export const APP_ROOT = appRootFromArgs();

// 레포 맨 위 package.json 에 "type"이 없어서 서버 · 앱 .ts 를 불러올 때마다 나오는 경고만 거름 (다른 경고는 그대로 보임)
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if ((w as NodeJS.ErrnoException).code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  console.error(`(node) ${w.name}: ${w.message}`);
});

register('./loader.mjs', { parentURL: import.meta.url, data: { root: APP_ROOT, stubsDir: HERE } });

const at = (p: string) => new URL(`file:///${resolve(APP_ROOT, p).replace(/\\/g, '/')}`).href;
const opt = async (p: string) => (existsSync(resolve(APP_ROOT, p)) ? await import(at(p)) : null);

// ---- L1 (서버 공용 계산) ----
export const calc = await import(at('supabase/functions/_shared/calc/index.ts'));
export const planCore = await import(at('supabase/functions/_shared/plan-core.ts'));
export const route = await import(at('supabase/functions/_shared/route.ts'));

// ---- 앱 쪽 순수 함수 ----
export const adjust = await import(at('mobile/src/features/alarm/adjust.ts'));
export const participantTimes = await import(at('mobile/src/features/alarm/participantTimes.ts'));
export const geoState = await import(at('mobile/src/features/location/transitions.ts'));
export const geoRegions = await import(at('mobile/src/features/location/regions.ts'));
export const geoArea = await import(at('mobile/src/features/location/area.ts'));
export const geoConst = await import(at('mobile/src/features/location/constants.ts'));
export const geoGeo = await import(at('mobile/src/features/location/geo.ts'));
export const geoAttach = await import(at('mobile/src/features/location/attach.ts'));
// ---- 서버 대화 순수부 (#248): 카드 · 정정 · 서버 질문 고르기(turn-core) + 문맥 만들기(context-core). 모델은 안 부름 ----
export const aiTurn = await import(at('supabase/functions/_shared/ai/turn-core.ts'));
export const aiContext = await import(at('supabase/functions/_shared/ai/context-core.ts'));
export const aiTypes = await import(at('supabase/functions/_shared/ai/types.ts'));
// PR 코드에만 있는 것 (없으면 null) — 예: #240 location/real.ts(listEarlierDepartures), alarm/oneTap 등
export const geoReal = await opt('mobile/src/features/location/real.ts').catch(() => null);

// 보고서 칸 "main 코드 / PR 코드": 앱 루트가 하네스 레포가 아니면 PR 코드로 봄
export const CODE_SOURCE = APP_ROOT === REPO ? 'main 코드' : `PR 코드 (${APP_ROOT})`;
