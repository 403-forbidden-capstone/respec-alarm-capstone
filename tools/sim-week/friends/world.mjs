// 가상 유저 만들기 · 지우기. 시드 데모 계정은 안 건드리고 전용 임시 계정 `simfriend-…@example.com`만 씀
import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

import { retryFetch } from './net.mjs';

export const EMAIL_PREFIX = 'simfriend-';
export const NAME_PREFIX = 'SIM ';
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: retryFetch } };

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export async function cleanup(admin) {
  // 이름 머리말로 그룹 · 약속을 먼저 지움 (사람을 지우면 연쇄로 따라가지만 그룹 · 약속은 남을 수 있음)
  await admin.from('groups').delete().like('group_name', `${NAME_PREFIX}%`);
  await admin.from('appointments').delete().like('title', `${NAME_PREFIX}%`);
  for (let page = 1; page < 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const mine = data.users.filter((u) => u.email?.startsWith(EMAIL_PREFIX));
    for (const u of mine) await admin.auth.admin.deleteUser(u.id);
    if (data.users.length < 200) break;
  }
}

// n명 만들기: 온보딩 끝낸 프로필 + 알람 있는 개인 약속 하나씩(공유 알람 조회 대상)
export async function createWorld({ admin, env, n, tag }) {
  const users = [];
  for (let i = 0; i < n; i += 1) {
    const email = `${EMAIL_PREFIX}${tag}-${i}@example.com`;
    const created = await admin.auth.admin.createUser({ email, password: env.password, email_confirm: true });
    if (created.error) throw new Error(`가상 유저 만들기 실패: ${created.error.message}`);
    const id = created.data.user.id;
    const up = await admin.from('profiles').update({ nickname: `시뮬${i + 1}`, onboarded_at: new Date().toISOString() }).eq('user_id', id);
    if (up.error) throw new Error(`프로필 채우기 실패: ${up.error.message}`);
    const prof = (await admin.from('profiles').select('handle').eq('user_id', id).single()).data;
    const client = createClient(env.url, env.anonKey, NO_SESSION);
    const si = await client.auth.signInWithPassword({ email, password: env.password });
    if (si.error) throw new Error(`가상 유저 로그인 실패: ${si.error.message}`);
    // 개인 약속 + 참여 + 알람 (admin이 직접)
    const apptId = randomUUID();
    const a = await admin.from('appointments').insert({
      appointment_id: apptId, series_id: apptId, creator_id: id, title: `${NAME_PREFIX}개인 약속 ${i + 1}`,
      appointment_at: `${today()}T13:00:00+09:00`, dest_name: '세종대학교', dest_lat: 37.5509, dest_lng: 127.0736,
    });
    if (a.error) throw new Error(`약속 만들기 실패: ${a.error.message}`);
    const part = await admin.from('appointment_participants').insert({ appointment_id: apptId, user_id: id }).select().single();
    if (part.error) throw new Error(`참여 행 실패: ${part.error.message}`);
    const al = await admin.from('alarms').insert({ participant_id: part.data.participant_id, user_id: id, alarm_type: 'DEPARTURE', scheduled_at: `${today()}T11:00:00+09:00` });
    if (al.error) throw new Error(`알람 실패: ${al.error.message}`);
    users.push({ i, id, email, handle: prof.handle, client, name: `시뮬${i + 1}` });
  }
  // 시작 상태: 일주일 첫날부터 그룹 기능이 돌도록 그룹 둘을 admin으로 미리 만듦 (사람 0~3, 2~5). 동의는 사람마다 다르게
  const groupsMade = [];
  if (users.length >= 4) {
    const spans = [[0, Math.min(4, users.length)], [Math.min(2, users.length - 1), users.length]];
    for (const [k, [from, to]] of spans.entries()) {
      const members = users.slice(from, to);
      if (members.length < 2) continue;
      const g = await admin.from('groups').insert({ group_name: `${NAME_PREFIX}시작 그룹 ${'AB'[k]}`, owner_id: members[0].id }).select().single();
      if (g.error) throw new Error(`시작 그룹 만들기 실패: ${g.error.message}`);
      groupsMade.push(g.data.group_id);
      for (const [j, m] of members.entries()) {
        const row = { group_id: g.data.group_id, user_id: m.id, invite_status: 'JOINED', joined_at: new Date().toISOString(), wake_share_opt_in: (m.i + k) % 3 !== 0, notifications_off: false };
        const r = j === 0
          ? await admin.from('group_members').update({ wake_share_opt_in: row.wake_share_opt_in }).eq('group_id', row.group_id).eq('user_id', m.id)
          : await admin.from('group_members').insert(row);
        if (r.error) throw new Error(`시작 그룹 멤버 넣기 실패: ${r.error.message}`);
      }
    }
  }
  // 받은 초대도 미리 둠 (초대 수락 행동이 첫날부터 일할 수 있게): 그룹 A에 사람 4, 그룹 B에 사람 0 · 1
  const invites = [[0, 4], [1, 0], [1, 1]];
  for (const [gi, ui] of invites) {
    if (!groupsMade[gi] || !users[ui]) continue;
    const exists = await admin.from('group_members').select('user_id').eq('group_id', groupsMade[gi]).eq('user_id', users[ui].id);
    if (exists.data?.length) continue;
    const r = await admin.from('group_members').insert({ group_id: groupsMade[gi], user_id: users[ui].id, invite_status: 'INVITED', invited_by: users[gi === 0 ? 0 : 2].id });
    if (r.error) throw new Error(`시작 초대 넣기 실패: ${r.error.message}`);
  }
  // 시작 친구 관계: 0-1 · 1-2 · 2-3 수락됨(0←1 · 1←2는 알람 조회 + 설정 권한까지), 4→0 요청 대기. 수락 · 알람 바꾸기 제안이 첫날부터 일할 수 있게
  if (users.length >= 5) {
    const mk = async (x, y, status) => {
      const r = await admin.from('friends').insert({ requester_id: users[x].id, addressee_id: users[y].id, status, ...(status === 'ACCEPTED' ? { accepted_at: new Date().toISOString() } : {}) }).select().single();
      if (r.error) throw new Error(`시작 친구 넣기 실패: ${r.error.message}`);
      return r.data;
    };
    const f01 = await mk(0, 1, 'ACCEPTED');
    const f12 = await mk(1, 2, 'ACCEPTED');
    await mk(2, 3, 'ACCEPTED');
    await mk(4, 0, 'PENDING');
    for (const [owner, grantee, f] of [[1, 0, f01], [2, 1, f12]]) {
      const r = await admin.from('sharing_permissions').insert({ owner_id: users[owner].id, grantee_id: users[grantee].id, source_type: 'FRIEND', source_id: f.friend_id, can_view_alarm: true, can_edit_alarm: true });
      if (r.error) throw new Error(`시작 권한 넣기 실패: ${r.error.message}`);
    }
  }
  // 시작 차단: 사람 5가 사람 3을 차단 (차단 쌍 규칙이 첫날부터 검사되게). 서로 친구가 아니라 친구 행은 건드리지 않음
  if (users.length >= 6) {
    const r = await admin.from('user_blocks').insert({ blocker_id: users[5].id, blocked_id: users[3].id });
    if (r.error) throw new Error(`시작 차단 넣기 실패: ${r.error.message}`);
  }
  // 시작 공동 약속: 그룹 A에서 사람 0이 만들고 0~3이 알람을 만듦 (기상 알람 약속 3시간 전, 출발 알람 1시간 전). 깨우기 · 기상 보기 · 알람 제안이 첫날부터 일할 수 있게
  if (groupsMade[0]) {
    const apptId = randomUUID();
    const at = new Date(Math.ceil((Date.now() + 5 * 3600e3) / 60e3) * 60e3);
    const a = await admin.from('appointments').insert({ appointment_id: apptId, series_id: apptId, creator_id: users[0].id, group_id: groupsMade[0], title: `${NAME_PREFIX}공동 약속 시작`, appointment_at: at.toISOString(), dest_name: '세종대학교', dest_lat: 37.5509, dest_lng: 127.0736 });
    if (a.error) throw new Error(`시작 공동 약속 실패: ${a.error.message}`);
    for (const m of users.slice(0, Math.min(4, users.length))) {
      const part = await admin.from('appointment_participants').insert({ appointment_id: apptId, user_id: m.id, prepare_minutes: 60 }).select().single();
      if (part.error) throw new Error(`시작 참여 실패: ${part.error.message}`);
      for (const [type, h] of [['WAKE', 3], ['DEPARTURE', 1]]) {
        const al = await admin.from('alarms').insert({ participant_id: part.data.participant_id, user_id: m.id, alarm_type: type, scheduled_at: new Date(at.getTime() - h * 3600e3).toISOString() });
        if (al.error) throw new Error(`시작 알람 실패: ${al.error.message}`);
      }
    }
  }
  users.startGroups = groupsMade.length;
  return users;
}
