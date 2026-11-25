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
    if (p.can_edit_alarm && !p.can_view_alarm) bad('P-설정만 켜고 조회가 꺼짐 (설정⊂조회)', p.permission_id);
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

// 그룹 노출: 내가 볼 수 있는 그룹은 내 멤버 행이 있는 곳뿐.
//   strict(5장 이후) = 참여 중(JOINED)인 그룹만 보임 — 초대만 받은 사람은 그룹 표를 못 봄(초대 카드는 my_group_invites 함수로).
//   strict가 아니면 초대 중도 허용.
//   5장 이후: 만든 사람의 읽기 예외는 '만든 같은 트랜잭션' 안에서만이라 하루 끝 조회에는 걸리지 않음 → 나간 뒤에도 보이면 위반.
//   5장 전: 그룹장 정책이 남아 있어 나간 뒤에도 보이는 것은 알려진 동작(KNOWN)
export function checkGroupVisibility({ me, visibleGroupIds, members, groups = [], strict = false }) {
  const out = [];
  const okStatus = strict ? ['JOINED'] : ['INVITED', 'JOINED'];
  const mineOk = new Set(members.filter((m) => m.user_id === me && okStatus.includes(m.invite_status)).map((m) => m.group_id));
  for (const g of visibleGroupIds) {
    if (mineOk.has(g)) continue;
    const row = groups.find((x) => x.group_id === g);
    if (!strict && row && row.owner_id === me) {
      out.push({ kind: 'KNOWN', rule: 'G-그룹장이라 나간 뒤에도 보임 (5장 그룹장 없음 전 동작)', detail: `${me} → ${g}` });
    } else {
      out.push({ kind: 'VIOLATION', rule: strict ? 'G-참여 중이 아닌 그룹이 보임' : 'G-멤버가 아닌 그룹이 보임', detail: `${me} → ${g}` });
    }
  }
  return out;
}

// 구성원 행 노출(5장): 내 행 + 내가 참여 중인 그룹의 행만. 초대만 받은 사람은 다른 멤버 행을 못 봄
export function checkMemberRows({ me, rows, members }) {
  const out = [];
  const joined = new Set(members.filter((m) => m.user_id === me && m.invite_status === 'JOINED').map((m) => m.group_id));
  for (const r of rows) {
    if (r.user_id === me || joined.has(r.group_id)) continue;
    out.push({ kind: 'VIOLATION', rule: 'G-참여 중이 아닌 그룹의 구성원 행이 보임', detail: `${me} → ${r.group_id}/${r.user_id}` });
  }
  return out;
}

// 그룹 정적 규칙(5장): 그룹마다 참여 중 1명 이상(마지막이 나가면 자동 삭제), 참여 중 20명 이하, 한 사람 참여 그룹 10개 이하
export function checkGroups({ groups, members }) {
  const out = [];
  const joinedBy = new Map();
  for (const m of members) {
    if (m.invite_status !== 'JOINED') continue;
    joinedBy.set(m.group_id, (joinedBy.get(m.group_id) ?? 0) + 1);
  }
  for (const g of groups) {
    const n = joinedBy.get(g.group_id) ?? 0;
    if (n < 1) out.push({ kind: 'VIOLATION', rule: 'G-참여 중인 사람이 없는데 그룹이 남음', detail: g.group_id });
    if (n > 20) out.push({ kind: 'VIOLATION', rule: 'G-참여 중이 20명을 넘음', detail: `${g.group_id}: ${n}` });
  }
  const perUser = new Map();
  for (const m of members) if (m.invite_status === 'JOINED') perUser.set(m.user_id, (perUser.get(m.user_id) ?? 0) + 1);
  for (const [u, n] of perUser) if (n > 10) out.push({ kind: 'VIOLATION', rule: 'G-한 사람이 참여 그룹 10개를 넘음', detail: `${u}: ${n}` });
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
  set_wake_hidden: ['OK', 'NOT_FOUND'],
  plan_wake_ping: ['OK', 'WAIT', 'DAILY_LIMIT', 'ALREADY_UP', 'NOT_RINGING', 'OFF', 'FORBIDDEN'],
  propose_alarm_time: ['OK', 'FORBIDDEN', 'SAME', 'TOO_SOON', 'LIMIT', 'INVALID'],
  respond_alarm_proposal: ['APPLIED', 'DISMISSED', 'EXPIRED', 'LIMIT', 'NOT_FOUND'],
  save_group_permissions: ['OK', 'NOT_FOUND', 'NO_MEMBERS'],
  preview_group_by_code: ['FOUND', 'NOT_FOUND', 'EXPIRED', 'LIMIT'],
  join_group: ['JOINED', 'ALREADY_JOINED', 'NOT_FOUND', 'EXPIRED', 'LIMIT', 'FULL', 'TOO_MANY_GROUPS'],
  invite_to_group: ['INVITED', 'ALREADY_INVITED', 'ALREADY_MEMBER', 'SELF', 'NOT_FOUND'],
  accept_group_invite: ['JOINED', 'ALREADY_JOINED', 'GONE', 'FULL', 'TOO_MANY_GROUPS'],
};

// 서버가 죽었다는 뜻의 오류 (권한 · 검사 거절은 정상 거절)
export function isServerFault(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  return code.startsWith('XX') || code === '57014' || /^PGRST00[0-3]$/.test(code) || /fetch failed|ECONNREFUSED/i.test(error.message ?? '');
}

// ---------------------------------------------------------------------
// 7 · 8 · 9 · 10장: 기상 · 깨우기 · 공동 약속 · 알람 제안
// ---------------------------------------------------------------------

