// 실서버 배포 확인 (읽기만) — 알람 조정 제안 서버 함수 두 개가 올라가 있는지. 데이터는 하나도 안 건드리고 키도 안 씀
//   키 없이 부르면: 올라가 있으면 거절(suggestion-apply 401 · suggestion-generate 403), 없으면 404
//   주소: SUPABASE_URL → mobile/.env의 EXPO_PUBLIC_SUPABASE_URL → mobile/.env.production. 주소만 찍고 다른 값은 안 읽음
// 실행: node tools/suggest-e2e/deploy-check.mjs  (레포 맨 위에서, 패키지 설치 필요 없음)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fromFile = (p) => {
  if (!existsSync(p)) return null;
  const m = /^\s*EXPO_PUBLIC_SUPABASE_URL\s*=\s*['"]?([^'"\s]+)/m.exec(readFileSync(p, 'utf8'));
  return m?.[1] ?? null;
};
const url = (process.env.SUPABASE_URL || fromFile(join(ROOT, 'mobile', '.env')) || fromFile(join(ROOT, 'mobile', '.env.production')) || '').replace(/\/$/, '');
if (!url) {
  console.error('서버 주소를 못 찾음 — SUPABASE_URL을 주거나 mobile/.env에 EXPO_PUBLIC_SUPABASE_URL이 있어야 함');
  process.exit(1);
}
console.log(`서버: ${url}\n`);

const checks = [
  ['suggestion-generate', [403], '저녁 제안 배치 (서비스 키만)'],
  ['suggestion-apply', [401, 403], '제안 적용 (로그인 토큰만)'],
];
let missing = 0;
for (const [name, deployed, what] of checks) {
  const res = await fetch(`${url}/functions/v1/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch((e) => ({ status: 0, error: e.message }));
  const ok = deployed.includes(res.status);
  if (!ok) missing += 1;
  console.log(`${ok ? '있음' : res.status === 404 ? '없음' : '확인 필요'}  ${name} — ${what} (HTTP ${res.status}${res.error ? ` ${res.error}` : ''})`);
}
console.log(missing ? '\n올라가지 않은 함수가 있음 — 배포는 지형님 확인 (DB 마이그레이션 · 18:00 예약은 이 확인으로 못 봄)' : '\n두 함수 모두 실서버에 있음 (DB 마이그레이션 · 18:00 예약은 이 확인으로 못 봄)');
process.exit(missing ? 1 : 0);
