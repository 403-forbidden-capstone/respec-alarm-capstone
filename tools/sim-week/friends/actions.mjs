// 가상 유저가 하루에 하는 행동. 아직 DB에 없는 기능(함수 · 표 없음)은 목록에서 뺌.
// 각 행동은 { status } 한 줄을 돌려줌. 정상 거절(권한 · 검사)은 status에 "거절:코드"로 적고,
// 문서에 없는 상태 값 · 서버 오류는 ctx.anomalies에 넣음.
import { randomUUID } from 'node:crypto';

import { STATUS, checkApptEdit, checkPingVerdict, checkProposal, isServerFault } from './oracle.mjs';

// ctx = { rng, me, users, caps, fn, admin, anomalies, day, groupCount(), groupMade() }
async function callStatus(ctx, client, key, args) {
  const name = ctx.fn[key];
  const res = await client.rpc(name, args);
  if (res.error) {
    if (isServerFault(res.error)) ctx.anomalies.push({ kind: 'ANOMALY', rule: '서버 오류', detail: `${name}: ${res.error.code} ${res.error.message}` });
    return { status: `거절:${res.error.code}` };
  }
  const st = res.data?.status;
  if (!STATUS[name]?.includes(st)) ctx.anomalies.push({ kind: 'ANOMALY', rule: '문서에 없는 상태 값', detail: `${name}: ${JSON.stringify(res.data)}` });
  return { status: st };
}

async function tableCall(ctx, label, promise) {
  const res = await promise;
  if (res.error) {
    if (isServerFault(res.error)) ctx.anomalies.push({ kind: 'ANOMALY', rule: '서버 오류', detail: `${label}: ${res.error.code} ${res.error.message}` });
    return { status: `거절:${res.error.code}` };
  }
  return { status: '됨', data: res.data };
}

const other = (ctx) => ctx.rng.pick(ctx.users.filter((u) => u.id !== ctx.me.id));
const hasFn = (ctx, key) => Boolean(ctx.fn[key] && ctx.caps.hasRpc(ctx.fn[key]));

// 나와 연결된 행(받은 요청 · 보낸 요청 · 친구)을 admin으로 읽음
const pending = (c, mine) =>
  c.admin.from('friends').select('requester_id, addressee_id').eq('status', 'PENDING').eq(mine, c.me.id);

