// 규칙 위반 검사 — 하루가 끝날 때 DB 전체(service_role로 읽음)를 보고 셈. 순수 함수라 DB 없이 시험함
//   위반(VIOLATION) = 권한 없는 노출 · 차단 쌍 · 출처 없는 권한 · 친구 행 모양
//   이상(ANOMALY)   = 문서에 없는 상태 값 · 서버 오류 · 기대한 노출이 안 됨
export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// state = { friends, blocks, perms, hasBlocksTable }
export function checkState({ friends, blocks = [], perms = [], hasBlocksTable = false }) {
  const out = [];
  const bad = (rule, detail) => out.push({ kind: 'VIOLATION', rule, detail });

  const seen = new Map();
  const accepted = new Map();
  for (const f of friends) {
    if (f.requester_id === f.addressee_id) bad('F-자기 자신', f.friend_id);
    const k = pairKey(f.requester_id, f.addressee_id);
    if (seen.has(k)) bad('F-두 사람 사이 한 행', `${f.friend_id} · ${seen.get(k)}`);
    seen.set(k, f.friend_id);
    const okStatus = hasBlocksTable ? ['PENDING', 'ACCEPTED'] : ['PENDING', 'ACCEPTED', 'BLOCKED'];
    if (!okStatus.includes(f.status)) bad('F-상태 값', `${f.friend_id}: ${f.status}`);
    if (f.status === 'ACCEPTED') {
      if (!f.accepted_at) bad('F-수락 시각', f.friend_id);
      for (const u of [f.requester_id, f.addressee_id]) accepted.set(u, (accepted.get(u) ?? 0) + 1);
    }
  }
  for (const [u, n] of accepted) if (n > 100) bad('F-친구 100명 상한', `${u}: ${n}`);

  const blocked = new Set(blocks.map((b) => pairKey(b.blocker_id, b.blocked_id)));
  for (const k of blocked) {
    if (seen.has(k)) bad('B-차단 쌍에 친구 행', `${k} → ${seen.get(k)}`);
  }
  for (const p of perms) {
    const k = pairKey(p.owner_id, p.grantee_id);
    if (blocked.has(k)) bad('B-차단 쌍에 공유 권한', p.permission_id);
    if (p.source_type === 'FRIEND') {
      const fr = friends.find((f) => f.friend_id === p.source_id);
      if (!fr) bad('P-친구 출처 권한의 친구 행 없음', p.permission_id);
      else if (fr.status !== 'ACCEPTED') bad('P-친구 출처 권한인데 친구 아님', `${p.permission_id}: ${fr.status}`);
      else if (pairKey(fr.requester_id, fr.addressee_id) !== k) bad('P-권한 출처 친구 행이 다른 두 사람', p.permission_id);
    }
  }
  return out;
}

// 공유 알람 조회 한 쌍: 보는 사람(grantee)이 주인(owner)의 알람을 조회한 결과 rows
//   권한 없음 · 차단 쌍인데 보이면 위반, 친구 출처 권한이 켜져 있는데 안 보이면 이상
export function checkSharedRead({ owner, grantee, rows, perms, friends, blocks }) {
  const out = [];
  const k = pairKey(owner, grantee);
  const isBlocked = blocks.some((b) => pairKey(b.blocker_id, b.blocked_id) === k);
  const mine = perms.filter((p) => p.owner_id === owner && p.grantee_id === grantee && p.can_view_alarm);
  const friend = friends.find((f) => pairKey(f.requester_id, f.addressee_id) === k && f.status === 'ACCEPTED');
  if (rows.length > 0 && isBlocked) out.push({ kind: 'VIOLATION', rule: 'B-차단 쌍인데 공유 알람이 보임', detail: `${grantee} → ${owner}` });
  else if (rows.length > 0 && mine.length === 0) out.push({ kind: 'VIOLATION', rule: 'P-권한 없는데 공유 알람이 보임', detail: `${grantee} → ${owner}` });
  if (rows.length === 0 && !isBlocked && friend && mine.some((p) => p.source_type === 'FRIEND' && p.source_id === friend.friend_id)) {
    out.push({ kind: 'ANOMALY', rule: '친구 출처 조회 권한이 켜져 있는데 공유 알람이 안 보임', detail: `${grantee} → ${owner}` });
  }
  return out;
}

// 그룹 노출: 내가 볼 수 있는 그룹은 내 멤버 행(초대 중 · 참여 중)이 있는 곳뿐
//   groups: [{group_id, owner_id}] — 아직 그룹장 칼럼이 남아 있는 동안은 그룹장이 나간 뒤에도 자기 그룹이 보임(5장 '그룹장 없음'에서 사라짐).
//   그건 알려진 동작(KNOWN)으로 따로 적고 위반으로 세지 않음. 그룹장도 아닌데 보이면 위반
export function checkGroupVisibility({ me, visibleGroupIds, members, groups = [] }) {
  const out = [];
  const mineOk = new Set(members.filter((m) => m.user_id === me && ['INVITED', 'JOINED'].includes(m.invite_status)).map((m) => m.group_id));
  for (const g of visibleGroupIds) {
    if (mineOk.has(g)) continue;
    const row = groups.find((x) => x.group_id === g);
    if (row && row.owner_id === me) {
      out.push({ kind: 'KNOWN', rule: 'G-그룹장이라 나간 뒤에도 보임 (5장 그룹장 없음 전 동작)', detail: `${me} → ${g}` });
    } else {
      out.push({ kind: 'VIOLATION', rule: 'G-멤버가 아닌 그룹이 보임', detail: `${me} → ${g}` });
    }
  }
  return out;
}

// 문서(세션약속 1절)에 있는 상태 값
export const STATUS = {
  send_friend_request: ['REQUESTED', 'ACCEPTED', 'ALREADY_REQUESTED', 'ALREADY_FRIEND', 'SELF', 'NOT_FOUND', 'LIMIT', 'FRIEND_LIMIT'],
  accept_friend_request: ['ACCEPTED', 'ALREADY_FRIEND', 'GONE', 'FRIEND_LIMIT'],
  decline_friend_request: ['DECLINED', 'GONE'],
  cancel_friend_request: ['CANCELED', 'GONE'],
  remove_friend: ['REMOVED', 'GONE'],
  block_user: ['BLOCKED', 'ALREADY_BLOCKED', 'SELF', 'NOT_FOUND'],
  unblock_user: ['UNBLOCKED', 'GONE'],
  search_by_handle: ['FOUND', 'SELF', 'NOT_FOUND', 'LIMIT'],
};

// 서버가 죽었다는 뜻의 오류 (권한 · 검사 거절은 정상 거절)
export function isServerFault(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  return code.startsWith('XX') || code === '57014' || /^PGRST00[0-3]$/.test(code) || /fetch failed|ECONNREFUSED/i.test(error.message ?? '');
}
