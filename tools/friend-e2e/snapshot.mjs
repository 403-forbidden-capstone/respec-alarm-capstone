// 시작 전 A · B · C 사이의 친구 · 권한을 저장해 두고 비운 뒤, 끝나면 되돌림 (시드 데이터를 망가뜨리지 않음)
//   비우는 것: A · B · C끼리의 친구 행, A · B · C끼리의 권한 행 전부, 이전 실행이 남긴 'E2E ' 그룹 · 약속
//   되돌리는 것: 같은 id로 다시 넣음. A의 아이디 변경도 원래대로
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
  const handleCols = ['user_id', 'handle', ...(caps.hasCol('profiles', 'handle_changed_at') ? ['handle_changed_at'] : [])];
  const profiles = must(await admin.from('profiles').select(handleCols.join(',')).in('user_id', set), '프로필 저장');
  const snap = { friends, perms, profiles, ids };
  writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap));
  return snap;
}

// 이전 실행이 남긴 것 지움 + 친구 · 권한 비움
export async function wipe(admin, ids) {
  const set = Object.values(ids);
  // 이름 머리말로만 거름 (5장에서 owner_id 칼럼이 빠져도 동작)
  must(await admin.from('groups').delete().like('group_name', `${E2E_PREFIX}%`), '남은 E2E 그룹 지움');
  must(await admin.from('appointments').delete().like('title', `${E2E_PREFIX}%`).in('creator_id', set), '남은 E2E 약속 지움');
  must(await admin.from('sharing_permissions').delete().in('owner_id', set).in('grantee_id', set), '권한 비움');
  must(await admin.from('friends').delete().in('requester_id', set).in('addressee_id', set), '친구 비움');
}

export async function restore(admin, snap) {
  await wipe(admin, snap.ids);
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
