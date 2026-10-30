// Node 모듈 해석 훅 — 앱(mobile/src) 파일을 앱 코드를 고치지 않고 Node에서 그대로 불러오려고 둠.
//   앱 파일은 번들러(Metro)가 해석해 주는 import를 쓴다:
//     · '@/lib/format'          → mobile/src/lib/format   (tsconfig paths)
//     · '@shared/calc/order.ts' → supabase/functions/_shared/calc/order.ts
//     · './constants'           → 확장자 없는 상대 경로 (.ts / /index.ts 를 붙여 찾음)
//   Node는 이 셋을 모르므로 이 훅이 풀어 줌. 외부 패키지는 쓰지 않음 (node:module 의 register).
//   또 하나: 앱 파일 중 순수 함수와 DB 호출이 한 파일에 같이 있는 것(예: features/alarm/participantTimes.ts의 judgeArrival 은
//   같은 파일에서 '@/lib/supabase'를 불러옴)은 supabase 클라이언트(expo/AsyncStorage에 닿음)가 Node에서 안 떠서
//   껍데기(stubs/)로 바꿔 끼움 — 껍데기를 부르는 함수(recordParticipantTimes 등)는 일부러 던지게 해 둠. 순수 함수만 부를 것.
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let ROOT = '';
let STUBS_DIR = '';

export function initialize(data) {
  ROOT = data.root;
  STUBS_DIR = data.stubsDir;
}

// 껍데기로 바꿀 모듈 (앱 별칭 그대로 적음)
const STUBS = {
  '@/lib/supabase': 'stubs/supabase.ts',
  '@/lib/user': 'stubs/user.ts',
};

function aliasToPath(specifier) {
  if (specifier.startsWith('@/')) return resolvePath(ROOT, 'mobile/src', specifier.slice(2));
  if (specifier.startsWith('@shared/')) return resolvePath(ROOT, 'supabase/functions/_shared', specifier.slice('@shared/'.length));
  return null;
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// 확장자 없는 경로 → .ts / /index.ts 를 붙여 실제 파일을 찾음
function withExtension(p) {
  if (isFile(p)) return p;
  for (const candidate of [`${p}.ts`, `${p}.tsx`, resolvePath(p, 'index.ts')]) if (isFile(candidate)) return candidate;
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (STUBS[specifier]) {
    return { url: pathToFileURL(resolvePath(STUBS_DIR, STUBS[specifier])).href, shortCircuit: true };
  }
  let path = aliasToPath(specifier);
  if (path === null && (specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    const parent = fileURLToPath(context.parentURL);
    // 앱 · 서버 소스 안의 확장자 없는 상대 경로만 손댐 (그 밖은 Node 기본 해석)
    if (parent.startsWith(resolvePath(ROOT, 'mobile/src')) || parent.startsWith(resolvePath(ROOT, 'supabase'))) path = resolvePath(dirname(parent), specifier);
  }
  if (path !== null) {
    const found = withExtension(path);
    if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