export const ACTIONS = [
  {
    name: '아이디 검색', w: 3, when: (c) => hasFn(c, 'search_handle'),
    run: (c) => callStatus(c, c.me.client, 'search_handle', { p_query: other(c).handle }),
  },
  {
    name: '친구 요청', w: 4, when: (c) => hasFn(c, 'friend_request'),
    run: (c) => callStatus(c, c.me.client, 'friend_request', { p_target_id: other(c).id }),
  },
  {
    name: '요청 수락', w: 3, when: (c) => hasFn(c, 'friend_accept'),
    async run(c) {
      const r = c.rng.pick((await pending(c, 'addressee_id')).data ?? []);
      if (!r) return { status: '(받은 요청 없음)' };
      return callStatus(c, c.me.client, 'friend_accept', { p_requester_id: r.requester_id });
    },
  },
  {
    name: '요청 거절', w: 1, when: (c) => hasFn(c, 'friend_decline'),
    async run(c) {
      const r = c.rng.pick((await pending(c, 'addressee_id')).data ?? []);
      if (!r) return { status: '(받은 요청 없음)' };
      return callStatus(c, c.me.client, 'friend_decline', { p_requester_id: r.requester_id });
    },
  },
  {
    name: '요청 취소', w: 1, when: (c) => hasFn(c, 'friend_cancel'),
    async run(c) {
      const r = c.rng.pick((await pending(c, 'requester_id')).data ?? []);
      if (!r) return { status: '(보낸 요청 없음)' };
      return callStatus(c, c.me.client, 'friend_cancel', { p_addressee_id: r.addressee_id });
    },
  },
  {
    name: '친구 끊기', w: 1, when: (c) => hasFn(c, 'friend_remove'),
    async run(c) {
      const { data } = await c.admin
        .from('friends').select('requester_id, addressee_id').eq('status', 'ACCEPTED')
        .or(`requester_id.eq.${c.me.id},addressee_id.eq.${c.me.id}`);
      const r = c.rng.pick(data ?? []);
      if (!r) return { status: '(친구 없음)' };
      return callStatus(c, c.me.client, 'friend_remove', { p_user_id: r.requester_id === c.me.id ? r.addressee_id : r.requester_id });
    },
  },
  {
    name: '차단', w: 1, when: (c) => hasFn(c, 'block_user'),
    run: (c) => callStatus(c, c.me.client, 'block_user', { p_user_id: other(c).id }),
  },
  {
    name: '차단 풀기', w: 1, when: (c) => hasFn(c, 'unblock_user'),
    async run(c) {
      const { data } = await c.admin.from('user_blocks').select('blocked_id').eq('blocker_id', c.me.id);
      const r = c.rng.pick(data ?? []);
      if (!r) return { status: '(차단한 사람 없음)' };
      return callStatus(c, c.me.client, 'unblock_user', { p_user_id: r.blocked_id });
    },
  },
  {
    name: '그룹 만들기', w: 2, when: (c) => c.caps.hasTable('groups') && c.groupCount() < 5,
    async run(c) {
      const name = `SIM 그룹 ${c.day}-${c.me.i}-${randomUUID().slice(0, 4)}`;
      const r = await tableCall(c, '그룹 만들기', c.me.client.from('groups').insert({ group_name: name, owner_id: c.me.id }).select().single());
      if (r.data) c.groupMade();
      return { status: r.status };
    },
  },
  {
    name: '코드로 그룹 참여', w: 2, when: (c) => hasFn(c, 'join_group'),
    async run(c) {
      const { data } = await c.admin.from('groups').select('invite_code').like('group_name', 'SIM %');
      const g = c.rng.pick(data ?? []);
      if (!g) return { status: '(그룹 없음)' };
      const res = await c.me.client.rpc(c.fn.join_group, { p_invite_code: g.invite_code });
      if (res.error) {
        if (isServerFault(res.error)) c.anomalies.push({ kind: 'ANOMALY', rule: '서버 오류', detail: `join: ${res.error.code}` });
        return { status: `거절:${res.error.code}` };
      }
      return { status: '됨' };
    },
  },
  {
    name: '코드 미리보기', w: 2, when: (c) => hasFn(c, 'group_preview'),
    async run(c) {
      const { data } = await c.admin.from('groups').select('invite_code').like('group_name', 'SIM %');
      const g = c.rng.pick(data ?? []);
      // 가끔 틀린 코드로도 봄 (NOT_FOUND와 틀린 코드 횟수 제한을 탐)
      const code = !g || c.rng.chance(0.15) ? 'ZZZZZZZZ' : g.invite_code;
      return callStatus(c, c.me.client, 'group_preview', { p_code: code });
    },
  },
  {
    name: '코드로 참여(함수)', w: 3, when: (c) => hasFn(c, 'group_join'),
    async run(c) {
      const { data } = await c.admin.from('groups').select('invite_code').like('group_name', 'SIM %');
      const g = c.rng.pick(data ?? []);
      if (!g) return { status: '(그룹 없음)' };
      return callStatus(c, c.me.client, 'group_join', { p_code: g.invite_code, p_wake_share: c.rng.chance(0.5) });
    },
  },
  {
    name: '그룹에 친구 초대', w: 5, when: (c) => hasFn(c, 'group_invite'),
    async run(c) {
      const { data } = await c.admin.from('group_members').select('group_id').eq('user_id', c.me.id).eq('invite_status', 'JOINED');
      const g = c.rng.pick(data ?? []);
      if (!g) return { status: '(참여 그룹 없음)' };
      // 대부분 내 친구를 초대하고, 가끔 친구 아닌 사람도 시도함(NOT_FOUND를 탐)
      const { data: fr } = await c.admin
        .from('friends').select('requester_id, addressee_id').eq('status', 'ACCEPTED')
        .or(`requester_id.eq.${c.me.id},addressee_id.eq.${c.me.id}`);
      const friend = c.rng.pick(fr ?? []);
      const target = friend && !c.rng.chance(0.15) ? (friend.requester_id === c.me.id ? friend.addressee_id : friend.requester_id) : other(c).id;
      // 초대가 되려면: 내가 참여 중(위에서 고름) + 상대가 내 친구(수락됨) + 차단 쌍 아님 + 아직 멤버 아님. 아니면 INVITED가 돌아오면 안 됨
      const isFriend = (fr ?? []).some((f) => (f.requester_id === target && f.addressee_id === c.me.id) || (f.addressee_id === target && f.requester_id === c.me.id));
      const blocked = (await c.admin.from('user_blocks').select('blocker_id').or(`and(blocker_id.eq.${c.me.id},blocked_id.eq.${target}),and(blocker_id.eq.${target},blocked_id.eq.${c.me.id})`)).data ?? [];
      const res = await callStatus(c, c.me.client, 'group_invite', { p_group_id: g.group_id, p_user_id: target });
      if (res.status === 'INVITED' && (!isFriend || blocked.length > 0)) {
        c.anomalies.push({ kind: 'VIOLATION', rule: 'G-친구가 아니거나 차단 쌍인 사람에게 그룹 초대가 됨', detail: `${c.me.id} → ${target} (friend=${isFriend}, blocked=${blocked.length > 0})` });
      }
      return res;
    },
  },
  {
    name: '초대 수락', w: 6, when: (c) => hasFn(c, 'group_accept'),
    async run(c) {
      const { data } = await c.admin.from('group_members').select('group_id').eq('user_id', c.me.id).eq('invite_status', 'INVITED');
      const g = c.rng.pick(data ?? []);
      if (!g) return { status: '(받은 초대 없음)' };
      return callStatus(c, c.me.client, 'group_accept', { p_group_id: g.group_id, p_wake_share: c.rng.chance(0.5) });
    },
  },
  // ---- 7 · 8 · 9 · 10장 ----
  {
    name: '공동 약속 만들기', w: 2, when: (c) => c.caps.hasTable('appointments') && c.caps.hasTable('group_members') && c.apptCount() < 12,
    async run(c) {
      const g = c.rng.pick(await myGroups(c));
      if (!g) return { status: '(참여 그룹 없음)' };
      const id = randomUUID();
      const at = new Date(Math.ceil((Date.now() + (4 + c.rng.int(3)) * 3600e3) / 60e3) * 60e3).toISOString();
      const r = await tableCall(c, '공동 약속 만들기', c.me.client.from('appointments').insert({
        appointment_id: id, series_id: id, creator_id: c.me.id, group_id: g, title: `SIM 공동 약속 ${c.day}-${c.me.i}-${id.slice(0, 4)}`,
        appointment_at: at, dest_name: '세종대학교', dest_lat: 37.5509, dest_lng: 127.0736,
      }));
      if (r.status === '됨') c.apptMade();
      return { status: r.status };
    },
  },
  {
    name: '내 알람 만들기', w: 5, when: (c) => c.caps.hasTable('appointment_participants'),
    async run(c) {
      const appt = c.rng.pick(await futureGroupAppts(c, true));
      if (!appt) return { status: '(내가 참여할 약속 없음)' };
      const part = await tableCall(c, '참여', c.me.client.from('appointment_participants').insert({ appointment_id: appt.appointment_id, user_id: c.me.id, prepare_minutes: 60 }).select().single());
      if (!part.data) return { status: part.status };
      const at = new Date(appt.appointment_at).getTime();
      const wake = await c.me.client.from('alarms').insert({ participant_id: part.data.participant_id, user_id: c.me.id, alarm_type: 'WAKE', scheduled_at: new Date(at - 3 * 3600e3).toISOString() });
      const dep = await c.me.client.from('alarms').insert({ participant_id: part.data.participant_id, user_id: c.me.id, alarm_type: 'DEPARTURE', scheduled_at: new Date(at - 1 * 3600e3).toISOString() });
      for (const x of [wake, dep]) if (x.error && isServerFault(x.error)) c.anomalies.push({ kind: 'ANOMALY', rule: '서버 오류', detail: `알람 만들기: ${x.error.code}` });
      return { status: wake.error || dep.error ? `거절:${(wake.error ?? dep.error).code}` : '됨' };
    },
  },
  {
    name: '약속 빠지기', w: 1, when: (c) => c.caps.hasTable('appointment_participants'),
    async run(c) {
      const { data } = await c.admin.from('appointment_participants').select('participant_id, appointment_id').eq('user_id', c.me.id);
      const mineSim = [];
      for (const p of data ?? []) {
        const { data: ap } = await c.admin.from('appointments').select('title').eq('appointment_id', p.appointment_id).single();
        if (ap?.title?.startsWith('SIM 공동')) mineSim.push(p);
      }
      const p = c.rng.pick(mineSim);
      if (!p) return { status: '(참여한 약속 없음)' };
      return tableCall(c, '약속 빠지기', c.me.client.from('appointment_participants').delete().eq('participant_id', p.participant_id));
    },
  },
  {
    name: '공동 약속 고치기', w: 2, when: (c) => c.caps.hasTable('appointments'),
    async run(c) {
      const appt = c.rng.pick(await futureGroupAppts(c, false));
      if (!appt) return { status: '(약속 없음)' };
      const { data: mine } = await c.admin.from('appointment_participants').select('participant_id').eq('appointment_id', appt.appointment_id).eq('user_id', c.me.id);
      const r = await c.me.client.from('appointments').update({ dest_name: `SIM 목적지 ${c.rng.int(1000)}` }).eq('appointment_id', appt.appointment_id).select();
      if (r.error && isServerFault(r.error)) c.anomalies.push({ kind: 'ANOMALY', rule: '서버 오류', detail: `약속 고치기: ${r.error.code}` });
      const { data: still } = await c.admin.from('group_members').select('user_id').eq('group_id', appt.group_id).eq('user_id', c.me.id).eq('invite_status', 'JOINED');
      c.anomalies.push(...checkApptEdit({ editor: c.me.id, creatorId: appt.creator_id, rowsChanged: (r.data ?? []).length > 0, isParticipant: (mine ?? []).length > 0, editorJoined: (still ?? []).length > 0 }));
      return { status: r.error ? `거절:${r.error.code}` : (r.data ?? []).length ? '고침' : '0행(권한 없음)' };
    },
  },
  {
    name: '기상 확인', w: 4, when: (c) => c.caps.hasTable('alarm_events'),
    async run(c) {
      const { data } = await c.admin.from('alarms').select('alarm_id').eq('user_id', c.me.id).eq('alarm_type', 'WAKE').gt('scheduled_at', new Date().toISOString());
      const al = c.rng.pick(data ?? []);
      if (!al) return { status: '(내 기상 알람 없음)' };
      return tableCall(c, '기상 확인', c.me.client.from('alarm_events').insert({ alarm_id: al.alarm_id, user_id: c.me.id, event_type: 'WAKE_CONFIRMED', event_at: new Date().toISOString(), input_source: 'BUTTON' }));
    },
  },
  {
    name: '기상 숨기기', w: 2, when: (c) => hasFn(c, 'wake_hide'),
    run: (c) => callStatus(c, c.me.client, 'wake_hide', { p_user_id: other(c).id, p_hidden: true }),
  },
  {
    name: '기상 보이기', w: 1, when: (c) => hasFn(c, 'wake_hide'),
    run: (c) => callStatus(c, c.me.client, 'wake_hide', { p_user_id: other(c).id, p_hidden: false }),
  },
  {
    name: '깨우기 판정', w: 4, when: (c) => hasFn(c, 'wake_ping'),
    async run(c) {
      // 서버 함수(notify)가 부르는 service_role 전용 판정. 시각은 가상 유저들의 기상 알람(약속 3시간 전)이 울린 뒤로 잡음
      // 대부분 같은 그룹에서 앞으로 기상 알람이 있는 사람을 고르고, 가끔 아무나(FORBIDDEN을 탐)
      const mates = await groupMates(c);
      const withAlarm = [];
      for (const u of mates) {
        const { data } = await c.admin.from('alarms').select('alarm_id').eq('user_id', u.id).eq('alarm_type', 'WAKE').gt('scheduled_at', new Date().toISOString()).limit(1);
        if (data?.length) withAlarm.push(u);
      }
      const target = withAlarm.length && !c.rng.chance(0.15) ? c.rng.pick(withAlarm) : other(c);
      // 약속은 지금 + 4 ~ 6시간, 기상 알람은 그 3시간 전 → 지금 + 3.5시간이면 알람은 울린 뒤, 약속은 시작 전
      const now = new Date(Date.now() + 3.5 * 3600e3).toISOString();
      const res = await c.admin.rpc(c.fn.wake_ping, { p_sender: c.me.id, p_target: target.id, p_reserve: true, p_now: now, p_group_id: null });
      if (res.error) {
        if (isServerFault(res.error)) c.anomalies.push({ kind: 'ANOMALY', rule: '서버 오류', detail: `깨우기 판정: ${res.error.code}` });
        return { status: `거절:${res.error.code}` };
      }
      const st = res.data?.status;
      if (!STATUS.plan_wake_ping.includes(st)) c.anomalies.push({ kind: 'ANOMALY', rule: '문서에 없는 상태 값', detail: `plan_wake_ping: ${JSON.stringify(res.data)}` });
      const state = await c.worldState();
      c.anomalies.push(...checkPingVerdict({ sender: c.me.id, target: target.id, status: st, members: state.members, hides: state.hides, blocks: state.blocks }));
      return { status: st };
    },
  },
  {
    name: '알람 바꾸기 제안', w: 6, when: (c) => hasFn(c, 'alarm_suggest'),
    async run(c) {
      // 대부분 나에게 설정 권한을 준 사람의 알람을, 가끔 아무나(FORBIDDEN을 탐)
      const { data: gr } = await c.admin.from('sharing_permissions').select('owner_id').eq('grantee_id', c.me.id).eq('can_edit_alarm', true).eq('can_view_alarm', true);
      const withAlarms = [];
      for (const g of gr ?? []) {
        const { data: al } = await c.admin.from('alarms').select('alarm_id').eq('user_id', g.owner_id).not('participant_id', 'is', null).gt('scheduled_at', new Date(Date.now() + 30 * 60e3).toISOString()).limit(1);
        if (al?.length) withAlarms.push(g.owner_id);
      }
      const ownerId = withAlarms.length && !c.rng.chance(0.2) ? c.rng.pick(withAlarms) : other(c).id;
      const o = c.users.find((u) => u.id === ownerId) ?? other(c);
      const { data } = await c.admin.from('alarms').select('alarm_id, scheduled_at').eq('user_id', o.id).gt('scheduled_at', new Date(Date.now() + 30 * 60e3).toISOString());
      const al = c.rng.pick(data ?? []);
      if (!al) return { status: '(상대 앞으로 알람 없음)' };
      const newAt = new Date(new Date(al.scheduled_at).getTime() + (c.rng.chance(0.2) ? 90 : (c.rng.int(40) - 20)) * 60e3).toISOString();
      const res = await callStatus(c, c.me.client, 'alarm_suggest', { p_alarm_id: al.alarm_id, p_new_at: newAt });
      const state = await c.worldState();
      c.anomalies.push(...checkProposal({ proposer: c.me.id, owner: o.id, status: res.status, perms: state.perms, blocks: state.blocks }));
      return res;
    },
  },
  {
    name: '받은 제안 응답', w: 8, when: (c) => hasFn(c, 'alarm_suggest_apply'),
    async run(c) {
      const { data } = await c.admin.from('alarm_proposals').select('proposal_id').eq('owner_id', c.me.id).eq('status', 'PENDING');
      const p = c.rng.pick(data ?? []);
      if (!p) return { status: '(받은 제안 없음)' };
      return callStatus(c, c.me.client, 'alarm_suggest_apply', { p_proposal_id: p.proposal_id, p_apply: c.rng.chance(0.6) });
    },
  },
  {
    name: '그룹 권한 저장', w: 3, when: (c) => hasFn(c, 'save_group_permissions'),
    async run(c) {
      const g = c.rng.pick(await myGroups(c));
      if (!g) return { status: '(참여 그룹 없음)' };
      const view = c.rng.chance(0.7);
      return callStatus(c, c.me.client, 'save_group_permissions', { p_group_id: g, p_can_view_alarm: view, p_can_edit_alarm: view && c.rng.chance(0.7) });
    },
  },
  {
    name: '그룹 나가기', w: 1, when: (c) => c.caps.hasTable('group_members'),
    async run(c) {
      const { data } = await c.admin.from('group_members').select('group_id').eq('user_id', c.me.id).eq('invite_status', 'JOINED');
      const g = c.rng.pick(data ?? []);
      if (!g) return { status: '(참여 그룹 없음)' };
      return tableCall(c, '그룹 나가기', c.me.client.from('group_members').update({ invite_status: 'LEFT' }).eq('group_id', g.group_id).eq('user_id', c.me.id));
    },
  },
  {
    name: '멤버 내보내기', w: 1, when: (c) => c.caps.hasTable('group_members'),
    async run(c) {
      // 가상 유저가 만든 SIM 그룹 안의 가상 유저만 대상 (시드 그룹은 건드리지 않음)
      const groups = (await c.admin.from('groups').select('group_id').like('group_name', 'SIM %')).data ?? [];
      const ids = c.users.map((u) => u.id);
      const { data } = await c.admin
        .from('group_members').select('group_id, user_id').in('group_id', groups.map((g) => g.group_id)).in('user_id', ids)
        .neq('user_id', c.me.id).eq('invite_status', 'JOINED');
      const m = c.rng.pick(data ?? []);
      if (!m) return { status: '(내보낼 멤버 없음)' };
      const r = await tableCall(c, '내보내기', c.me.client.from('group_members').delete().eq('group_id', m.group_id).eq('user_id', m.user_id).select());
      // 권한이 없으면 오류 없이 0행만 지워짐 — 결과에 따로 적음
      return { status: r.data ? (r.data.length ? '지움' : '0행(권한 없음)') : r.status };
    },
  },
  {
    name: '알람 조회 권한 켜기', w: 3, when: (c) => c.caps.hasTable('sharing_permissions'),
    async run(c) {
      const { data } = await c.admin
        .from('friends').select('friend_id, requester_id, addressee_id').eq('status', 'ACCEPTED')
        .or(`requester_id.eq.${c.me.id},addressee_id.eq.${c.me.id}`);
      const f = c.rng.pick(data ?? []);
      if (!f) return { status: '(친구 없음)' };
      const grantee = f.requester_id === c.me.id ? f.addressee_id : f.requester_id;
      const row = { owner_id: c.me.id, grantee_id: grantee, source_type: 'FRIEND', source_id: f.friend_id, can_view_alarm: true, can_edit_alarm: c.rng.chance(0.6) };
      // 이미 있으면 켜기만 (표에 같은 쌍 유일 제약이 있을 수 있어 먼저 찾아 봄)
      const had = await c.admin.from('sharing_permissions').select('permission_id').eq('owner_id', c.me.id).eq('grantee_id', grantee).eq('source_id', f.friend_id);
      if (had.data?.length) {
        return tableCall(c, '권한 켜기', c.me.client.from('sharing_permissions').update({ can_view_alarm: true }).eq('permission_id', had.data[0].permission_id));
      }
      return tableCall(c, '권한 켜기', c.me.client.from('sharing_permissions').insert(row));
    },
  },
  {
    name: '알람 조회 권한 끄기', w: 2, when: (c) => c.caps.hasTable('sharing_permissions'),
    async run(c) {
      const { data } = await c.admin.from('sharing_permissions').select('permission_id').eq('owner_id', c.me.id).eq('can_view_alarm', true);
      const p = c.rng.pick(data ?? []);
      if (!p) return { status: '(켠 권한 없음)' };
      return tableCall(c, '권한 끄기', c.me.client.from('sharing_permissions').update({ can_view_alarm: false, can_edit_alarm: false }).eq('permission_id', p.permission_id));
    },
  },
  {
    name: '공유 알람 조회', w: 3, when: (c) => hasFn(c, 'shared_alarms'),
    async run(c) {
      const res = await c.me.client.rpc(c.fn.shared_alarms, { p_owner_id: other(c).id });
      if (res.error) return { status: `거절:${res.error.code}` };
      return { status: res.data.length ? '보임' : '안 보임' };
    },
  },
];

