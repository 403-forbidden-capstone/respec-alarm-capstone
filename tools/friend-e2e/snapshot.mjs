// 시작 전 A · B · C 사이의 친구 · 권한을 저장해 두고 비운 뒤, 끝나면 되돌림 (시드 데이터를 망가뜨리지 않음)
//   비우는 것: A · B · C끼리의 차단 · 신고 행(4장), 친구 행, A · B · C끼리의 권한 행 전부, 이전 실행이 남긴 'E2E ' 그룹 · 약속
//   되돌리는 것: 같은 id로 다시 넣음. A의 아이디 변경도 원래대로 (handle은 앱이 못 쓰지만 service_role은 통과)
//   저장 파일은 비정상 종료에 대비해 임시 폴더에 둠 → `node run.mjs --restore`
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Fail } from './harness.mjs';

export const SNAPSHOT_FILE = join(tmpdir(), 'friend-e2e-snapshot.json');
export const E2E_PREFIX = 'E2E ';

const must = (res, what) => {
  if (res.error) throw new Fail(`${what}: ${res.error.message}`);
  return res.data;
};

export async function takeSnapshot(admin, ids, caps) {
  const set = Object.values(ids);
  const friends = must(
    await admin.from('friends').select('*').in('requester_id', set).in('addressee_id', set),
    '친구 행 저장',
  );
  const perms = must(
    await admin.from('sharing_permissions').select('*').in('owner_id', set).in('grantee_id', set),
    '권한 행 저장',
  );
  // 4장: 차단 · 신고 표 (있을 때만)
  const blocks = caps.hasTable('user_blocks')
    ? must(await admin.from('user_blocks').select('*').in('blocker_id', set).in('blocked_id', set), '차단 행 저장')
    : [];
  const reports = caps.hasTable('reports')
    ? must(await admin.from('reports').select('*').in('reporter_id', set).in('target_user_id', set), '신고 행 저장')
    : [];
  const handleCols = ['user_id', 'handle', ...['handle_changed_at', 'handle_next_change_at'].filter((c) => caps.hasCol('profiles', c))];
  const profiles = must(await admin.from('profiles').select(handleCols.join(',')).in('user_id', set), '프로필 저장');
  const snap = { friends, perms, profiles, ids, blocks, reports };
  writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap));
  return snap;
}

// 이전 실행이 남긴 것 지움 + 친구 · 권한 비움
export async function wipe(admin, ids, caps) {
  const set = Object.values(ids);
  // 4장 표는 DB에 있을 때만 (caps가 없으면 표를 직접 시도하고 "없음" 오류는 넘김)
  const optional = async (table, run) => {
    if (caps && !caps.hasTable(table)) return;
    const res = await run();
    if (res.error && !(res.error.code === 'PGRST205' || res.error.code === '42P01')) throw new Fail(`${table} 비움: ${res.error.message}`);
  };
  // 검색 · 요청 · 틀린 코드 횟수 제한 기록 (A · B · C 것만): 시험을 연달아 돌려도 제한에 안 걸리게 비움
  await optional('rate_limit_events', () => admin.from('rate_limit_events').delete().in('user_id', set));
  await optional('user_blocks', () => admin.from('user_blocks').delete().in('blocker_id', set).in('blocked_id', set));
  await optional('reports', () => admin.from('reports').delete().in('reporter_id', set).in('target_user_id', set));
  // 이름 머리말로만 거름 (5장에서 owner_id 칼럼이 빠져도 동작)
  must(await admin.from('groups').delete().like('group_name', `${E2E_PREFIX}%`), '남은 E2E 그룹 지움');
  must(await admin.from('appointments').delete().like('title', `${E2E_PREFIX}%`).in('creator_id', set), '남은 E2E 약속 지움');
  must(await admin.from('sharing_permissions').delete().in('owner_id', set).in('grantee_id', set), '권한 비움');
  must(await admin.from('friends').delete().in('requester_id', set).in('addressee_id', set), '친구 비움');
}

export async function restore(admin, snap) {
  await wipe(admin, snap.ids);
  if (snap.blocks?.length) must(await admin.from('user_blocks').insert(snap.blocks), '차단 되돌림');
  if (snap.reports?.length) must(await admin.from('reports').insert(snap.reports), '신고 되돌림');
  if (snap.friends.length) must(await admin.from('friends').insert(snap.friends), '친구 되돌림');
  if (snap.perms.length) must(await admin.from('sharing_permissions').insert(snap.perms), '권한 되돌림');
  for (const p of snap.profiles) {
    const { user_id, ...rest } = p;
    must(await admin.from('profiles').update(rest).eq('user_id', user_id), '아이디 되돌림');
  }
  if (existsSync(SNAPSHOT_FILE)) unlinkSync(SNAPSHOT_FILE);
}

export function readSavedSnapshot() {
  return existsSync(SNAPSHOT_FILE) ? JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) : null;
}
