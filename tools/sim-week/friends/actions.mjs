// 가상 유저가 하루에 하는 행동. 아직 DB에 없는 기능(함수 · 표 없음)은 목록에서 뺌.
// 각 행동은 { status } 한 줄을 돌려줌. 정상 거절(권한 · 검사)은 status에 "거절:코드"로 적고,
// 문서에 없는 상태 값 · 서버 오류는 ctx.anomalies에 넣음.
import { randomUUID } from 'node:crypto';

import { STATUS, isServerFault } from './oracle.mjs';

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
    name: '그룹 만들기', w: 1, when: (c) => c.caps.hasTable('groups') && c.groupCount() < 5,
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
      return callStatus(c, c.me.client, 'group_invite', { p_group_id: g.group_id, p_user_id: target });
    },
  },
  {
    name: '초대 수락', w: 4, when: (c) => hasFn(c, 'group_accept'),
    async run(c) {
      const { data } = await c.admin.from('group_members').select('group_id').eq('user_id', c.me.id).eq('invite_status', 'INVITED');
      const g = c.rng.pick(data ?? []);
      if (!g) return { status: '(받은 초대 없음)' };
      return callStatus(c, c.me.client, 'group_accept', { p_group_id: g.group_id, p_wake_share: c.rng.chance(0.5) });
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
      const row = { owner_id: c.me.id, grantee_id: grantee, source_type: 'FRIEND', source_id: f.friend_id, can_view_alarm: true, can_edit_alarm: c.rng.chance(0.3) };
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
