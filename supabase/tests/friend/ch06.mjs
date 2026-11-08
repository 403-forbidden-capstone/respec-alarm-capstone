// 친구 6장 — 공유 권한 (친구_시험케이스.md 6장 DB · 함수 층, 11/8 확정)
//   항목 이름 앞 번호 = 시험케이스 번호
//   이 장에 없는 것: 6-12 · 6-20 · 6-27 · 6-30 · 6-40 ~ 6-42(앱 화면), 6-21(대본), 6-28 · 6-29(기상 숨기기 = 7장), 6-43의 '권한이 없어졌어요' 거절(변경 요청 함수 = 10장),
//                   6-22 · 6-44의 알림 쪽(11장) — 여기선 보내도 되는지 판정(can_send_push)까지
//   6-23 ~ 6-26 기상 보기는 권한 행이 아니라 그룹 기상 공유 동의 하나로 정해짐(get_group_wake_status), 6-45 그룹마다 따로
//   사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch06({ q, as, su, svc, check, expectErr, PGlite, AUTH_STUBS, MIG_DIR, readFileSync, readdirSync, join }) {
  const id = (n) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const NOBODY = '70000000-0000-4000-8000-999999999999';

  const join_ = async (n, nickname) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `f6-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f6_user_${n}`]);
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
  // 그룹 — 만든 사람은 트리거가 JOINED로 넣고, 나머지는 바로 JOINED
  const mkGroup = async (owner, others = [], { optIn = false } = {}) => {
    await as(owner);
    const [g] = await q(`insert into public.groups (group_name, owner_id) values ('권한그룹', $1) returning group_id, invite_code`, [owner]);
    await su();
    for (const u of others) {
      await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at, wake_share_opt_in) values ($1, $2, 'JOINED', now(), $3)`, [g.group_id, u, optIn]);
    }
    return { g: g.group_id, code: g.invite_code };
  };
  const setOptIn = async (u, g, v) => { await as(u); await q(`update public.group_members set wake_share_opt_in = $3 where group_id = $1 and user_id = $2`, [g, u, v]); await su(); };
  // 알람 — 일정에 붙은 것 · 루틴 · 단독
  const apptAlarm = async (u, groupId = null) => {
    const [ap] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name)
                          values ($1, $2, '약속', now() + interval '10 hours', '학교') returning appointment_id`, [u, groupId]);
    const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap.appointment_id, u]);
    const [al] = await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', now() + interval '8 hours') returning alarm_id`, [pt.participant_id, u]);
    return al.alarm_id;
  };
  const soloAlarm = async (u) => (await q(`insert into public.alarms (user_id, alarm_type, scheduled_at) values ($1, 'WAKE', now() + interval '9 hours') returning alarm_id`, [u]))[0].alarm_id;
  const routineAlarm = async (u) => {
    const [{ routine_id: rt }] = await q(`insert into public.routines (user_id, title) values ($1, '루틴') returning routine_id`, [u]);
    return (await q(`insert into public.alarms (routine_id, step_order, user_id, alarm_type, scheduled_at) values ($1, 1, $2, 'ROUTINE', now() + interval '7 hours') returning alarm_id`, [rt, u]))[0].alarm_id;
  };
  const seen = async (viewer, owner) => { await as(viewer); const r = await q(`select alarm_id from public.alarms where user_id = $1 order by alarm_id`, [owner]); await su(); return r.map((x) => x.alarm_id); };
  const canEdit = async (viewer, alarmId) => {
    await as(viewer);
    const r = await q(`update public.alarms set scheduled_at = scheduled_at + interval '1 minute' where alarm_id = $1 returning 1`, [alarmId]);
    await su();
    return r.length === 1;
  };
  const canPush = async (s, t, k = 'ALARM_CHANGED') => { await svc(); const r = (await q(`select public.can_send_push($1, $2, $3) as ok`, [s, t, k]))[0].ok; await su(); return r; };
  // 권한 행
  const friendGrant = async (owner, grantee, f, view, edit = false, wake = false) => {
    await as(owner);
    const [r] = await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm, can_view_wake)
                         values ($1, $2, 'FRIEND', $3, $4, $5, $6) returning permission_id`, [owner, grantee, f, view, edit, wake]);
    await su();
    return r.permission_id;
  };
  const groupGrant = async (owner, grantee, g, view, edit = false) => {
    await as(owner);
    const [r] = await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm)
                         values ($1, $2, 'GROUP', $3, $4, $5) returning permission_id`, [owner, grantee, g, view, edit]);
    await su();
    return r.permission_id;
  };
  const patch = async (owner, pid, sqlSet) => { await as(owner); const r = await q(`update public.sharing_permissions set ${sqlSet} where permission_id = $1 returning can_view_alarm as v, can_edit_alarm as e`, [pid]); await su(); return r[0] ?? null; };
  const rowOf = async (pid) => (await q(`select can_view_alarm as v, can_edit_alarm as e, can_view_wake as w from public.sharing_permissions where permission_id = $1`, [pid]))[0] ?? null;
  const groupRows = (owner, g) => q(`select grantee_id, can_view_alarm as v, can_edit_alarm as e, updated_at from public.sharing_permissions
                                     where owner_id = $1 and source_type = 'GROUP' and source_id = $2 order by grantee_id`, [owner, g]);
  const save = (u, g, view, edit) => call(u, 'public.save_group_permissions($1, $2, $3)', [g, view, edit]);
  const joinGroup = (u, code, share = false) => call(u, 'public.join_group($1, $2)', [code, share]);
  const wakeIds = async (viewer, g) => { await as(viewer); const r = await q(`select user_id from public.get_group_wake_status($1)`, [g]); await su(); return r.map((x) => x.user_id).sort(); };
  // 오늘 이 그룹의 약속(그룹 기상 상태는 약속이 있는 날에만 나옴)
  const todayAppt = (owner, g) => q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '오늘 약속', now(), '학교')`, [owner, g]);
  const sorted = (...x) => x.slice().sort();

  // ---- 처음 상태 · 주고 거두기 -------------------------------------------------------

  await check('6-01: 친구 수락 직후 · 그룹 참여 직후엔 서로의 알람이 안 읽힘 — 권한은 모두 꺼짐으로 시작(권한 행도 안 생김)', async () => {
    const A = await join_(1, '에이'), B = await join_(2, '비');
    await befriend(A, B);
    const { g } = await mkGroup(A, [B]);
    const al = await apptAlarm(A);
    const rows = (await q(`select count(*)::int as n from public.sharing_permissions where owner_id = any($1::uuid[])`, [[A, B]]))[0].n;
    return (await seen(B, A)).length === 0 && (await seen(A, B)).length === 0 && rows === 0 && al ? true : { rows };
  });

  await check('6-02 · 6-03: 친구에게 알람 조회를 켜면 그 사람만 읽히고(관계 없는 사람은 안 읽힘), 끄면 바로 0행', async () => {
    const A = await join_(3, '주인'), B = await join_(4, '친구'), C = await join_(5, '남');
    await befriend(A, B);
    const f = await friendId(A, B);
    const al = await apptAlarm(A);
    const p = await friendGrant(A, B, f, true);
    const on = { b: await seen(B, A), c: await seen(C, A) };
    await patch(A, p, `can_view_alarm = false`);
    const off = await seen(B, A);
    return on.b.length === 1 && on.b[0] === al && on.c.length === 0 && off.length === 0 ? true : { on, off };
  });

  await check('6-04: 설정만 켜고 조회는 끈 행은 못 들어감 — 새로 넣는 것도 · 기존 행을 그렇게 바꾸는 것도 거절(DB 제약 "설정이면 조회")', async () => {
    const A = await join_(6, '주인'), B = await join_(7, '친구');
    await befriend(A, B);
    const f = await friendId(A, B);
    await as(A);
    const ins = await expectErr(() => q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm)
                                         values ($1, $2, 'FRIEND', $3, false, true)`, [A, B, f]), /sharing_permissions_edit_needs_view|check constraint/);
    await su();
    const p = await friendGrant(A, B, f, false);
    await as(A);
    const upd = await expectErr(() => q(`update public.sharing_permissions set can_edit_alarm = true where permission_id = $1`, [p]), /sharing_permissions_edit_needs_view|check constraint/);
    await su();
    const row = await rowOf(p);
    return ins === true && upd === true && row.v === false && row.e === false ? true : { ins, upd, row };
  });

  await check('6-05 · 6-06: 조회 · 설정 둘 다 켠 행에서 조회만 끄면 설정도 같이 꺼지고 받은 사람의 알람 수정은 0행 — 알림 판정도 거절', async () => {
    const A = await join_(8, '주인'), B = await join_(9, '친구');
    await befriend(A, B);
    const f = await friendId(A, B);
    const al = await apptAlarm(A);
    const p = await friendGrant(A, B, f, true, true);
    const before = { edit: await canEdit(B, al), push: await canPush(B, A) };
    const row = await patch(A, p, `can_view_alarm = false`);
    const after = { edit: await canEdit(B, al), push: await canPush(B, A), saw: await seen(B, A) };
    return before.edit === true && before.push === true && row.v === false && row.e === false
      && after.edit === false && after.push === false && after.saw.length === 0 ? true : { before, row, after };
  });

  await check('6-07: 친구로 조회만 + 그룹으로 조회 · 설정을 받으면 최종 권한은 합친 것 — 읽히고 고쳐짐, 친구 쪽을 거두면 그룹 쪽만 남음', async () => {
    const A = await join_(10, '주인'), B = await join_(11, '받는이');
    await befriend(A, B);
    const f = await friendId(A, B);
    const { g } = await mkGroup(A, [B]);
    const al = await apptAlarm(A);
    const pf = await friendGrant(A, B, f, true, false);
    const pg = await groupGrant(A, B, g, true, true);
    const both = { saw: await seen(B, A), edit: await canEdit(B, al) };
    await as(A);
    await q(`delete from public.sharing_permissions where permission_id = $1`, [pf]);
    await su();
    const groupOnly = { saw: await seen(B, A), edit: await canEdit(B, al) };
    await patch(A, pg, `can_edit_alarm = false`);
    const viewOnly = { saw: await seen(B, A), edit: await canEdit(B, al) };
    return both.saw.length === 1 && both.edit === true && groupOnly.saw.length === 1 && groupOnly.edit === true
      && viewOnly.saw.length === 1 && viewOnly.edit === false ? true : { both, groupOnly, viewOnly };
  });

  await check('6-08 · 6-09: 친구 조회 + 그룹 조회에서 그룹 쪽만 꺼도 여전히 보이고(합집합), 친구 쪽도 끄면 안 보임', async () => {
    const A = await join_(12, '주인'), B = await join_(13, '받는이');
    await befriend(A, B);
    const f = await friendId(A, B);
    const { g } = await mkGroup(A, [B]);
    await apptAlarm(A);
    const pf = await friendGrant(A, B, f, true);
    const pg = await groupGrant(A, B, g, true);
    await patch(A, pg, `can_view_alarm = false`);
    const friendOnly = (await seen(B, A)).length;
    await patch(A, pf, `can_view_alarm = false`);
    const none = (await seen(B, A)).length;
    return friendOnly === 1 && none === 0 ? true : { friendOnly, none };
  });

  await check('6-10: 친구 + 그룹 권한이 둘 다 있을 때 친구를 끊으면 친구 출처 행만 사라지고 그룹 출처 행은 남아 계속 보임', async () => {
    const A = await join_(14, '주인'), B = await join_(15, '받는이');
    await befriend(A, B);
    const f = await friendId(A, B);
    const { g } = await mkGroup(A, [B]);
    await apptAlarm(A);
    await friendGrant(A, B, f, true);
    await groupGrant(A, B, g, true);
    await call(A, 'public.remove_friend($1)', [B]);
    const rows = await q(`select source_type::text as t from public.sharing_permissions where owner_id = $1 and grantee_id = $2`, [A, B]);
    return rows.length === 1 && rows[0].t === 'GROUP' && (await seen(B, A)).length === 1 ? true : { rows };
  });

  await check('6-11: 친구 + 그룹 출처 권한이 있을 때 A가 그룹을 나가면 그룹 출처 행은 양방향 모두 삭제, 친구 출처 행은 유지', async () => {
    const A = await join_(16, '나가는이'), B = await join_(17, '남는이');
    await befriend(A, B);
    const f = await friendId(A, B);
    const { g } = await mkGroup(A, [B]);
    await friendGrant(A, B, f, true);
    await groupGrant(A, B, g, true);
    await groupGrant(B, A, g, true);
    await as(A);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, A]);
    await su();
    const rows = await q(`select source_type::text as t, owner_id from public.sharing_permissions where owner_id = any($1::uuid[]) order by t`, [[A, B]]);
    return rows.length === 1 && rows[0].t === 'FRIEND' && rows[0].owner_id === A ? true : { rows };
  });

  // ---- 그룹 권한 저장 --------------------------------------------------------------

  await check('6-13 · 6-19: 그룹 권한 저장 — 참여 중 멤버 전원(나 빼고)에게 같은 값 한 벌(행 2개), 두 번 저장해도 행은 그대로 · 수정 시각은 새로', async () => {
    const A = await join_(20, '주인'), B = await join_(21, '비'), C = await join_(22, '씨');
    const { g } = await mkGroup(A, [B, C]);
    const r1 = await save(A, g, true, false);
    const rows1 = await groupRows(A, g);
    await new Promise((r) => setTimeout(r, 20));
    const r2 = await save(A, g, true, false);
    const rows2 = await groupRows(A, g);
    const total = (await q(`select count(*)::int as n from public.sharing_permissions where owner_id = $1`, [A]))[0].n;
    return r1.status === 'OK' && r1.saved === 2 && rows1.length === 2 && rows1.every((x) => x.v === true && x.e === false)
      && rows1.map((x) => x.grantee_id).join() === sorted(B, C).join()
      && r2.status === 'OK' && rows2.length === 2 && total === 2
      && rows2.every((x, i) => new Date(x.updated_at).getTime() > new Date(rows1[i].updated_at).getTime()) ? true : { r1, r2, rows1, rows2, total };
  });

  await check('6-13(값): 설정을 켜면 조회도 켜짐(설정만 보내도), 둘 다 끄면 둘 다 꺼짐, null은 꺼짐으로 침 — 받은 사람에게는 본인 행만 읽힘', async () => {
    const A = await join_(23, '주인'), B = await join_(24, '비'), C = await join_(25, '씨');
    const { g } = await mkGroup(A, [B, C]);
    await save(A, g, false, true);
    const editOnly = (await groupRows(A, g)).map((x) => [x.v, x.e].join());
    await save(A, g, false, false);
    const off = (await groupRows(A, g)).map((x) => [x.v, x.e].join());
    await save(A, g, null, null);
    const nulls = (await groupRows(A, g)).map((x) => [x.v, x.e].join());
    await save(A, g, true, true);
    await as(B);
    const mine = await q(`select owner_id, grantee_id from public.sharing_permissions where source_id = $1`, [g]);
    await su();
    return editOnly.join('|') === 'true,true|true,true' && off.join('|') === 'false,false|false,false' && nulls.join('|') === 'false,false|false,false'
      && mine.length === 1 && mine[0].grantee_id === B ? true : { editOnly, off, nulls, mine };
  });

  await check('6-14 · 6-15: 권한을 준 뒤 들어온 멤버는 조회 행만 자동 — 읽히지만 고쳐지지 않고, 준 사람이 다시 저장하면(값이 그대로여도) 설정 행도 생김', async () => {
    const A = await join_(26, '주인'), B = await join_(27, '비'), D = await join_(28, '나중에');
    const { g, code } = await mkGroup(A, [B]);
    const al = await apptAlarm(A);
    await save(A, g, true, true);
    const j = await joinGroup(D, code);
    const row = (await groupRows(A, g)).find((x) => x.grantee_id === D);
    const viewOnly = { saw: await seen(D, A), edit: await canEdit(D, al) };
    const again = await save(A, g, true, true);
    const row2 = (await groupRows(A, g)).find((x) => x.grantee_id === D);
    const afterSave = { edit: await canEdit(D, al) };
    return j.status === 'JOINED' && row && row.v === true && row.e === false
      && viewOnly.saw.length === 1 && viewOnly.edit === false
      && again.status === 'OK' && again.saved === 2 && row2.e === true && afterSave.edit === true ? true : { j, row, viewOnly, again, row2, afterSave };
  });

  await check('6-14(길): 초대를 수락해 들어와도, 그룹에서 나갔다 코드로 다시 들어와도 같음 — 조회를 준 사람 것만 자동(꺼 둔 사람 · 아직 안 준 사람 것은 안 생김)', async () => {
    const A = await join_(29, '준사람'), B = await join_(30, '끈사람'), C = await join_(31, '초대받음'), X = await join_(32, '안준사람');
    const { g, code } = await mkGroup(A, [B, X]);
    await befriend(A, C);
    await save(A, g, true, false);
    await save(B, g, false, false);
    await call(A, 'public.invite_to_group($1, $2)', [g, C]);
    const invited = (await groupRows(A, g)).filter((x) => x.grantee_id === C).length;
    const acc = await call(C, 'public.accept_group_invite($1, $2)', [g, false]);
    const fromA = (await groupRows(A, g)).filter((x) => x.grantee_id === C);
    const fromB = (await groupRows(B, g)).filter((x) => x.grantee_id === C);
    const fromX = (await groupRows(X, g)).filter((x) => x.grantee_id === C);
    await as(C);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, C]);
    await su();
    const gone = (await groupRows(A, g)).filter((x) => x.grantee_id === C).length;
    const back = await joinGroup(C, code);
    const rejoin = (await groupRows(A, g)).filter((x) => x.grantee_id === C);
    return invited === 0 && acc.status === 'JOINED' && fromA.length === 1 && fromA[0].v === true && fromA[0].e === false
      && fromB.length === 0 && fromX.length === 0
      && gone === 0 && back.status === 'JOINED' && rejoin.length === 1 && rejoin[0].v === true ? true : { invited, acc, fromA, fromB, fromX, gone, back, rejoin };
  });

  await check('6-14(차단): 차단한 사이인 사람이 들어와도 조회 행은 안 생김(오류도 없이) — 저장 때도 차단 쌍은 행만 건너뛰고 응답은 같은 모양(saved = 참여 중 다른 멤버 수)', async () => {
    const A = await join_(33, '주인'), B = await join_(34, '차단당함'), C = await join_(35, '그냥멤버'), D = await join_(36, '나중에');
    const { g, code } = await mkGroup(A, [B, C]);
    await call(A, 'public.block_user($1)', [B]);
    const r = await save(A, g, true, true);
    const rows = await groupRows(A, g);
    await call(A, 'public.block_user($1)', [D]);
    const j = await joinGroup(D, code);
    const afterJoin = (await groupRows(A, g)).map((x) => x.grantee_id);
    // 같은 모양: 차단당한 쪽 B가 저장해도 A 쪽 행만 안 생기고 응답은 그대로
    const rb = await save(B, g, true, false);
    const bRows = (await groupRows(B, g)).map((x) => x.grantee_id);
    return r.status === 'OK' && r.saved === 2 && rows.length === 1 && rows[0].grantee_id === C
      && j.status === 'JOINED' && afterJoin.join() === [C].join()
      && rb.status === 'OK' && rb.saved === 3 && bRows.join() === sorted(C, D).join() ? true : { r, rows, j, afterJoin, rb, bRows };
  });

  await check('6-16: 멤버마다 값이 다른 옛 행(B 조회 켜짐 · C 꺼짐)은 마이그레이션 뒤 모두 꺼짐으로 맞춰짐 — 일부 멤버 행이 빠진 주인도 꺼짐, 값이 같은 주인은 그대로, 설정만 켠 옛 친구 행은 설정이 꺼지고 친구 출처 기상 조회는 꺼짐', async () => {
    const staged = new PGlite();
    try {
      await staged.exec(AUTH_STUBS);
      const files = readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort();
      const i = files.findIndex((x) => x.endsWith('_friend_permissions.sql'));
      if (i < 0) return '_friend_permissions.sql 마이그레이션이 없음';
      for (const f of files.slice(0, i)) await staged.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
      const sq = async (sql, params = []) => (await staged.query(sql, params)).rows;
      const u = (n) => id(300 + n);
      for (let n = 1; n <= 5; n++) await sq(`insert into auth.users (id, email) values ($1, $2)`, [u(n), `f6-old-${n}@example.com`]);
      const [{ group_id: g }] = await sq(`insert into public.groups (group_name, owner_id) values ('옛그룹', $1) returning group_id`, [u(1)]);
      for (const n of [2, 3]) await sq(`insert into public.group_members (group_id, user_id, invite_status, joined_at) values ($1, $2, 'JOINED', now())`, [g, u(n)]);
      const ins = (owner, grantee, v, e = false) => sq(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm)
                                                        values ($1, $2, 'GROUP', $3, $4, $5)`, [u(owner), u(grantee), g, v, e]);
      await ins(1, 2, true, true); await ins(1, 3, false);          // 값이 다름 → 둘 다 꺼짐
      await ins(2, 1, true, true); await ins(2, 3, true, true);     // 같음 → 그대로
      await ins(3, 1, true);                                        // 멤버 한 명 행이 없음 → 꺼짐
      const [{ friend_id: f }] = await sq(`insert into public.friends (requester_id, addressee_id, status, accepted_at) values ($1, $2, 'ACCEPTED', now()) returning friend_id`, [u(4), u(5)]);
      await sq(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm, can_view_wake)
                values ($1, $2, 'FRIEND', $3, false, true, true), ($2, $1, 'FRIEND', $3, true, true, true)`, [u(4), u(5), f]);
      for (const x of files.slice(i)) await staged.exec(readFileSync(join(MIG_DIR, x), 'utf8'));
      const g1 = await sq(`select grantee_id, can_view_alarm as v, can_edit_alarm as e from public.sharing_permissions where owner_id = $1 order by grantee_id`, [u(1)]);
      const g2 = await sq(`select can_view_alarm as v, can_edit_alarm as e from public.sharing_permissions where owner_id = $1`, [u(2)]);
      const g3 = await sq(`select can_view_alarm as v, can_edit_alarm as e from public.sharing_permissions where owner_id = $1`, [u(3)]);
      const fr = await sq(`select owner_id, can_view_alarm as v, can_edit_alarm as e, can_view_wake as w from public.sharing_permissions where source_type = 'FRIEND' order by owner_id`);
      const fr4 = fr.find((x) => x.owner_id === u(4)), fr5 = fr.find((x) => x.owner_id === u(5));
      return g1.length === 2 && g1.every((x) => x.v === false && x.e === false)
        && g2.length === 2 && g2.every((x) => x.v === true && x.e === true)
        && g3.length === 1 && g3[0].v === false && g3[0].e === false
        && fr4.v === false && fr4.e === false && fr4.w === false && fr5.v === true && fr5.e === true && fr5.w === false ? true : { g1, g2, g3, fr };
    } finally {
      await staged.close();
    }
  });

  await check('6-17: 한 행이 실패하면 전부 안 됨 — 그룹 권한 저장 도중 한 사람 행에서 오류가 나면 앞서 쓴 사람의 값도 그대로(함수 하나가 한 트랜잭션)', async () => {
    const A = await join_(37, '주인'), B = await join_(38, '비'), C = await join_(39, '씨'), D = await join_(40, '디');
    const { g } = await mkGroup(A, [B, C, D]);
    await save(A, g, true, true);
    await q(`create function public.f6_fail() returns trigger language plpgsql as $$ begin
               if new.grantee_id = '${D}' then raise exception 'f6 forced failure'; end if; return new; end $$`);
    await q(`create trigger f6_fail before update on public.sharing_permissions for each row execute function public.f6_fail()`);
    let err;
    try {
      err = await expectErr(() => save(A, g, false, false), /f6 forced failure/);
    } finally {
      await su();
      await q(`drop trigger f6_fail on public.sharing_permissions`);
      await q(`drop function public.f6_fail()`);
    }
    const rows = await groupRows(A, g);
    return err === true && rows.length === 3 && rows.every((x) => x.v === true && x.e === true) ? true : { err, rows };
  });

  await check('6-17(바탕): 저장이 그룹 잠금을 건 채로 일함 — 참여 · 수락(5장)과 같은 잠금이라 겹쳐도 새로 들어온 멤버 행이 빠지지 않음', async () => {
    const A = await join_(45, '주인'), B = await join_(46, '비');
    const { g } = await mkGroup(A, [B]);
    await q(`create function pg_temp.f6_locks(uid uuid, g uuid) returns integer language plpgsql as $$
             declare n integer;
             begin
               perform set_config('request.jwt.claim.sub', uid::text, true);
               perform public.save_group_permissions(g, true, false);
               select count(*)::integer into n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid();
               return n;
             end $$`);
    const [{ n }] = await q(`select pg_temp.f6_locks($1, $2) as n`, [A, g]);
    return n >= 1 ? true : { n };
  });

  await check('6-18: 혼자인 그룹 · 다른 멤버가 모두 초대 중이거나 나간 그룹은 NO_MEMBERS(행도 안 생김), 참여 중이 아니거나 없는 그룹은 NOT_FOUND — 로그인이 없으면 42501, anon은 실행 권한 없음', async () => {
    const A = await join_(41, '혼자'), B = await join_(42, '초대만'), C = await join_(43, '나감'), O = await join_(44, '밖');
    const solo = await mkGroup(A, []);
    const r1 = await save(A, solo.g, true, false);
    await befriend(A, B);
    await call(A, 'public.invite_to_group($1, $2)', [solo.g, B]);
    await q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'LEFT')`, [solo.g, C]);
    const r2 = await save(A, solo.g, true, false);
    const asInvited = await save(B, solo.g, true, false);
    const invitedRow = (await q(`select invite_status::text as st from public.group_members where group_id = $1 and user_id = $2`, [solo.g, B]))[0]?.st;
    const outsider = await save(O, solo.g, true, false);
    const ghost = await save(A, NOBODY, true, false);
    const nul = await save(A, null, true, false);
    const rows = (await q(`select count(*)::int as n from public.sharing_permissions where owner_id = any($1::uuid[])`, [[A, B, C, O]]))[0].n;
    await as(null);
    const noLogin = await expectErr(() => q(`select public.save_group_permissions($1, true, false)`, [solo.g]), /로그인이 필요함/);
    await as(null, 'anon');
    const anon = await expectErr(() => q(`select public.save_group_permissions($1, true, false)`, [solo.g]), /permission denied/);
    await su();
    return invitedRow === 'INVITED' && r1.status === 'NO_MEMBERS' && r2.status === 'NO_MEMBERS' && asInvited.status === 'NOT_FOUND' && outsider.status === 'NOT_FOUND'
      && ghost.status === 'NOT_FOUND' && nul.status === 'NOT_FOUND' && rows === 0 && noLogin === true && anon === true
      && Object.keys(r1).join() === 'status' ? true : { invitedRow, r1, r2, asInvited, outsider, ghost, nul, rows, noLogin, anon };
  });

  // ---- 기상 보기 = 그룹 기상 공유 동의 하나 -----------------------------------------------

  await check('6-23 ~ 6-26: 기상 상태는 권한 행 없이 그 그룹에서 기상 공유에 동의한 참여 중 멤버만 — 동의하면 보이고 끄면 바로 사라지고 다시 켜면 보임, 동의 안 한 사람은 안 보임(자기 줄은 늘 보임)', async () => {
    const A = await join_(50, '보는이'), B = await join_(51, '동의'), C = await join_(52, '동의안함');
    const { g } = await mkGroup(A, [B, C]);
    await todayAppt(A, g);
    const none = await wakeIds(A, g);
    await setOptIn(B, g, true);
    const rowsAfter = (await q(`select count(*)::int as n from public.sharing_permissions where owner_id = any($1::uuid[])`, [[A, B, C]]))[0].n;
    const on = await wakeIds(A, g);
    await setOptIn(B, g, false);
    const off = await wakeIds(A, g);
    await setOptIn(B, g, true);
    const again = await wakeIds(A, g);
    const mine = await wakeIds(C, g);
    return none.join() === [A].join() && rowsAfter === 0 && on.join() === sorted(A, B).join() && off.join() === [A].join()
      && again.join() === sorted(A, B).join() && mine.join() === sorted(C, B).join() ? true : { none, rowsAfter, on, off, again, mine };
  });

  await check('6-23(옛 권한): 옛 기상 조회 권한 행이 남아 있어도 판정에 안 쓰임 — 동의가 꺼져 있으면 안 보이고, 친구 출처 기상 조회는 써 넣어도 꺼진 채로 저장', async () => {
    const A = await join_(53, '보는이'), B = await join_(54, '옛권한'), C = await join_(55, '친구');
    await befriend(B, C);
    const { g } = await mkGroup(A, [B, C]);
    await todayAppt(A, g);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_wake) values ($1, $2, 'GROUP', $3, true)`, [B, A, g]);
    const f = await friendId(B, C);
    const p = await friendGrant(B, C, f, true, false, true);
    const stored = await rowOf(p);
    const hidden = await wakeIds(A, g);
    const viaFriend = await wakeIds(C, g);
    return stored.w === false && hidden.join() === [A].join() && viaFriend.join() === [C].join() ? true : { stored, hidden, viaFriend };
  });

  await check('6-45: 같은 사람이 두 그룹에 있을 때 기상 공유 동의는 그룹마다 따로 — 켠 그룹의 화면에서만 보임', async () => {
    const A = await join_(56, '보는이'), B = await join_(57, '두그룹');
    const g1 = (await mkGroup(A, [B])).g, g2 = (await mkGroup(A, [B])).g;
    await todayAppt(A, g1); await todayAppt(A, g2);
    await setOptIn(B, g1, true);
    const v1 = await wakeIds(A, g1), v2 = await wakeIds(A, g2);
    await setOptIn(B, g1, false); await setOptIn(B, g2, true);
    const w1 = await wakeIds(A, g1), w2 = await wakeIds(A, g2);
    return v1.join() === sorted(A, B).join() && v2.join() === [A].join() && w1.join() === [A].join() && w2.join() === sorted(A, B).join() ? true : { v1, v2, w1, w2 };
  });

  await check('6-45(차단): 동의한 멤버라도 차단한 사이(어느 쪽이든)에서는 안 보이고, 풀면 다시 보임 · 초대만 받은 사람과 나간 사람은 동의 값이 남아 있어도 안 보임', async () => {
    const A = await join_(58, '보는이'), B = await join_(59, '동의'), I = await join_(60, '초대만'), L = await join_(61, '나감');
    const { g } = await mkGroup(A, [B], { optIn: true });
    await q(`insert into public.group_members (group_id, user_id, invite_status, wake_share_opt_in) values ($1, $2, 'INVITED', true), ($1, $3, 'LEFT', true)`, [g, I, L]);
    await todayAppt(A, g);
    const before = await wakeIds(A, g);
    await call(B, 'public.block_user($1)', [A]);
    const blockedByB = await wakeIds(A, g);
    const bSees = await wakeIds(B, g);
    await call(B, 'public.unblock_user($1)', [A]);
    await call(A, 'public.block_user($1)', [B]);
    const blockedByA = await wakeIds(A, g);
    await call(A, 'public.unblock_user($1)', [B]);
    const back = await wakeIds(A, g);
    return before.join() === sorted(A, B).join() && blockedByB.join() === [A].join() && bSees.join() === [B].join()
      && blockedByA.join() === [A].join() && back.join() === sorted(A, B).join() ? true : { before, blockedByB, bSees, blockedByA, back };
  });

  // ---- 권한 행 보안 ----------------------------------------------------------------

  await check('6-31 · 6-32: 받은 사람은 권한 행을 바꾸지 못하고(0행) 지우지도 못함, 관계 없는 사람에게는 행이 안 읽힘', async () => {
    const A = await join_(62, '주인'), B = await join_(63, '받는이'), C = await join_(64, '남');
    await befriend(A, B);
    const f = await friendId(A, B);
    const p = await friendGrant(A, B, f, true);
    await as(B);
    const upd = await q(`update public.sharing_permissions set can_edit_alarm = true where permission_id = $1 returning 1`, [p]);
    const del = await q(`delete from public.sharing_permissions where permission_id = $1 returning 1`, [p]);
    const own = await q(`select 1 from public.sharing_permissions where permission_id = $1`, [p]);
    await as(C);
    const other = await q(`select 1 from public.sharing_permissions where permission_id = $1`, [p]);
    await su();
    const row = await rowOf(p);
    return upd.length === 0 && del.length === 0 && own.length === 1 && other.length === 0 && row.v === true && row.e === false ? true : { upd, del, own, other, row };
  });

  await check('6-33 ~ 6-36: 출처가 맞지 않으면 줄 수 없음 — 친구 아닌 그룹원에게 친구 출처로 · 관계 없는 사람에게 · 남의 관계 번호를 출처로 · 자기 자신에게 모두 거절', async () => {
    const A = await join_(65, '주인'), B = await join_(66, '그룹원'), C = await join_(67, '남'), D = await join_(68, '친구');
    await befriend(A, D); await befriend(B, C);
    const { g } = await mkGroup(A, [B]);
    const fAD = await friendId(A, D), fBC = await friendId(B, C);
    const tryInsert = async (grantee, type, src) => {
      await as(A);
      const r = await expectErr(() => q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, $3::public.permission_source, $4, true)`, [A, grantee, type, src]), /.*/);
      await su();
      return r;
    };
    const notFriend = await tryInsert(B, 'FRIEND', fAD);     // B는 그룹원일 뿐 친구가 아님
    const stranger = await tryInsert(C, 'GROUP', g);          // C는 그룹 밖
    const strangerFriend = await tryInsert(C, 'FRIEND', fAD);
    const foreignId = await tryInsert(D, 'FRIEND', fBC);      // A-D는 친구지만 남의 관계 번호
    const self = await tryInsert(A, 'GROUP', g);
    const rows = (await q(`select count(*)::int as n from public.sharing_permissions where owner_id = $1`, [A]))[0].n;
    return [notFriend, stranger, strangerFriend, foreignId, self].every((x) => x === true) && rows === 0 ? true : { notFriend, stranger, strangerFriend, foreignId, self, rows };
  });

  await check('6-37 · 6-38: 초대만 받은 사람(INVITED) 앞의 그룹 출처 행도, 친구가 끊긴 뒤 남은(서버가 넣은) 친구 출처 행도 판정에서 빠짐 — 알람이 안 읽히고 집계에 안 잡힘', async () => {
    const A = await join_(69, '주인'), B = await join_(70, '초대중'), C = await join_(71, '끊긴친구');
    const { g } = await mkGroup(A, []);
    await q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'INVITED')`, [g, B]);
    await apptAlarm(A);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm) values ($1, $2, 'GROUP', $3, true, true)`, [A, B, g]);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm) values ($1, $2, 'FRIEND', gen_random_uuid(), true, true)`, [A, C]);
    const sets = async (who) => (await q(`select (select count(*)::int from private.granted_owner_ids_for($1, 'VIEW_ALARM')) as v, (select count(*)::int from private.granted_owner_ids_for($1, 'EDIT_ALARM')) as e`, [who]))[0];
    const ok = { b: await sets(B), c: await sets(C), sawB: await seen(B, A), sawC: await seen(C, A), pushB: await canPush(B, A), pushC: await canPush(C, A) };
    return ok.b.v === 0 && ok.b.e === 0 && ok.c.v === 0 && ok.c.e === 0 && ok.sawB.length === 0 && ok.sawC.length === 0 && ok.pushB === false && ok.pushC === false ? true : ok;
  });

  // ---- 일정에 붙은 알람만 -----------------------------------------------------------

  await check('6-39: 조회 권한을 받으면 일정에 붙은 알람(개인 일정 · 그룹 일정)은 읽히고 약속 목록(G04)에 나오지만 루틴 알람 · 단독 알람은 안 읽힘 — 설정 권한이 있어도 루틴 · 단독 알람은 못 고침', async () => {
    const A = await join_(72, '주인'), B = await join_(73, '받는이');
    await befriend(A, B);
    const f = await friendId(A, B);
    const { g } = await mkGroup(A, [B]);
    const personal = await apptAlarm(A), grouped = await apptAlarm(A, g);
    const routine = await routineAlarm(A), solo = await soloAlarm(A);
    await friendGrant(A, B, f, true, true);
    const saw = await seen(B, A);
    await as(B);
    const g04 = await q(`select alarm_id from public.get_shared_alarm_appointments($1)`, [A]);
    await su();
    const edits = { personal: await canEdit(B, personal), grouped: await canEdit(B, grouped), routine: await canEdit(B, routine), solo: await canEdit(B, solo) };
    const mine = await seen(A, A);
    return saw.length === 2 && saw.includes(personal) && saw.includes(grouped) && !saw.includes(routine) && !saw.includes(solo)
      && g04.length === 2 && g04.every((x) => x.alarm_id === personal || x.alarm_id === grouped)
      && edits.personal === true && edits.grouped === true && edits.routine === false && edits.solo === false && mine.length === 4 ? true : { saw, g04, edits, mine };
  });

  await check('6-43(DB): 주인이 조회를 끈 순간 받은 사람의 읽기 · 수정이 바로 막힘 — 알람 화면은 비고 수정은 0행', async () => {
    const A = await join_(74, '주인'), B = await join_(75, '받는이');
    await befriend(A, B);
    const f = await friendId(A, B);
    const al = await apptAlarm(A);
    const p = await friendGrant(A, B, f, true, true);
    const on = { saw: await seen(B, A), edit: await canEdit(B, al) };
    await as(A);
    await q(`delete from public.sharing_permissions where permission_id = $1`, [p]);
    await su();
    const off = { saw: await seen(B, A), edit: await canEdit(B, al), push: await canPush(B, A) };
    return on.saw.length === 1 && on.edit === true && off.saw.length === 0 && off.edit === false && off.push === false ? true : { on, off };
  });

  await check('6장 실행 권한: 앱은 판정 · 트리거 보조 함수를 직접 못 부르고(permission denied), 서버 역할은 권한 집합을 직접 물을 수 있음', async () => {
    const A = await join_(76, '주인');
    await as(A);
    const helpers = [];
    for (const sql of [`select private.normalize_sharing_permission()`, `select private.grant_default_group_view()`, `select private.granted_owner_ids_for('${A}', 'VIEW_ALARM')`]) {
      helpers.push(await expectErr(() => q(sql), /permission denied/));
    }
    await su();
    await svc();
    const server = await q(`select count(*)::int as n from private.granted_owner_ids_for($1, 'VIEW_ALARM')`, [A]);
    await su();
    return helpers.every((x) => x === true) && server[0].n === 0 ? true : { helpers, server };
  });
}