// 내가 참여 중인 SIM 그룹 id들
async function myGroups(c) {
  const { data: gm } = await c.admin.from('group_members').select('group_id').eq('user_id', c.me.id).eq('invite_status', 'JOINED');
  const ids = (gm ?? []).map((m) => m.group_id);
  if (!ids.length) return [];
  const { data: gs } = await c.admin.from('groups').select('group_id').in('group_id', ids).like('group_name', 'SIM %');
  return (gs ?? []).map((g) => g.group_id);
}

// 앞으로 올 SIM 공동 약속 (내 그룹 것). excludeMine = 내가 아직 참여하지 않은 것만
async function futureGroupAppts(c, excludeMine) {
  const groups = await myGroups(c);
  if (!groups.length) return [];
  const { data } = await c.admin.from('appointments').select('appointment_id, group_id, creator_id, appointment_at').in('group_id', groups).like('title', 'SIM 공동%').gt('appointment_at', new Date(Date.now() + 3.5 * 3600e3).toISOString());
  if (!excludeMine) return data ?? [];
  const { data: mine } = await c.admin.from('appointment_participants').select('appointment_id').eq('user_id', c.me.id);
  const have = new Set((mine ?? []).map((p) => p.appointment_id));
  return (data ?? []).filter((x) => !have.has(x.appointment_id));
}

// 나와 같은 SIM 그룹에 참여 중인 다른 가상 유저들
async function groupMates(c) {
  const groups = await myGroups(c);
  if (!groups.length) return [];
  const { data } = await c.admin.from('group_members').select('user_id').in('group_id', groups).eq('invite_status', 'JOINED').neq('user_id', c.me.id);
  const ids = new Set((data ?? []).map((m) => m.user_id));
  return c.users.filter((u) => ids.has(u.id));
}
