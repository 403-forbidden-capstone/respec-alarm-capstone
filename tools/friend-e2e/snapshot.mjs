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

// 오늘(KST) 전후 이틀
export function windowOf(now = Date.now()) {
  const day = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
  return {
    fromIso: `${day(now - 2 * 86400e3)}T00:00:00+09:00`,
    toIso: `${day(now + 3 * 86400e3)}T00:00:00+09:00`,
    fromDate: day(now - 2 * 86400e3),
    toDate: day(now + 2 * 86400e3),
  };
}

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
  // 7 · 8장: 기상 확인은 사람마다 하루 한 건이라 시드의 오늘 확인이 있으면 대본의 [일어났어요]가 저장되지 않음 → 오늘 전후 이틀의 기상 확인 · 하루 기록을 저장하고 비움
  const win = windowOf();
  const wakeEvents = caps.hasTable('alarm_events')
    ? must(await admin.from('alarm_events').select('*').in('user_id', set).eq('event_type', 'WAKE_CONFIRMED').gte('event_at', win.fromIso).lt('event_at', win.toIso), '기상 확인 저장')
    : [];
  const dailyRecords = caps.hasTable('daily_records')
    ? must(await admin.from('daily_records').select('*').in('user_id', set).gte('record_date', win.fromDate).lte('record_date', win.toDate), '하루 기록 저장')
    : [];
  const handleCols = ['user_id', 'handle', ...['handle_changed_at', 'handle_next_change_at'].filter((c) => caps.hasCol('profiles', c))];
  const profiles = must(await admin.from('profiles').select(handleCols.join(',')).in('user_id', set), '프로필 저장');
  const snap = { friends, perms, profiles, ids, blocks, reports, wakeEvents, dailyRecords, win };
  writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap));
  return snap;
}

// 이전 실행이 남긴 것 지움 + 친구 · 권한 비움
export async function wipe(admin, ids, caps, win = windowOf()) {
  const set = Object.values(ids);
  // 4장 표는 DB에 있을 때만 (caps가 없으면 표를 직접 시도하고 "없음" 오류는 넘김)
  const optional = async (table, run) => {
    if (caps && !caps.hasTable(table)) return;
    const res = await run();
    if (res.error && !(res.error.code === 'PGRST205' || res.error.code === '42P01')) throw new Fail(`${table} 비움: ${res.error.message}`);
  };
  // 검색 · 요청 · 틀린 코드 횟수 제한 기록 (A · B · C 것만): 시험을 연달아 돌려도 제한에 안 걸리게 비움
  await optional('rate_limit_events', () => admin.from('rate_limit_events').delete().in('user_id', set));
  // 8장 푸시 기록(서버 전용): 대본이 남기는 깨우기 · 미확인 알림 줄은 A · B · C끼리만, 오늘 전후 이틀 안
  await optional('push_sends', () => admin.from('push_sends').delete().eq('kind', 'WAKE_PING').in('sender_id', set).in('target_id', set).gte('sent_at', win.fromIso).lt('sent_at', win.toIso));
  // 미확인 알림(NUDGE · UP)은 C가 시드의 다른 그룹에도 있어 그 그룹원에게도 줄이 생김 → 안 일어난 사람이 A · B · C인 줄은 받는 사람과 무관하게 비움
  await optional('push_sends', () => admin.from('push_sends').delete().in('kind', ['NUDGE', 'UP']).in('subject_id', set).gte('sent_at', win.fromIso).lt('sent_at', win.toIso));
  // 7장 기상 숨기기
  await optional('wake_hides', () => admin.from('wake_hides').delete().in('owner_id', set).in('hidden_from_id', set));
  // 10장 알람 제안 (대본 알람은 약속과 함께 지워지지만, 제안 줄이 남지 않게)
  await optional('alarm_proposals', () => admin.from('alarm_proposals').delete().in('owner_id', set).in('proposer_id', set));
  // 하루 기록의 기상 시각도 비움(저장해 둔 것은 restore가 되돌림) — 시드의 오늘 기록이 있으면 트리거가 안 돌아도 21번이 통과하는 일을 막음
  await optional('daily_records', () => admin.from('daily_records').delete().in('user_id', set).gte('record_date', win.fromDate).lte('record_date', win.toDate));
  await optional('alarm_events', () => admin.from('alarm_events').delete().in('user_id', set).eq('event_type', 'WAKE_CONFIRMED').gte('event_at', win.fromIso).lt('event_at', win.toIso));
  await optional('user_blocks', () => admin.from('user_blocks').delete().in('blocker_id', set).in('blocked_id', set));
  await optional('reports', () => admin.from('reports').delete().in('reporter_id', set).in('target_user_id', set));
  // 이름 머리말로만 거름 (5장에서 owner_id 칼럼이 빠져도 동작)
  must(await admin.from('groups').delete().like('group_name', `${E2E_PREFIX}%`), '남은 E2E 그룹 지움');
  must(await admin.from('appointments').delete().like('title', `${E2E_PREFIX}%`).in('creator_id', set), '남은 E2E 약속 지움');
  must(await admin.from('appointments').delete().like('title', `${E2E_PREFIX}%`).is('creator_id', null), '만든 사람 없는 E2E 약속 지움');
  must(await admin.from('sharing_permissions').delete().in('owner_id', set).in('grantee_id', set), '권한 비움');
  must(await admin.from('friends').delete().in('requester_id', set).in('addressee_id', set), '친구 비움');
}

export async function restore(admin, snap) {
  await wipe(admin, snap.ids, undefined, snap.win ?? windowOf());
  if (snap.dailyRecords) {
    // 대본 중 트리거가 오늘 하루 기록의 기상 시각을 채울 수 있어, 그 기간 줄을 저장해 둔 것으로 되돌림
    const w = snap.win ?? windowOf();
    must(await admin.from('daily_records').delete().in('user_id', Object.values(snap.ids)).gte('record_date', w.fromDate).lte('record_date', w.toDate), '하루 기록 비움');
    if (snap.dailyRecords.length) must(await admin.from('daily_records').insert(snap.dailyRecords), '하루 기록 되돌림');
  }
  if (snap.wakeEvents?.length) must(await admin.from('alarm_events').insert(snap.wakeEvents), '기상 확인 되돌림');
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
