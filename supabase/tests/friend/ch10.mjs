// 친구 10장 — 친구가 내 알람 바꾸기 = 제안 (친구_시험케이스.md 10장 DB · 함수 층, 11/8 확정)
//   항목 이름 앞 번호 = 시험케이스 번호
//   이 장 DB에 없는 것: 10-02 · 10-30(실기기) · 10-04 · 10-14의 화면 글자 · 10-15 · 10-25 ~ 10-27(알림 서버 함수 쪽 = notify.test.ts) · 10-22 · 10-23(서버 함수 쪽 = edit-run.test.ts · commit.test.ts) ·
//                    10-28 ~ 10-29 · 10-31 ~ 10-33 · 10-36(앱) · 10-32(대본) · 10-37(알림 문구 = push-copy.test.ts)
//   친구가 직접 고치는 옛 길(alarms_update_shared)은 G04가 제안으로 바뀐 뒤(PR #423) 11/9에 닫음(이슈 #427) → 10-03 · 10-05 ~ 10-07 · 10-10 · 10-16의 '직접 update 0행'은 아래 '직접 update 0행' 시험에서, 제안 보내기가 거절하는 것은 그 밖의 시험들에서 확인
//   시간은 지금(now()) 기준 상대값만 씀 — 시계가 가도 안 바뀌게. 사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch10({ q, as, su, svc, check, expectErr }) {
  const id = (n) => `ba000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const NOBODY = 'ba000000-0000-4000-8000-999999999999';

  const join_ = async (n, nickname) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `f10-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f10_user_${n}`]);
    return id(n);
  };
  const call = async (uid, sql, params = []) => { await as(uid); const [r] = await q(`select ${sql} as r`, params); await su(); return r.r; };
  const clearLimits = (...uids) => q(`delete from public.rate_limit_events where user_id = any($1::uuid[])`, [uids]);
  const befriend = async (a, b) => {
    await call(a, 'public.send_friend_request($1)', [b]);
    await call(b, 'public.accept_friend_request($1)', [a]);
    await clearLimits(a, b);
  };
  const friendId = async (a, b) => (await q(`select friend_id from public.friends
                                             where least(requester_id, addressee_id) = least($1::uuid, $2::uuid)
                                               and greatest(requester_id, addressee_id) = greatest($1::uuid, $2::uuid)`, [a, b]))[0]?.friend_id ?? null;
  const grant = async (owner, grantee, view = true, edit = true) => {
    const f = await friendId(owner, grantee);
    await as(owner);
    const [r] = await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm)
                         values ($1, $2, 'FRIEND', $3, $4, $5) returning permission_id`, [owner, grantee, f, view, edit]);
    await su();
    return r.permission_id;
  };
  // 약속 카드 하나 = 기상 · 준비 · 출발 알람 (지금 + hours 시간 뒤 기상, 20분 간격)
  const card = async (owner, { hours = 8, groupId = null, enabled = true } = {}) => {
    const [ap] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name)
                          values ($1, $2, '약속', now() + interval '${hours + 2} hours', '학교') returning appointment_id`, [owner, groupId]);
    const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap.appointment_id, owner]);
    const ids = {};
    for (const [type, plus] of [['WAKE', 0], ['PREPARE', 20], ['DEPARTURE', 40]]) {
      ids[type] = (await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at, is_enabled)
                            values ($1, $2, $3, date_trunc('minute', now() + interval '${hours} hours') + interval '${plus} minutes', $4) returning alarm_id`, [pt.participant_id, owner, type, enabled]))[0].alarm_id;
    }
    return { ap: ap.appointment_id, pt: pt.participant_id, ...ids };
  };
  const alarm = async (alarmId) => (await q(`select alarm_id, alarm_type, scheduled_at, time_source, original_scheduled_at, original_time_source, is_enabled from public.alarms where alarm_id = $1`, [alarmId]))[0];
  const ms = (v) => new Date(v).getTime();
  const min = (n) => n * 60_000;
  const propose = async (uid, alarmId, newAt) => call(uid, 'public.propose_alarm_time($1, $2::timestamptz)', [alarmId, newAt]);
  const shifted = async (alarmId, minutes) => (await q(`select (scheduled_at + interval '${minutes} minutes') as t from public.alarms where alarm_id = $1`, [alarmId]))[0].t;
  const respond = (uid, pid, apply) => call(uid, 'public.respond_alarm_proposal($1, $2)', [pid, apply]);
  const inbox = async (uid) => { await as(uid); const r = await q(`select * from public.my_alarm_proposals()`); await su(); return r; };
  const sent = async (uid, owner) => { await as(uid); const r = await q(`select * from public.sent_alarm_proposals($1)`, [owner]); await su(); return r; };
  const canPush = async (s, t, k = 'ALARM_CHANGED') => { await svc(); const r = (await q(`select public.can_send_push($1, $2, $3) as ok`, [s, t, k]))[0].ok; await su(); return r; };
  const pair = async (n, { edit = true, view = true } = {}) => {
    const A = await join_(n, '주인'), B = await join_(n + 1, '친구');
    await befriend(A, B);
    const perm = await grant(A, B, view, edit);
    const c = await card(A);
    return { A, B, perm, c };
  };

  // ---- 제안 보내기 · 적용 ----------------------------------------------------------------------

  await check('10-01 · 10-35: 설정 권한이 있는 친구가 보내면 제안만 생기고 내 알람은 안 바뀜 — 받은 제안 카드에 보낸 사람 이름 · 이전 → 새 시각, [적용]하면 카드(기상 · 준비 · 출발)가 같이 움직이고 MANUAL · 원래 시각 기억', async () => {
    const { A, B, c } = await pair(1);
    const [{ alarm_id: past }] = await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'ARRIVE', now() - interval '30 minutes') returning alarm_id`, [c.pt, A]);   // 이미 울린 같은 카드의 알람
    const pastBefore = ms((await alarm(past)).scheduled_at);
    const before = await alarm(c.WAKE);
    const target = await shifted(c.WAKE, -5);
    const r = await propose(B, c.WAKE, target);
    const unchanged = await alarm(c.WAKE);
    const list = await inbox(A);
    const applied = await respond(A, r.proposal_id, true);
    const after = [await alarm(c.WAKE), await alarm(c.PREPARE), await alarm(c.DEPARTURE)];
    const orig = [before.scheduled_at];
    const done = (await q(`select status, responded_at is not null as responded from public.alarm_proposals where proposal_id = $1`, [r.proposal_id]))[0];
    return r.status === 'OK' && ms(r.from_at) === ms(before.scheduled_at) && ms(r.to_at) === ms(target)
      && ms(unchanged.scheduled_at) === ms(before.scheduled_at) && unchanged.time_source === before.time_source && unchanged.original_scheduled_at == null
      && list.length === 1 && list[0].proposal_id === r.proposal_id && list[0].proposer_id === B && list[0].proposer_nickname === '친구' && list[0].alarm_type === 'WAKE' && ms(list[0].from_at) === ms(before.scheduled_at) && ms(list[0].to_at) === ms(target)
      && applied.status === 'APPLIED' && applied.alarm_ids.length === 3
      && ms(after[0].scheduled_at) === ms(target) && ms(after[1].scheduled_at) === ms(target) + min(20) && ms(after[2].scheduled_at) === ms(target) + min(40)
      && after.every((x) => x.time_source === 'MANUAL') && ms(after[0].original_scheduled_at) === ms(orig[0])
      && ms((await alarm(past)).scheduled_at) === pastBefore && !applied.alarm_ids.includes(past)   // 이미 울린 알람은 안 움직임
      && done.status === 'APPLIED' && done.responded === true ? true : { r, unchanged, list, applied, after, done };
  });

  await check('10-03 · 10-05 ~ 10-07 · 10-09 · 10-18 ~ 10-20 · 10-21: 권한이 없거나 거둬졌거나 끊겼으면 · 남의 알람 · 이미 울린 · 꺼 둔 · 루틴 · 단독 알람 · 자기 자신 · 없는 알람은 모두 같은 FORBIDDEN, 공동 약속에 붙은 내 알람은 제안이 되고 적용하면 내 알람만 바뀜(약속 그대로)', async () => {
    const view = await pair(3, { edit: false });                                              // 조회만
    const t = (c) => shifted(c.WAKE, -5);
    const viewOnly = await propose(view.B, view.c.WAKE, await t(view.c));
    const rev = await pair(5);
    await as(rev.A); await q(`delete from public.sharing_permissions where permission_id = $1`, [rev.perm]); await su();   // 방금 권한 회수
    const revoked = await propose(rev.B, rev.c.WAKE, await t(rev.c));
    const ended = await pair(7);
    await call(ended.A, 'public.remove_friend($1)', [ended.B]);                                    // 친구 끊김
    const unfriended = await propose(ended.B, ended.c.WAKE, await t(ended.c));
    const ok = await pair(9);
    const other = await join_(11, '남');
    const otherCard = await card(other);
    const crossOwner = await propose(ok.B, otherCard.WAKE, await t(otherCard));               // 설정 권한은 주인 알람에만
    const past = await card(ok.A, { hours: -2 });
    const rung = await propose(ok.B, past.WAKE, await shifted(past.WAKE, 5));                 // 이미 울린 알람
    const off = await card(ok.A, { hours: 12, enabled: false });
    const disabled = await propose(ok.B, off.WAKE, await shifted(off.WAKE, -5));
    const [{ alarm_id: solo }] = await q(`insert into public.alarms (user_id, alarm_type, scheduled_at) values ($1, 'WAKE', now() + interval '9 hours') returning alarm_id`, [ok.A]);
    const standalone = await propose(ok.B, solo, await shifted(solo, -5));                    // 일정에 안 붙은 알람
    const [{ routine_id: rt }] = await q(`insert into public.routines (user_id, title) values ($1, '루틴') returning routine_id`, [ok.A]);
    const [{ alarm_id: ra }] = await q(`insert into public.alarms (routine_id, step_order, user_id, alarm_type, scheduled_at) values ($1, 1, $2, 'ROUTINE', now() + interval '7 hours') returning alarm_id`, [rt, ok.A]);
    const routine = await propose(ok.B, ra, await shifted(ra, -5));
    const me = await propose(ok.A, ok.c.WAKE, await t(ok.c));                                 // 내 알람을 내가
    const ghost = await propose(ok.B, '00000000-0000-4000-8000-00000000dead', new Date(Date.now() + 9 * 3600_000).toISOString());
    const nulls = [await propose(ok.B, null, new Date().toISOString()), await propose(ok.B, ok.c.WAKE, null)];
    const nothing = await q(`select count(*)::int as n from public.alarm_proposals where proposer_id = any($1::uuid[])`, [[view.B, rev.B, ended.B, ok.B]]);
    // 공동 약속에 연결된 내 알람 (10-21)
    const gOwner = await join_(13, '그룹주인'), gFriend = await join_(14, '그룹친구');
    await befriend(gOwner, gFriend);
    await grant(gOwner, gFriend);
    await as(gOwner);
    const [{ group_id: gid }] = await q(`insert into public.groups (group_name, owner_id) values ('제안그룹', $1) returning group_id`, [gOwner]);
    await su();
    await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at) values ($1, $2, 'JOINED', now())`, [gid, gFriend]);
    const gc = await card(gOwner, { groupId: gid });
    const apptBefore = (await q(`select appointment_at from public.appointments where appointment_id = $1`, [gc.ap]))[0].appointment_at;
    const gp = await propose(gFriend, gc.WAKE, await shifted(gc.WAKE, -10));
    const gApplied = await respond(gOwner, gp.proposal_id, true);
    const apptAfter = (await q(`select appointment_at from public.appointments where appointment_id = $1`, [gc.ap]))[0].appointment_at;
    const only = JSON.stringify({ status: 'FORBIDDEN' });
    const shapes = [viewOnly, revoked, unfriended, crossOwner, rung, disabled, standalone, routine, me, ghost, ...nulls].map((x) => JSON.stringify(x));
    return shapes.slice(0, 10).every((x) => x === only) && nulls.every((x) => x.status === 'INVALID' || x.status === 'FORBIDDEN') && nothing[0].n === 0
      && gp.status === 'OK' && gApplied.status === 'APPLIED' && ms(apptBefore) === ms(apptAfter) ? true : { shapes, nulls, nothing, gp, gApplied };
  });

  await check('10-13: 합계 ±60분 — 원래 시각 기준(적용한 제안을 합쳐 셈) 5분씩 12번까지 되고 13번째는 LIMIT, 시각을 골라 한 번에 ±60분 안이면 되고 밖이면 LIMIT, [원래대로]는 늘 됨(적용하면 원래 시각 기억이 비워짐)', async () => {
    const { A, B, c } = await pair(15);
    const base = ms((await alarm(c.WAKE)).scheduled_at);
    const outside = await propose(B, c.WAKE, new Date(base + min(65)).toISOString());
    const insideEdge = await propose(B, c.WAKE, new Date(base - min(60)).toISOString());
    const dismissed = await respond(A, insideEdge.proposal_id, false);
    const just61 = await propose(B, c.WAKE, new Date(base + min(61)).toISOString());                // 61분은 밖
    const edge30 = await propose(B, c.WAKE, new Date(base + min(60) + 30_000).toISOString());       // 60분 30초는 분 단위로 맞춰져 60분 → 안
    const steps = [];
    for (let i = 1; i <= 12; i++) {
      const r = await propose(B, c.WAKE, new Date(base + min(5 * i)).toISOString());
      steps.push(r.status);
      steps.push((await respond(A, r.proposal_id, true)).status);
    }
    const now60 = await alarm(c.WAKE);
    const thirteenth = await propose(B, c.WAKE, new Date(base + min(65)).toISOString());
    const backToOriginal = await propose(B, c.WAKE, new Date(base).toISOString());              // 원래대로
    const restored = await respond(A, backToOriginal.proposal_id, true);
    const end = await alarm(c.WAKE);
    return outside.status === 'LIMIT' && insideEdge.status === 'OK' && dismissed.status === 'DISMISSED'
      && just61.status === 'LIMIT' && edge30.status === 'OK' && ms(edge30.to_at) === base + min(60)
      && steps.every((x, i) => x === (i % 2 === 0 ? 'OK' : 'APPLIED')) && ms(now60.scheduled_at) === base + min(60) && ms(now60.original_scheduled_at) === base
      && thirteenth.status === 'LIMIT' && backToOriginal.status === 'OK' && restored.status === 'APPLIED'
      && ms(end.scheduled_at) === base && end.original_scheduled_at == null ? true : { outside, insideEdge, just61, edge30, steps, now60, thirteenth, backToOriginal, restored, end };
  });

  await check('10-14: 곧 울릴 알람은 거절(TOO_SOON) — 알람이 지금 + 10분 안이거나 새 시각이 지금 + 5분 이전이면, 같은 시각은 SAME', async () => {
    const { B, c } = await pair(17);
    const soon = await card((await q(`select creator_id from public.appointments where appointment_id = $1`, [c.ap]))[0].creator_id, { hours: 0 });
    await q(`update public.alarms set scheduled_at = now() + interval '3 minutes' where alarm_id = $1`, [soon.WAKE]);
    const near = await propose(B, soon.WAKE, new Date(Date.now() - 60_000).toISOString());
    const soonRing = await propose(B, soon.WAKE, new Date(Date.now() + 40 * 60_000).toISOString());
    const early = await card((await q(`select creator_id from public.appointments where appointment_id = $1`, [c.ap]))[0].creator_id, { hours: 1 });
    const intoPast = await propose(B, early.WAKE, new Date(Date.now() + 2 * 60_000).toISOString());   // 새 시각이 지금 + 5분 이전
    const owner = (await q(`select creator_id from public.appointments where appointment_id = $1`, [c.ap]))[0].creator_id;
    const seven = await card(owner, { hours: 3 }), twelve = await card(owner, { hours: 4 });
    await q(`update public.alarms set scheduled_at = date_trunc('minute', now()) + interval '7 minutes' where alarm_id = $1`, [seven.WAKE]);
    await q(`update public.alarms set scheduled_at = date_trunc('minute', now()) + interval '13 minutes' where alarm_id = $1`, [twelve.WAKE]);
    const sevenR = await propose(B, seven.WAKE, new Date(Date.now() + 40 * 60_000).toISOString());   // 알람이 지금 + 7분 → 아직 10분 안
    const twelveR = await propose(B, twelve.WAKE, new Date(Date.now() + 40 * 60_000).toISOString()); // 지금 + 13분 → 10분 밖이라 됨
    const same = await propose(B, c.WAKE, (await alarm(c.WAKE)).scheduled_at);
    const okNear = await propose(B, early.WAKE, new Date(Date.now() + 6 * 60_000).toISOString());     // 지금 + 6분은 됨
    return near.status === 'TOO_SOON' && soonRing.status === 'TOO_SOON' && intoPast.status === 'TOO_SOON' && same.status === 'SAME' && okNear.status === 'OK'
      && sevenR.status === 'TOO_SOON' && twelveR.status === 'OK' ? true : { near, soonRing, intoPast, same, okNear, sevenR, twelveR };
  });

  await check('10-24: 두 친구가 같은 알람에 보내면 대기 중 제안은 하나 — 늦게 보낸 값이 남고 먼저 보낸 제안은 대체됨(보낸 친구마다 알림 1개), 받은 목록에는 늦게 보낸 것만', async () => {
    const { A, B, c } = await pair(19);
    const C = await join_(21, '다른친구');
    await befriend(A, C); await grant(A, C);
    const one = await propose(B, c.WAKE, await shifted(c.WAKE, -5));
    const two = await propose(C, c.WAKE, await shifted(c.WAKE, -10));
    const list = await inbox(A);
    const rows = await q(`select proposer_id, status from public.alarm_proposals where alarm_id = $1 order by created_at, proposal_id`, [c.WAKE]);
    const old = await respond(A, one.proposal_id, true);                                          // 대체된 제안은 적용할 수 없음
    const win = await respond(A, two.proposal_id, true);
    const end = await alarm(c.WAKE);
    return one.status === 'OK' && two.status === 'OK' && list.length === 1 && list[0].proposer_id === C
      && rows.length === 2 && rows[0].status === 'REPLACED' && rows[1].status === 'PENDING' && old.status === 'NOT_FOUND' && win.status === 'APPLIED'
      && ms(end.scheduled_at) === ms(two.to_at) ? true : { one, two, list, rows, old, win };
  });

  await check('10-34 · 10-36: [무시]하면 알람 그대로 · 받은 목록에서 사라지고 보낸 친구는 계속 제안함, 주인이 그사이 직접 고쳤으면 [적용]은 EXPIRED(직접 수정이 위, 원래 시각 기억도 비워짐), 알람 시각이 지났으면 EXPIRED', async () => {
    const { A, B, c } = await pair(22);
    const p1 = await propose(B, c.WAKE, await shifted(c.WAKE, -5));
    const before = await alarm(c.WAKE);
    const ignored = await respond(A, p1.proposal_id, false);
    const afterIgnore = await alarm(c.WAKE);
    const listAfter = await inbox(A);
    const sentView = await sent(B, A);
    // 주인이 직접 고침 (원래 시각 기억은 앱이 못 쓰고, 시각이 바뀌면 서버가 비움)
    const p2 = await propose(B, c.WAKE, await shifted(c.WAKE, -10));
    await as(A); await q(`update public.alarms set scheduled_at = scheduled_at + interval '3 minutes', original_scheduled_at = now() where alarm_id = $1`, [c.WAKE]); await su();
    const edited = await alarm(c.WAKE);
    const stale = await respond(A, p2.proposal_id, true);
    const state = (await q(`select status from public.alarm_proposals where proposal_id = $1`, [p2.proposal_id]))[0].status;
    // 알람 시각이 지남
    const p3 = await propose(B, c.PREPARE, await shifted(c.PREPARE, -5));
    await q(`update public.alarm_proposals set from_at = now() - interval '1 minute' where proposal_id = $1`, [p3.proposal_id]);
    const late = await respond(A, p3.proposal_id, true);
    const lateList = await inbox(A);
    return ignored.status === 'DISMISSED' && ms(afterIgnore.scheduled_at) === ms(before.scheduled_at) && listAfter.length === 0
      && sentView.length === 1 && sentView[0].status === 'PENDING' && sentView[0].alarm_id === c.WAKE
      && edited.original_scheduled_at == null && stale.status === 'EXPIRED' && state === 'EXPIRED' && late.status === 'EXPIRED' && lateList.length === 0 ? true : { ignored, listAfter, sentView, edited, stale, state, late, lateList };
  });

  await check('10-05(대기 중 제안): 제안을 보낸 뒤 설정 권한이 거둬지면 받은 목록에서 사라지고 [적용]은 EXPIRED, 보낸 쪽 조회도 빈 목록 — 두 친구 중 늦게 보낸 쪽이 이기면 먼저 보낸 친구의 제안 줄은 보낸 목록에 안 나옴', async () => {
    const { A, B, perm, c } = await pair(40);
    const p = await propose(B, c.WAKE, await shifted(c.WAKE, -5));
    const before = [(await inbox(A)).length, (await sent(B, A)).length];
    await as(A); await q(`delete from public.sharing_permissions where permission_id = $1`, [perm]); await su();
    const after = [(await inbox(A)).length, (await sent(B, A)).length];
    const resp = await respond(A, p.proposal_id, true);
    const unchanged = await alarm(c.WAKE);
    // 대체된 제안은 보낸 친구 목록에 안 나옴
    const { A: A2, B: B2, c: c2 } = await pair(42);
    const C2 = await join_(44, '다른친구');
    await befriend(A2, C2); await grant(A2, C2);
    await propose(B2, c2.WAKE, await shifted(c2.WAKE, -5));
    await propose(C2, c2.WAKE, await shifted(c2.WAKE, -10));
    const replaced = [(await sent(B2, A2)).length, (await sent(C2, A2)).length];
    return JSON.stringify(before) === '[1,1]' && JSON.stringify(after) === '[0,0]' && resp.status === 'EXPIRED' && ms(unchanged.scheduled_at) === ms(p.from_at)
      && JSON.stringify(replaced) === '[0,1]' ? true : { before, after, resp, replaced };
  });

  await check('10-34(만기): 알람 시각이 지났거나 · 새 시각이 곧 지나거나 · 그사이 원래 시각 기준이 바뀌어 ±60분을 넘으면 [적용]은 EXPIRED / LIMIT, 받은 목록은 지난 알람 · 주인이 직접 고친 알람의 제안을 안 보여 주고 보낸 목록은 지난 알람을 안 보여 줌', async () => {
    const { A, B, c } = await pair(46);
    const c2 = await card(A, { hours: 10 }), c3 = await card(A, { hours: 12 }), c4 = await card(A, { hours: 14 }), c5 = await card(A, { hours: 16 }), c6 = await card(A, { hours: 18 });
    // 알람 시각이 지남 (알람 시각과 제안 때 시각이 같은 채로)
    const p1 = await propose(B, c.WAKE, await shifted(c.WAKE, -5));
    await q(`update public.alarms set scheduled_at = now() - interval '1 minute' where alarm_id = $1`, [c.WAKE]);
    await q(`update public.alarm_proposals set from_at = (select scheduled_at from public.alarms where alarm_id = $1) where proposal_id = $2`, [c.WAKE, p1.proposal_id]);
    const r1 = await respond(A, p1.proposal_id, true);
    // 새 시각이 곧 지나감
    const p2 = await propose(B, c2.WAKE, await shifted(c2.WAKE, -5));
    await q(`update public.alarm_proposals set to_at = now() + interval '1 minute' where proposal_id = $1`, [p2.proposal_id]);
    const r2 = await respond(A, p2.proposal_id, true);
    // 보낸 뒤 원래 시각 기준이 바뀜 → 합계 ±60분을 넘음
    const p3 = await propose(B, c3.WAKE, await shifted(c3.WAKE, -5));
    await q(`update public.alarms set original_scheduled_at = scheduled_at + interval '59 minutes' where alarm_id = $1`, [c3.WAKE]);
    const r3 = await respond(A, p3.proposal_id, true);
    const s3 = (await q(`select status from public.alarm_proposals where proposal_id = $1`, [p3.proposal_id]))[0].status;
    // 대기 중이지만 제안 때 시각이 지난 것 / 주인이 직접 고친 것은 받은 목록에 안 나옴
    const p4 = await propose(B, c4.WAKE, await shifted(c4.WAKE, -5));
    await q(`update public.alarm_proposals set from_at = now() - interval '1 minute' where proposal_id = $1`, [p4.proposal_id]);
    const p5 = await propose(B, c5.WAKE, await shifted(c5.WAKE, -5));
    await as(A); await q(`update public.alarms set scheduled_at = scheduled_at + interval '3 minutes' where alarm_id = $1`, [c5.WAKE]); await su();
    const p6 = await propose(B, c6.WAKE, await shifted(c6.WAKE, -5));
    // 알람 시각이 그냥 지나간 것(알람 시각 = 제안 때 시각, 둘 다 과거)도 대기 중이어도 안 나옴
    const c7 = await card(A, { hours: 20 });
    const p7 = await propose(B, c7.WAKE, await shifted(c7.WAKE, -5));
    await q(`update public.alarms set scheduled_at = now() - interval '1 minute' where alarm_id = $1`, [c7.WAKE]);
    await q(`update public.alarm_proposals set from_at = (select scheduled_at from public.alarms where alarm_id = $1) where proposal_id = $2`, [c7.WAKE, p7.proposal_id]);
    const shown = await inbox(A);
    // 보낸 목록은 알람 시각이 지난 것을 안 보여 줌
    const sentBefore = (await sent(B, A)).some((x) => x.alarm_id === c6.WAKE);
    await q(`update public.alarms set scheduled_at = now() - interval '2 minutes' where alarm_id = $1`, [c6.WAKE]);
    const sentAfter = (await sent(B, A)).some((x) => x.alarm_id === c6.WAKE);
    return r1.status === 'EXPIRED' && r2.status === 'EXPIRED' && r3.status === 'LIMIT' && s3 === 'EXPIRED'
      && shown.every((x) => x.proposal_id !== p4.proposal_id && x.proposal_id !== p5.proposal_id && x.proposal_id !== p7.proposal_id) && shown.some((x) => x.proposal_id === p6.proposal_id)
      && sentBefore === true && sentAfter === false ? true : { r1, r2, r3, s3, shown: shown.map((x) => x.proposal_id), p4, p5, p6, sentBefore, sentAfter };
  });

  await check('10-03 · 10-05(응답 쪽): 남의 제안은 적용 · 무시할 수 없음(NOT_FOUND) — 보낸 친구 · 제3자 · 이미 처리한 제안 · 없는 제안', async () => {
    const { A, B, c } = await pair(24);
    const X = await join_(26, '제3자');
    const p = await propose(B, c.WAKE, await shifted(c.WAKE, -5));
    const results = [await respond(B, p.proposal_id, true), await respond(X, p.proposal_id, true), await respond(X, p.proposal_id, false), await respond(A, NOBODY, true), await respond(A, null, true)];
    const stillPending = (await q(`select status from public.alarm_proposals where proposal_id = $1`, [p.proposal_id]))[0].status;
    const done = await respond(A, p.proposal_id, true);
    const again = await respond(A, p.proposal_id, true);
    return results.every((x) => x.status === 'NOT_FOUND') && stillPending === 'PENDING' && done.status === 'APPLIED' && again.status === 'NOT_FOUND' ? true : { results, stillPending, done, again };
  });

  await check('10-29 · 보낸 제안 조회: 알람마다 가장 최근 제안 한 줄(제안함 · 반영됨 — 무시된 것도 제안함), 같은 카드의 다른 대기 제안은 적용 뒤 만료(시각이 어긋나서), 제안 표는 주인 본인 줄만 읽히고 보낸 친구는 함수로만 봄', async () => {
    const { A, B, c } = await pair(27);
    const X = await join_(29, '제3자');
    const c2 = await card(A, { hours: 10 });
    const p1 = await propose(B, c.WAKE, await shifted(c.WAKE, -5));
    const p2 = await propose(B, c2.WAKE, await shifted(c2.WAKE, -5));
    const p3 = await propose(B, c.PREPARE, await shifted(c.PREPARE, -5));                    // 같은 카드의 다른 알람
    await respond(A, p1.proposal_id, true);
    const sentRows = await sent(B, A);
    const byAlarm = Object.fromEntries(sentRows.map((r) => [r.alarm_id, r.status]));
    const sameCard = (await q(`select status from public.alarm_proposals where proposal_id = $1`, [p3.proposal_id]))[0].status;
    const thirdParty = await sent(X, A);
    const noEdit = await sent(A, B);
    const mine = await inbox(A);
    await as(X); const peek = await q(`select * from public.alarm_proposals`); await su();
    await as(B); const peekB = await q(`select * from public.alarm_proposals`); await su();
    await as(A); const peekA = await q(`select * from public.alarm_proposals`); await su();
    // 한 알람에 제안이 둘 이상 남으면(무시된 옛 제안 + 새 대기 제안) 가장 최근 하나만
    const c3 = await card(A, { hours: 11 });
    const old = await propose(B, c3.WAKE, await shifted(c3.WAKE, -5));
    await respond(A, old.proposal_id, false);
    const fresh = await propose(B, c3.WAKE, await shifted(c3.WAKE, -10));
    const latest = (await sent(B, A)).filter((r) => r.alarm_id === c3.WAKE);
    return sentRows.length === 2 && byAlarm[c.WAKE] === 'APPLIED' && byAlarm[c2.WAKE] === 'PENDING' && sameCard === 'EXPIRED' && thirdParty.length === 0 && noEdit.length === 0
      && mine.length === 1 && mine[0].proposal_id === p2.proposal_id && peek.length === 0 && peekB.length === 0 && peekA.length === 3
      && latest.length === 1 && latest[0].proposal_id === fresh.proposal_id && latest[0].status === 'PENDING' ? true : { sentRows, sameCard, thirdParty, noEdit, mine, peek: peek.length, peekB: peekB.length, peekA: peekA.length, latest, fresh };
  });

  await check('[원래대로] 복원: 친구가 바꾸기 전의 time_source로 돌아옴 — 자동 계산이던 카드는 다시 AUTO(자동 재계산이 다시 덮을 수 있음), 주인이 직접 골랐던 알람은 계속 MANUAL, 기억 칸은 둘 다 비워짐', async () => {
    const { A, B, c } = await pair(50);                                                       // 카드 알람은 AUTO
    const manualCard = await card(A, { hours: 10 });
    await q(`update public.alarms set time_source = 'MANUAL' where alarm_id = $1`, [manualCard.WAKE]);      // 주인이 직접 고른 기상
    const out = {};
    for (const [name, cc] of [['auto', c], ['manual', manualCard]]) {
      const base = ms((await alarm(cc.WAKE)).scheduled_at);
      const p1 = await propose(B, cc.WAKE, new Date(base - min(10)).toISOString());
      await respond(A, p1.proposal_id, true);
      const mid = [await alarm(cc.WAKE), await alarm(cc.PREPARE)];
      const p2 = await propose(B, cc.WAKE, new Date(base).toISOString());                      // 원래대로
      await respond(A, p2.proposal_id, true);
      out[name] = { mid, end: [await alarm(cc.WAKE), await alarm(cc.PREPARE)], base };
    }
    const a = out.auto, m = out.manual;
    return a.mid.every((x) => x.time_source === 'MANUAL' && x.original_time_source === 'AUTO' && x.original_scheduled_at != null)
      && a.end.every((x) => x.time_source === 'AUTO' && x.original_scheduled_at == null && x.original_time_source == null) && ms(a.end[0].scheduled_at) === a.base
      && m.mid[0].original_time_source === 'MANUAL' && m.mid[1].original_time_source === 'AUTO'
      && m.end[0].time_source === 'MANUAL' && m.end[0].original_scheduled_at == null && m.end[0].original_time_source == null && m.end[1].time_source === 'AUTO' ? true : out;
  });

  await check('이른 알람이 과거로 가는 제안: 같은 카드의 다른 알람이 같은 만큼 움직여 지금 + 5분 이전이 되면 제안은 TOO_SOON, 이미 보낸 제안은 그사이 형제 알람이 곧 울리게 되면 [적용]이 EXPIRED(아무것도 안 움직임)', async () => {
    const { A, B } = await pair(52);
    const near = await card(A, { hours: 10 });
    await q(`update public.alarms set scheduled_at = date_trunc('minute', now()) + interval '12 minutes' where alarm_id = $1`, [near.WAKE]);
    await q(`update public.alarms set scheduled_at = date_trunc('minute', now()) + interval '32 minutes' where alarm_id = $1`, [near.PREPARE]);
    await q(`update public.alarms set scheduled_at = date_trunc('minute', now()) + interval '52 minutes' where alarm_id = $1`, [near.DEPARTURE]);
    const tooSoon = await propose(B, near.DEPARTURE, new Date(Date.now() + 8 * 60_000).toISOString());     // 출발을 44분 당기면 기상이 지금 − 32분
    const tooSoon2 = await propose(B, near.DEPARTURE, new Date(Date.now() + 52 * 60_000 - 10 * 60_000).toISOString());   // 10분 당기면 기상이 지금 + 2분 → 이것도 5분 이전
    const small = await propose(B, near.DEPARTURE, new Date(Date.now() + 52 * 60_000 - 5 * 60_000).toISOString());  // 5분 당기면 기상이 지금 + 7분 → 되지만 곧 울림(알람 10분 안이 아니라 출발 기준이라 OK)
    const far = await card(A, { hours: 10 });
    const sent1 = await propose(B, far.DEPARTURE, await shifted(far.DEPARTURE, -44));
    await q(`update public.alarms set scheduled_at = date_trunc('minute', now()) + interval '12 minutes' where alarm_id = $1`, [far.WAKE]);      // 그사이 기상이 곧 울릴 시각
    const late = await respond(A, sent1.proposal_id, true);
    const after = [await alarm(far.WAKE), await alarm(far.DEPARTURE)];
    const state = (await q(`select status from public.alarm_proposals where proposal_id = $1`, [sent1.proposal_id]))[0].status;
    return tooSoon.status === 'TOO_SOON' && tooSoon2.status === 'TOO_SOON' && small.status === 'OK'
      && sent1.status === 'OK' && late.status === 'EXPIRED' && state === 'EXPIRED'
      && after[0].time_source === 'AUTO' && after[0].original_scheduled_at == null && ms(after[1].scheduled_at) === ms(sent1.from_at) ? true : { tooSoon, tooSoon2, small, sent1, late, state, after };
  });

  await check('받은 목록 · 보낸 목록 범위: 다른 주인에게 보낸 제안이 섞이지 않고, 꺼진 알람 · 새 시각이 곧 지나는 제안은 받은 목록에서 빠지며 [적용]은 EXPIRED', async () => {
    const { A: A1, B, c } = await pair(54);
    const A2 = await join_(56, '다른주인');
    await befriend(A2, B); await grant(A2, B);
    const c2 = await card(A2);
    const p1 = await propose(B, c.WAKE, await shifted(c.WAKE, -5));
    const p2 = await propose(B, c2.WAKE, await shifted(c2.WAKE, -5));
    const in1 = await inbox(A1), in2 = await inbox(A2);
    const sent1 = await sent(B, A1), sent2 = await sent(B, A2);
    // 꺼진 알람 · 새 시각이 곧 지나는 제안
    const off = await card(A1, { hours: 9 }), soon = await card(A1, { hours: 11 });
    const pOff = await propose(B, off.WAKE, await shifted(off.WAKE, -5));
    const pSoon = await propose(B, soon.WAKE, await shifted(soon.WAKE, -5));
    await q(`update public.alarms set is_enabled = false where alarm_id = $1`, [off.WAKE]);
    await q(`update public.alarm_proposals set to_at = now() + interval '1 minute' where proposal_id = $1`, [pSoon.proposal_id]);
    const hidden = (await inbox(A1)).map((x) => x.proposal_id);
    const rOff = await respond(A1, pOff.proposal_id, true);
    return in1.length === 1 && in1[0].proposal_id === p1.proposal_id && in2.length === 1 && in2[0].proposal_id === p2.proposal_id
      && sent1.length === 1 && sent1[0].alarm_id === c.WAKE && sent2.length === 1 && sent2[0].alarm_id === c2.WAKE
      && hidden.length === 1 && hidden[0] === p1.proposal_id && rOff.status === 'EXPIRED' ? true : { in1, in2, sent1, sent2, hidden, rOff };
  });

  await check('10장 푸시 권한(제안 본인): 다른 친구가 보낸 제안이나 다른 사람에게 보낸 제안으로는 통과하지 못함 — 설정 권한이 있어도 내가 그 사람에게 방금 보낸 제안이 있어야 함', async () => {
    const { A, B, c } = await pair(58);
    const C = await join_(60, '다른친구'); await befriend(A, C); await grant(A, C);
    const X = await join_(61, '다른주인'); await befriend(X, B); await grant(X, B);
    await propose(C, c.WAKE, await shifted(c.WAKE, -5));                                       // C의 제안만 있음
    const bBefore = await canPush(B, A);
    const cOk = await canPush(C, A);
    await propose(B, c.PREPARE, await shifted(c.PREPARE, -5));                                 // B도 A에게 보냄 — X에게는 보낸 적 없음
    const bToA = await canPush(B, A);
    const bToX = await canPush(B, X);
    return bBefore === false && cOk === true && bToA === true && bToX === false ? true : { bBefore, cOk, bToA, bToX };
  });

  await check('원래 시각 기억 가드(서버 쪽): 주인 · 서버 · 정의자가 시각을 바꾸면 기억이 비워지고, 앱이 설정 신호(app.alarm_apply)를 켠 채 시각과 기억을 같이 써 보내도 비워짐', async () => {
    const applyOnce = async (n) => {
      const { A, B, c } = await pair(n);
      const p = await propose(B, c.WAKE, await shifted(c.WAKE, -5));
      await respond(A, p.proposal_id, true);
      return { A, c };
    };
    const set1 = await applyOnce(63);                                                           // 서버 역할
    await svc(); await q(`update public.alarms set scheduled_at = scheduled_at + interval '1 minute' where alarm_id = $1`, [set1.c.WAKE]); await su();
    const viaServer = await alarm(set1.c.WAKE);
    const viaSuper = await alarm(set1.c.PREPARE);                                              // 정의자 · 슈퍼유저
    await q(`update public.alarms set scheduled_at = scheduled_at + interval '1 minute' where alarm_id = $1`, [set1.c.PREPARE]);
    const viaSuperAfter = await alarm(set1.c.PREPARE);
    const set2 = await applyOnce(65);                                                           // 앱 위조 시도
    await as(set2.A);
    await q(`select set_config('app.alarm_apply', 'on', false)`);
    await q(`update public.alarms set scheduled_at = scheduled_at + interval '2 minutes', original_scheduled_at = now(), original_time_source = 'AUTO' where alarm_id = $1`, [set2.c.WAKE]);
    await q(`select set_config('app.alarm_apply', 'off', false)`);
    await su();
    const forged = await alarm(set2.c.WAKE);
    const set3 = await applyOnce(67);                                                           // 앱이 그때의 time_source 칸만 따로 바꾸려 함
    await as(set3.A);
    await q(`update public.alarms set original_time_source = 'MANUAL' where alarm_id = $1`, [set3.c.WAKE]);
    await su();
    const sourceOnly = await alarm(set3.c.WAKE);
    return sourceOnly.original_time_source === 'AUTO' && sourceOnly.original_scheduled_at != null
      && viaServer.original_scheduled_at == null && viaServer.original_time_source == null
      && viaSuper.original_scheduled_at != null && viaSuperAfter.original_scheduled_at == null && viaSuperAfter.original_time_source == null
      && forged.original_scheduled_at == null && forged.original_time_source == null ? true : { viaServer, viaSuper, viaSuperAfter, forged, sourceOnly };
  });

  // ---- 막혀야 하는 길 ----------------------------------------------------------------------------

  await check('10-03 · 10-05 ~ 10-07 · 10-10 · 10-16(직접 update 0행): 조회만 · 설정 권한 · 회수 · 끊김 · 그룹 출처 모두 친구가 알람 시각 · 켬/끔 · time_source를 직접 update하면 0행이고 알람은 그대로 — 주인 본인은 고침, 제안 경로는 그대로 됨', async () => {
    const snap = async (id_) => JSON.stringify(await alarm(id_));
    const tryEdit = async (uid, alarmId) => {
      await as(uid);
      const rows = [
        await q(`update public.alarms set scheduled_at = scheduled_at - interval '5 minutes' where alarm_id = $1 returning 1`, [alarmId]),
        await q(`update public.alarms set is_enabled = false where alarm_id = $1 returning 1`, [alarmId]),                                  // 10-16: 끄기
        await q(`update public.alarms set time_source = 'MANUAL' where alarm_id = $1 returning 1`, [alarmId]),
        await q(`update public.alarms set scheduled_at = scheduled_at - interval '5 minutes', is_enabled = false, time_source = 'MANUAL' where alarm_id = $1 returning 1`, [alarmId]),
      ];
      await su();
      return rows.map((r) => r.length);
    };
    const mixed = await pair(70);                                                       // 설정 권한 있음 (10-01)
    const mixedBefore = await snap(mixed.c.WAKE);
    const seen = async (uid, alarmId) => { await as(uid); const r = await q(`select 1 from public.alarms where alarm_id = $1`, [alarmId]); await su(); return r.length; };
    const mixedSeen = await seen(mixed.B, mixed.c.WAKE);                               // 0행이 '안 보여서'가 아니라 정책 때문임을 확인
    const withEdit = await tryEdit(mixed.B, mixed.c.WAKE);
    const afterEdit = await snap(mixed.c.WAKE);
    const view = await pair(72, { edit: false });                                      // 조회만 (10-03)
    const viewBefore = await snap(view.c.WAKE);
    const viewOnly = await tryEdit(view.B, view.c.WAKE);
    const rev = await pair(74);                                                         // 방금 권한 회수 (10-05)
    await as(rev.A); await q(`delete from public.sharing_permissions where permission_id = $1`, [rev.perm]); await su();
    const revoked = await tryEdit(rev.B, rev.c.WAKE);
    const ended = await pair(76);                                                       // 설정 권한 받은 뒤 친구 끊김 (10-07)
    await call(ended.A, 'public.remove_friend($1)', [ended.B]);
    const unfriended = await tryEdit(ended.B, ended.c.WAKE);
    const gOwner = await join_(78, '그룹주인'), gFriend = await join_(79, '그룹친구');      // 그룹 출처 설정 권한 — 그룹에 있는 동안(10-06 앞부분)과 나간 뒤
    await befriend(gOwner, gFriend);
    await as(gOwner);
    const [{ group_id: gid }] = await q(`insert into public.groups (group_name, owner_id) values ('직접수정그룹', $1) returning group_id`, [gOwner]);
    await su();
    await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at) values ($1, $2, 'JOINED', now())`, [gid, gFriend]);
    await as(gOwner);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm) values ($1, $2, 'GROUP', $3, true, true)`, [gOwner, gFriend, gid]);
    await su();
    const gc = await card(gOwner, { groupId: gid });
    const groupBefore = await snap(gc.WAKE);
    const groupSeen = await seen(gFriend, gc.WAKE);
    const inGroup = await tryEdit(gFriend, gc.WAKE);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [gid, gFriend]);
    const leftGroup = await tryEdit(gFriend, gc.WAKE);
    const groupAfter = await snap(gc.WAKE);
    // 주인 본인은 그대로 고침, 친구가 건 제안은 그대로 됨
    await as(mixed.A);
    const own = await q(`update public.alarms set scheduled_at = scheduled_at - interval '10 minutes' where alarm_id = $1 returning 1`, [mixed.c.WAKE]);
    await su();
    const viaProposal = await propose(mixed.B, mixed.c.PREPARE, await shifted(mixed.c.PREPARE, -5));
    const applied = await respond(mixed.A, viaProposal.proposal_id, true);
    const zeros = [0, 0, 0, 0];
    const same = (a) => JSON.stringify(a) === JSON.stringify(zeros);
    return mixedSeen === 1 && groupSeen === 1 && same(withEdit) && afterEdit === mixedBefore && same(viewOnly) && (await snap(view.c.WAKE)) === viewBefore && same(revoked) && same(unfriended) && same(inGroup) && same(leftGroup) && groupAfter === groupBefore
      && own.length === 1 && viaProposal.status === 'OK' && applied.status === 'APPLIED' ? true : { withEdit, viewOnly, revoked, unfriended, inGroup, leftGroup, own, viaProposal, applied };
  });

  await check('10-10 · 10-11 · 10-12: 친구는 알람 주인을 못 바꾸고 · 지우지 못하고 · 새로 못 넣음 — 원래 시각 기억 칸은 앱이 못 씀(고치려 해도 그대로 · 시각이 바뀌면 비워짐 · 새로 넣을 때도 비움)', async () => {
    const { A, B, c } = await pair(30);
    await as(B);
    const steal = await q(`update public.alarms set user_id = $1 where alarm_id = $2 returning 1`, [B, c.WAKE]);                // 직접 update 길이 닫혀 0행
    const del = await q(`delete from public.alarms where alarm_id = $1 returning 1`, [c.WAKE]);
    const ins = await expectErr(() => q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'ARRIVE', now() + interval '12 hours')`, [c.pt, A]), /row-level security/);
    await su();
    await as(A);
    await q(`update public.alarms set original_scheduled_at = now() - interval '1 day' where alarm_id = $1`, [c.PREPARE]);        // 앱이 기억 칸만 바꾸려 함
    const forged = (await alarm(c.PREPARE)).original_scheduled_at;
    const [own] = await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at, original_scheduled_at) values ($1, $2, 'ARRIVE', now() + interval '12 hours', now() - interval '1 day') returning alarm_id, original_scheduled_at`, [c.pt, A]);
    await su();
    const stillA = (await q(`select user_id from public.alarms where alarm_id = $1`, [c.WAKE]))[0].user_id;
    await as(A);
    const ownerSteal = await expectErr(() => q(`update public.alarms set user_id = $1 where alarm_id = $2`, [B, c.WAKE]), /바꿀 수 없음/);   // 주인 본인도 못 바꿈(keep_keys)
    await su();
    return steal.length === 0 && ownerSteal === true && stillA === A && del.length === 0 && ins === true && forged == null && own.original_scheduled_at == null ? true : { steal, stillA, del, ins, forged, own };
  });

  await check('10장 푸시 권한: can_send_push의 ALARM_CHANGED = 설정 권한 + 방금(1시간 안) 보낸 대기 중 제안 — 제안 없이 · 오래된 제안 · 무시된(응답한) 제안 · 다른 사람에게는 false', async () => {
    const { A, B, c } = await pair(32);
    const X = await join_(34, '제3자');
    const none = await canPush(B, A);
    const p = await propose(B, c.WAKE, await shifted(c.WAKE, -5));
    const withProposal = await canPush(B, A);
    const wrongTarget = await canPush(B, X);
    const reverse = await canPush(A, B);
    await q(`update public.alarm_proposals set created_at = now() - interval '2 hours' where proposal_id = $1`, [p.proposal_id]);
    const stale = await canPush(B, A);
    const p2 = await propose(B, c.WAKE, await shifted(c.WAKE, -10));
    const fresh = await canPush(B, A);
    await respond(A, p2.proposal_id, false);
    const afterResponse = await canPush(B, A);
    return none === false && withProposal === true && wrongTarget === false && reverse === false && stale === false && fresh === true && afterResponse === false ? true : { none, withProposal, wrongTarget, reverse, stale, fresh, afterResponse };
  });

  await check('10장 실행 권한: 제안 함수 넷은 로그인한 사람만(anon 거부), 제안 표는 앱이 읽기만(쓰기 거부)', async () => {
    const { A, B, c } = await pair(36);
    const p = await propose(B, c.WAKE, await shifted(c.WAKE, -5));
    await as(null, 'anon');
    const anon = [
      await expectErr(() => q(`select public.propose_alarm_time($1, now())`, [c.WAKE]), /permission denied/),
      await expectErr(() => q(`select public.respond_alarm_proposal($1, true)`, [p.proposal_id]), /permission denied/),
      await expectErr(() => q(`select * from public.my_alarm_proposals()`), /permission denied/),
      await expectErr(() => q(`select * from public.sent_alarm_proposals($1)`, [A]), /permission denied/),
      await expectErr(() => q(`select * from public.alarm_proposals`), /permission denied/),
    ];
    await su();
    await as(B);
    const writes = [
      await expectErr(() => q(`insert into public.alarm_proposals (alarm_id, owner_id, proposer_id, from_at, to_at) values ($1, $2, $3, now(), now())`, [c.WAKE, A, B]), /permission denied/),
      await expectErr(() => q(`update public.alarm_proposals set status = 'APPLIED' where proposal_id = $1`, [p.proposal_id]), /permission denied/),
      await expectErr(() => q(`delete from public.alarm_proposals where proposal_id = $1`, [p.proposal_id]), /permission denied/),
    ];
    await su();
    return anon.every((x) => x === true) && writes.every((x) => x === true) ? true : { anon, writes };
  });

  // ---- 탐색 시험 X-PROP-01: 늦추는 제안이 약속에 늦게 만들면 거절 -----------------------------------------

  await check('X-PROP-01(보내기): 늦추는 제안은 같이 움직인 출발 + 이동시간이 약속 시각을 넘으면 TOO_LATE(제안 행 없음) — 안 넘으면 OK, 이동시간 값이 없으면 출발이 약속 시각을 넘을 때만, 앞당기기는 이미 늦어도 막지 않음', async () => {
    const { A, B, c } = await pair(80);                                      // 기상 → 출발 +40분, 약속 = 기상 + 120분
    await q(`update public.appointment_participants set est_travel_minutes = 30 where participant_id = $1`, [c.pt]);
    const late = await propose(B, c.WAKE, await shifted(c.WAKE, 55));         // 출발 +95 + 이동 30 = 125 > 120
    const edge = await propose(B, c.WAKE, await shifted(c.WAKE, 50));         // 40 + 50 + 30 = 120 — 딱 맞으면 통과
    const ok = await propose(B, c.WAKE, await shifted(c.WAKE, 45));           // 115
    const rows1 = await q(`select to_at from public.alarm_proposals where alarm_id = $1 and status = 'PENDING'`, [c.WAKE]);
    const none = await pair(82);                                              // 이동시간 값 없음 + 약속이 출발 바로 뒤(+45분)
    await q(`update public.appointments set appointment_at = (select scheduled_at from public.alarms where alarm_id = $1) + interval '45 minutes' where appointment_id = $2`, [none.c.WAKE, none.c.ap]);
    const noneLate = await propose(none.B, none.c.WAKE, await shifted(none.c.WAKE, 10)), noneOk = await propose(none.B, none.c.WAKE, await shifted(none.c.WAKE, 4));
    const hurry = await pair(84);                                             // 이동시간이 길어 이미 늦은 카드 — 앞당기기는 OK
    await q(`update public.appointment_participants set est_travel_minutes = 200 where participant_id = $1`, [hurry.c.pt]);
    const earlier = await propose(hurry.B, hurry.c.WAKE, await shifted(hurry.c.WAKE, -5)), later = await propose(hurry.B, hurry.c.WAKE, await shifted(hurry.c.WAKE, 5));
    return late.status === 'TOO_LATE' && edge.status === 'OK' && ok.status === 'OK' && rows1.length === 1 && ms(rows1[0].to_at) === ms(await shifted(c.WAKE, 45))
      && noneLate.status === 'TOO_LATE' && noneOk.status === 'OK' && earlier.status === 'OK' && later.status === 'TOO_LATE' ? true : { late, edge, ok, rows1, noneLate, noneOk, earlier, later };
  });

  await check('X-PROP-01(적용): 받은 뒤 약속 · 이동시간이 바뀌어 적용하면 약속에 늦게 되면 [적용]도 TOO_LATE — 알람은 그대로, 그 제안은 닫힘(EXPIRED). 늦지 않으면 그대로 APPLIED', async () => {
    const { A, B, c } = await pair(86);
    await q(`update public.appointment_participants set est_travel_minutes = 30 where participant_id = $1`, [c.pt]);
    const p1 = await propose(B, c.WAKE, await shifted(c.WAKE, 45));          // 보낼 때는 115 ≤ 120
    await q(`update public.appointment_participants set est_travel_minutes = 50 where participant_id = $1`, [c.pt]);   // 그사이 이동시간이 늘어 135 > 120
    const before = [await alarm(c.WAKE), await alarm(c.DEPARTURE)];
    const r1 = await respond(A, p1.proposal_id, true);
    const after = [await alarm(c.WAKE), await alarm(c.DEPARTURE)];
    const st1 = (await q(`select status from public.alarm_proposals where proposal_id = $1`, [p1.proposal_id]))[0].status;
    await q(`update public.appointment_participants set est_travel_minutes = 30 where participant_id = $1`, [c.pt]);
    const p2 = await propose(B, c.WAKE, await shifted(c.WAKE, 45));
    const r2 = await respond(A, p2.proposal_id, true);
    return p1.status === 'OK' && r1.status === 'TOO_LATE' && before.every((x, i) => ms(x.scheduled_at) === ms(after[i].scheduled_at)) && st1 === 'EXPIRED' && p2.status === 'OK' && r2.status === 'APPLIED' ? true : { p1, r1, st1, before, after, p2, r2 };
  });

  await check('X-PROP-01(꺼 둔 출발): 출발 알람을 꺼 둔 카드는 출발이 울리지 않으니 늦추는 제안이 약속을 넘겨도 TOO_LATE가 아님', async () => {
    const { B, c } = await pair(88);
    await q(`update public.appointment_participants set est_travel_minutes = 30 where participant_id = $1`, [c.pt]);
    const late = await propose(B, c.WAKE, await shifted(c.WAKE, 55));            // 켜져 있으면 TOO_LATE인 값
    await q(`update public.alarms set is_enabled = false where alarm_id = $1`, [c.DEPARTURE]);
    const off = await propose(B, c.WAKE, await shifted(c.WAKE, 55));
    return late.status === 'TOO_LATE' && off.status === 'OK' ? true : { late, off };
  });
}
