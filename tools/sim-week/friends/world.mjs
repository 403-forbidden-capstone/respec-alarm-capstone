// 가상 유저 만들기 · 지우기. 시드 데모 계정은 안 건드리고 전용 임시 계정 `simfriend-…@example.com`만 씀
import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

export const EMAIL_PREFIX = 'simfriend-';
export const NAME_PREFIX = 'SIM ';
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };

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
  return users;
}