// 기상이 보이는가 (7장 can_see_wake): 둘 다 그 그룹에 참여 중 · 주인이 그 그룹에 기상 공유 동의 · 주인이 보는 사람에게 숨기지 않음 · 차단 쌍 아님
export function canSeeWake({ viewer, owner, groupId, members, hides = [], blocks = [] }) {
  const joined = (u) => members.find((m) => m.group_id === groupId && m.user_id === u && m.invite_status === 'JOINED');
  const ownerRow = joined(owner);
  if (!joined(viewer) || !ownerRow || !ownerRow.wake_share_opt_in) return false;
  if (hides.some((h) => h.owner_id === owner && h.hidden_from_id === viewer)) return false;
  if (blocks.some((b) => pairKey(b.blocker_id, b.blocked_id) === pairKey(viewer, owner))) return false;
  return true;
}

// 그룹 기상 줄: 내 줄 말고는 can_see_wake가 참인 사람만 있어야 함
export function checkWakeRows({ viewer, groupId, rows, members, hides = [], blocks = [] }) {
  const out = [];
  for (const r of rows) {
    if (r.is_me || r.user_id === viewer) continue;
    if (!canSeeWake({ viewer, owner: r.user_id, groupId, members, hides, blocks })) {
      out.push({ kind: 'VIOLATION', rule: 'W-기상 공유 조건 밖인데 그룹 기상 줄이 보임', detail: `${viewer} → ${r.user_id} @ ${groupId}` });
    }
  }
  return out;
}

// 깨우기 판정: FORBIDDEN이 아닌 어떤 상태든(OK · WAIT · 횟수 초과 · 이미 일어남 …) 둘 사이에 기상이 보이는 그룹이 있어야 함
export function checkPingVerdict({ sender, target, status, members, hides = [], blocks = [] }) {
  if (!status || status === 'FORBIDDEN') return [];
  const groups = [...new Set(members.map((m) => m.group_id))];
  const ok = groups.some((g) => canSeeWake({ viewer: sender, owner: target, groupId: g, members, hides, blocks }));
  return ok ? [] : [{ kind: 'VIOLATION', rule: 'W-기상이 안 보이는 사이인데 깨우기 판정이 FORBIDDEN이 아님', detail: `${sender} → ${target}: ${status}` }];
}

// 제안 보내기: OK가 돌아오려면 주인이 보낸 사람에게 설정 권한(조회 포함)을 줬고 차단 쌍이 아니어야 함
export function checkProposal({ proposer, owner, status, perms, blocks = [] }) {
  if (status !== 'OK') return [];
  const granted = perms.some((p) => p.owner_id === owner && p.grantee_id === proposer && p.can_edit_alarm && p.can_view_alarm);
  const blocked = blocks.some((b) => pairKey(b.blocker_id, b.blocked_id) === pairKey(proposer, owner));
  return granted && !blocked ? [] : [{ kind: 'VIOLATION', rule: 'A-설정 권한이 없거나 차단 쌍인데 알람 변경 제안이 됨', detail: `${proposer} → ${owner} (권한 ${granted}, 차단 ${blocked})` }];
}

// 공동 약속 고치기: 그룹에 참여 중인 그룹원 누구나 (#619 — 만든 사람은 기록일 뿐). 그룹 밖 사람이 고쳤으면 위반
export function checkApptEdit({ editor, rowsChanged, editorJoined = true }) {
  if (!rowsChanged || editorJoined) return [];
  return [{ kind: 'VIOLATION', rule: 'P9-그룹에 참여 중이 아닌 사람이 공동 약속을 고침', detail: `${editor}` }];
}

const kstDate = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);

// 정적 규칙: 기상 확인 하루 한 건(알람이 울리는 날 기준), 앞으로 공동 약속 참여는 그룹 참여 중인 사람만, 제안 합계 ±60분
export function checkWakeAndAppointments({ wakeEvents = [], alarms = [], participants = [], appointments = [], members = [], now = Date.now() }) {
  const out = [];
  const alarmDay = new Map(alarms.map((a) => [a.alarm_id, kstDate(a.scheduled_at)]));
  const perDay = new Map();
  for (const e of wakeEvents) {
    const day = alarmDay.get(e.alarm_id) ?? kstDate(e.event_at);
    const k = `${e.user_id}|${day}`;
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }
  for (const [k, n] of perDay) if (n > 1) out.push({ kind: 'VIOLATION', rule: 'W-기상 확인이 하루 한 건을 넘음', detail: `${k}: ${n}` });

  const joined = new Set(members.filter((m) => m.invite_status === 'JOINED').map((m) => `${m.group_id}|${m.user_id}`));
  for (const a of appointments) {
    if (!a.group_id || new Date(a.appointment_at).getTime() <= now) continue;
    for (const p of participants.filter((x) => x.appointment_id === a.appointment_id)) {
      if (!joined.has(`${a.group_id}|${p.user_id}`)) out.push({ kind: 'VIOLATION', rule: 'P9-그룹을 나갔는데 앞으로 공동 약속 참여가 남음', detail: `${p.user_id} @ ${a.appointment_id}` });
    }
  }
  for (const a of alarms) {
    if (!a.original_scheduled_at) continue;
    const gap = Math.abs(new Date(a.scheduled_at).getTime() - new Date(a.original_scheduled_at).getTime());
    if (gap > 3600e3 + 60e3) out.push({ kind: 'VIOLATION', rule: 'A-친구가 바꾼 합계가 ±60분을 넘음', detail: a.alarm_id });
  }
  return out;
}
