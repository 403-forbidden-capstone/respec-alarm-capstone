// 팀 레포의 L1(계산) · L2(위치 판정) 순수 함수를 한 곳에서 불러오는 다리. 다시 만들지 않고 그대로 부름.
//   · L1: supabase/functions/_shared/calc/* · plan-core.ts · route.ts (서버 · 앱이 같이 쓰는 순수 TS — 별칭 없이 Node에서 바로 뜸)
//   · L2: mobile/src/features/location/* (@/lib/format · @/lib/uuid 별칭을 씀) · features/alarm/participantTimes.ts · adjust.ts
//     → tools/sim-week/loader.mjs 를 먼저 등록해야 뜨므로 정적 import 대신 등록 뒤 동적 import (최상위 await)
// 앱 코드는 한 줄도 안 고침. 못 부르는 것은 docs.md 의 "불러올 수 없음" 표.
import { register } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../..');

// 레포 맨 위 package.json 에 "type"이 없어서 서버 · 앱 .ts 를 불러올 때마다 나오는 경고만 거름 (다른 경고는 그대로 보임)
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if ((w as NodeJS.ErrnoException).code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  console.error(`(node) ${w.name}: ${w.message}`);
});

register('./loader.mjs', { parentURL: import.meta.url, data: { root: REPO } });

const at = (p: string) => new URL(`../../${p}`, import.meta.url).href;

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
