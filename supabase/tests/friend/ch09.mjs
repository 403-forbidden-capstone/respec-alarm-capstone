// 친구 9장 — 공동 약속 DB 규칙 (친구_시험케이스.md 9장 DB 층 + 11/9 헤드 결정, 항목 이름 앞 번호 = 시험케이스 번호)
//   이 장 DB에 없는 것: 9-03 · 9-07의 화면 글자 · 9-27 · 9-33 · 9-35 ~ 9-37 · 9-42(앱 · 실기기 층) — 서버 함수 층은 supabase/functions/_shared/edit-run.test.ts · notify.test.ts · push-copy.test.ts
//   날짜는 시험이 돌 때 항상 미래(2099-03-01) · 과거(2026-10-01)로 고정 (정책이 지금(now())과 비교하므로 시계가 가도 안 바뀌게).
//   지금 기준으로 바꿔 보는 시험(지난 시각으로 옮기기)만 now()를 씀. 사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch09({ q, as, su, svc, check, expectErr }) {
  const id = (n) => `b9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const NOBODY = 'b9000000-0000-4000-8000-999999999999';
  const FUTURE = '2099-03-01';
  const PAST = '2026-10-01';
  const at = (hhmm, day = FUTURE) => `${day}T${hhmm}:00+09:00`;
  const iso = (v) => (v == null ? null : new Date(v).toISOString());

  const join_ = async (n, nickname) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `f9-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f9_user_${n}`]);
    return id(n);
  };
  const call = async (uid, sql, params = []) => { await as(uid); const [r] = await q(`select ${sql} as r`, params); await su(); return r.r; };
  // 그룹 — 만든 사람은 트리거가 참여 중으로 넣고, 나머지는 바로 참여 중
  const mkGroup = async (owner, others = []) => {
    await as(owner);
    const [g] = await q(`insert into public.groups (group_name, owner_id) values ('약속그룹', $1) returning group_id`, [owner]);
    await su();
    for (const u of others) await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at) values ($1, $2, 'JOINED', now())`, [g.group_id, u]);
    return g.group_id;
  };
  const appt = async (creator, g, when, title = '그룹 약속', memo = null) =>
    (await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name, memo) values ($1, $2, $3, $4::timestamptz, '학교', $5) returning appointment_id`, [creator, g, title, when, memo]))[0].appointment_id;
  const part = async (u, ap) => (await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap, u]))[0].participant_id;
  const wakeAt = async (u, pt, when, enabled = true) =>
    (await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at, is_enabled) values ($1, $2, 'WAKE', $3::timestamptz, $4) returning alarm_id`, [pt, u, when, enabled]))[0].alarm_id;
  const n = async (sql, params = []) => (await q(`select count(*)::int as n from (${sql}) t`, params))[0].n;
  const partRows = (u, ap) => n(`select 1 from public.appointment_participants where user_id = $1 and appointment_id = $2`, [u, ap]);
  const alarmRows = (u) => n(`select 1 from public.alarms where user_id = $1`, [u]);
  const counts = async (viewer, g) => { await as(viewer); const r = await q(`select * from public.group_appointment_counts($1)`, [g]); await su(); return r; };
  const joiners = async (viewer, ap) => { await as(viewer); const r = await q(`select * from public.appointment_joiners($1)`, [ap]); await su(); return r; };

  // ---- 만들기 · 읽기 · 참여 조건 ------------------------------------------------------------

  await check('9-01 · 9-30: 그룹 멤버만 그룹 약속을 만들 수 있고(비멤버 거절), 그룹 없이는 공동 약속이 될 수 없음 — 개인 일정에는 다른 사람이 참여 조건을 못 넣음', async () => {
    const A = await join_(1, '에이'), B = await join_(2, '비'), X = await join_(3, '밖');
    const g = await mkGroup(A, [B]);
    await as(A);
    const [mine] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '내 그룹 약속', $3::timestamptz, '학교') returning appointment_id`, [A, g, at('10:00')]);
    await su();
    const outsider = await (async () => { await as(X); const r = await expectErr(() => q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '끼어들기', $3::timestamptz, '학교')`, [X, g, at('10:00')]), /row-level security/); await su(); return r; })();
    const personal = await appt(A, null, at('11:00'), '개인 일정');
    await as(B);
    const intoPersonal = await expectErr(() => q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2)`, [personal, B]), /row-level security/);
    const seesPersonal = await q(`select 1 from public.appointments where appointment_id = $1`, [personal]);
    await su();
    return !!mine.appointment_id && outsider === true && intoPersonal === true && seesPersonal.length === 0 ? true : { outsider, intoPersonal, seesPersonal };
  });

  await check('9-06 · 9-07 · 9-08 · 9-09 · 9-40: 그룹 밖 사람은 약속을 못 읽고 참여 조건을 못 넣음, 그룹원은 메모까지 읽고, 참여 조건 · 출발지는 본인 줄만, 같은 약속에 같은 사람은 한 줄, 남의 알람은 알람 조회 권한 없이는 안 보임', async () => {
    const A = await join_(4, '에이'), B = await join_(5, '비'), C = await join_(6, '씨'), X = await join_(7, '밖');
    const g = await mkGroup(A, [B, C]);
    const ap = await appt(A, g, at('10:00'), '팀 회의', '발표 자료 가져오기');
    const pa = await part(A, ap), pb = await part(B, ap);
    await wakeAt(A, pa, at('07:00')); await wakeAt(B, pb, at('06:30'));
    await as(X);
    const outRead = await q(`select 1 from public.appointments where appointment_id = $1`, [ap]);
    const outInsert = await expectErr(() => q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2)`, [ap, X]), /row-level security/);
    await as(C);                                                         // 참여 안 한 그룹원
    const memo = await q(`select memo from public.appointments where appointment_id = $1`, [ap]);
    const others = await q(`select 1 from public.appointment_participants where appointment_id = $1`, [ap]);
    const alarmsSeen = await q(`select 1 from public.alarms`);          // 알람 조회 권한이 없어 0행
    await as(B);
    const mineOnly = await q(`select user_id from public.appointment_participants where appointment_id = $1`, [ap]);
    const touchA = await q(`update public.appointment_participants set origin_name = '남의 집' where participant_id = $1 returning 1`, [pa]);
    const dup = await expectErr(() => q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2)`, [ap, B]), /duplicate key|unique/);
    const aAlarm = await q(`select 1 from public.alarms where user_id = $1`, [A]);
    await su();
    return outRead.length === 0 && outInsert === true && memo.length === 1 && memo[0].memo === '발표 자료 가져오기' && others.length === 0 && alarmsSeen.length === 0
      && mineOnly.length === 1 && mineOnly[0].user_id === B && touchA.length === 0 && dup === true && aAlarm.length === 0 ? true : { outRead, outInsert, memo, others, alarmsSeen, mineOnly, touchA, dup, aAlarm };
  });

  // ---- 고치기 · 지우기는 그룹원 누구나 (#619 — 만든 사람은 기록일 뿐) ---------------------------

  await check('9-18 · 9-19 · 9-31 · #619: 공동 약속은 그룹원 누구나 고치고 지움 — 참여자 · 참여 안 한 그룹원도 됨, 만든 사람 칸은 그대로, 그룹(group_id)은 아무도 못 바꿈', async () => {
    const A = await join_(8, '만든이'), B = await join_(9, '참여'), C = await join_(10, '그룹원');
    const g = await mkGroup(A, [B, C]), other = await mkGroup(A, []);
    const ap = await appt(A, g, at('10:00'), '원래 제목');
    await part(A, ap); await part(B, ap);
    const upd = async (u, title) => { await as(u); const r = await q(`update public.appointments set title = $2, appointment_at = appointment_at + interval '10 minutes' where appointment_id = $1 returning appointment_id`, [ap, title]); await su(); return r.length; };
    const byA = await upd(A, 'A가 고침'), byC = await upd(C, 'C가 고침'), byB = await upd(B, 'B가 고침');
    await as(B);
    const moveGroup = await expectErr(() => q(`update public.appointments set group_id = $2 where appointment_id = $1`, [ap, other]), /바꿀 수 없음/);
    await su();
    const [{ title, creator_id: creator }] = await q(`select title, creator_id from public.appointments where appointment_id = $1`, [ap]);
    const del = async (u) => { await as(u); const r = await q(`delete from public.appointments where appointment_id = $1 returning appointment_id`, [ap]); await su(); return r.length; };
    const delB = await del(B);
    return byB === 1 && byC === 1 && byA === 1 && delB === 1 && moveGroup === true && title === 'B가 고침' && creator === A ? true : { byB, byC, byA, delB, moveGroup, title, creator };
  });

  await check('9-38 · #619: 만든 사람이 없는 약속 · 있는 약속 모두 그룹원이 고침 — 참여 안 한 그룹원도 (지우기는 아래 X-APPT-01)', async () => {
    const A = await join_(11, '남은만든이'), B = await join_(12, '참여자'), C = await join_(13, '참여안함');
    const g = await mkGroup(A, [B, C]);
    const orphan = await appt(A, g, at('10:00'), '주인 없는 약속'), alive = await appt(A, g, at('14:00'), '주인 있는 약속');
    await part(B, orphan); await part(B, alive);
    await q(`alter table public.appointments disable trigger keep_keys`);       // 탈퇴 연쇄(12장)가 하는 일을 흉내: 만든 사람 칸 비우기
    try {
      await q(`update public.appointments set creator_id = null where appointment_id = $1`, [orphan]);
    } finally {
      await q(`alter table public.appointments enable trigger keep_keys`);
    }
    const upd = async (u, ap) => { await as(u); const r = await q(`update public.appointments set title = '고침' where appointment_id = $1 returning appointment_id`, [ap]); await su(); return r.length; };
    const r = { bOrphan: await upd(B, orphan), cOrphan: await upd(C, orphan), bAlive: await upd(B, alive) };
    return r.bOrphan === 1 && r.cOrphan === 1 && r.bAlive === 1 ? true : r;
  });

  await check('X-APPT-01 · #619: 공동 약속은 그룹원이 지움(만든 사람이 없거나 남이어도, 참여 안 한 그룹원도) — 지난 약속은 0행, 지우면 참여 조건 · 알람도 같이 사라짐', async () => {
    const A = await join_(47, '남은만든이'), B = await join_(48, '참여자'), C = await join_(49, '참여안함');
    const g = await mkGroup(A, [B, C]);
    const orphan = await appt(A, g, at('10:00'), '주인 없는 약속'), alive = await appt(A, g, at('14:00'), '주인 있는 약속'), past = await appt(A, g, at('10:00', PAST), '지난 주인 없는 약속');
    const pb = await part(B, orphan); await part(B, alive); await part(B, past);
    await wakeAt(B, pb, at('07:00'));
    await q(`alter table public.appointments disable trigger keep_keys`);       // 탈퇴 연쇄(12장)가 하는 일을 흉내: 만든 사람 칸 비우기
    try {
      await q(`update public.appointments set creator_id = null where appointment_id = any($1::uuid[])`, [[orphan, past]]);
    } finally {
      await q(`alter table public.appointments enable trigger keep_keys`);
    }
    const del = async (u, ap) => { await as(u); const r = await q(`delete from public.appointments where appointment_id = $1 returning appointment_id`, [ap]); await su(); return r.length; };
    const r = { bPast: await del(B, past), cPast: await del(C, past), cOrphan: await del(C, orphan), bAlive: await del(B, alive) };
    const left = { orphan: await n(`select 1 from public.appointments where appointment_id = $1`, [orphan]), parts: await partRows(B, orphan), alarms: await alarmRows(B), alive: await n(`select 1 from public.appointments where appointment_id = $1`, [alive]), past: await n(`select 1 from public.appointments where appointment_id = $1`, [past]) };
    return r.bPast === 0 && r.cPast === 0 && r.cOrphan === 1 && r.bAlive === 1 && left.orphan === 0 && left.parts === 0 && left.alarms === 0 && left.alive === 0 && left.past === 1 ? true : { r, left };
  });

  await check('9-20: 만든 사람이 지우면 모든 참여자의 참여 조건 · 알람이 같이 지워짐 — 다른 약속은 그대로', async () => {
    const A = await join_(14, '만든이'), B = await join_(15, '참여');
    const g = await mkGroup(A, [B]);
    const ap = await appt(A, g, at('10:00')), keep = await appt(A, g, at('15:00'));
    const pb = await part(B, ap), pk = await part(B, keep);
    await wakeAt(B, pb, at('07:00')); await wakeAt(B, pk, at('12:00'));
    await as(A);
    const gone = await q(`delete from public.appointments where appointment_id = $1 returning appointment_id`, [ap]);
    await su();
    return gone.length === 1 && (await partRows(B, ap)) === 0 && (await partRows(B, keep)) === 1 && (await alarmRows(B)) === 1 ? true : { gone: gone.length, left: await alarmRows(B) };
  });

  await check('9-32: 지난 공동 약속은 참여 조건을 새로 만들 수 없고 만든 사람도 못 고침 — 앞으로 약속은 되고, 개인 일정은 지나도 기록하러 참여 조건을 넣을 수 있음', async () => {
    const A = await join_(16, '만든이'), B = await join_(17, '참여');
    const g = await mkGroup(A, [B]);
    const past = await appt(A, g, at('10:00', PAST)), future = await appt(A, g, at('10:00')), personal = await appt(B, null, at('10:00', PAST), '지난 개인 일정');
    await as(B);
    const joinPast = await expectErr(() => q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2)`, [past, B]), /row-level security/);
    const joinFuture = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [future, B]);
    const joinPersonal = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [personal, B]);
    await as(A);
    const editPast = await q(`update public.appointments set title = '지난 약속 고침' where appointment_id = $1 returning appointment_id`, [past]);
    const editFuture = await q(`update public.appointments set title = '앞으로 약속 고침' where appointment_id = $1 returning appointment_id`, [future]);
    await su();
    return joinPast === true && joinFuture.length === 1 && joinPersonal.length === 1 && editPast.length === 0 && editFuture.length === 1 ? true : { joinPast, joinFuture, joinPersonal, editPast, editFuture };
  });

  // ---- 참여 · 빠지기 · 인원수 ----------------------------------------------------------------

  await check('9-21 · 9-22 · 9-23: 내 참여 조건을 지우면(나는 빠지기) 내 알람도 같이 지워지고 다른 사람은 그대로 — 다시 만들면 돌아오고, 알람을 끄면 참여가 아님. 인원수 = 알람이 켜진 참여 수', async () => {
    const A = await join_(18, '만든이'), B = await join_(19, '빠짐'), C = await join_(20, '안누름');
    const g = await mkGroup(A, [B, C]);
    const ap = await appt(A, g, at('10:00'));
    const pa = await part(A, ap), pb = await part(B, ap);
    const aa = await wakeAt(A, pa, at('07:00')), ba = await wakeAt(B, pb, at('06:30'));
    const c0 = (await counts(A, g)).find((x) => x.appointment_id === ap);
    await as(B);
    await q(`delete from public.appointment_participants where participant_id = $1`, [pb]);       // 나는 빠지기
    await su();
    const c1 = (await counts(A, g)).find((x) => x.appointment_id === ap);
    const left = { b: await alarmRows(B), a: await alarmRows(A) };
    await as(B);                                                                                 // 다시 [내 알람 만들기]
    const [again] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap, B]);
    await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', $3::timestamptz)`, [again.participant_id, B, at('06:30')]);
    await su();
    const c2 = (await counts(A, g)).find((x) => x.appointment_id === ap);
    await as(B);
    await q(`update public.alarms set is_enabled = false where user_id = $1`, [B]);               // 알람 끔
    await su();
    const c3 = (await counts(A, g)).find((x) => x.appointment_id === ap);
    return aa && ba && c0.joined_count === 2 && c1.joined_count === 1 && left.b === 0 && left.a === 1 && c2.joined_count === 2 && c3.joined_count === 1 ? true : { c0, c1, left, c2, c3 };
  });

  await check('9장 인원수 조회: group_appointment_counts(그룹) — 그 그룹 약속마다 알람이 켜진 참여 수 · 내가 참여 중인지, 참여 중 멤버만 부름(밖 · 초대만 · 나간 사람 · 로그인 없음은 빈 결과, anon 거절)', async () => {
    const A = await join_(21, '에이'), B = await join_(22, '비'), I = await join_(23, '초대만'), L = await join_(24, '나감'), X = await join_(25, '밖');
    const g = await mkGroup(A, [B, L]);
    await q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'INVITED')`, [g, I]);
    const ap1 = await appt(A, g, at('10:00')), ap2 = await appt(A, g, at('14:00'));
    const pa = await part(A, ap1), pb = await part(B, ap1), pb2 = await part(B, ap2);
    await wakeAt(A, pa, at('07:00')); await wakeAt(B, pb, at('06:30')); await wakeAt(B, pb2, at('12:00'), false);   // 둘째 약속은 알람이 꺼져 있어 참여 아님
    const pl = await part(L, ap1); await wakeAt(L, pl, at('06:00'));                              // 나가기 전에 참여했던 사람
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, L]);
    await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) on conflict do nothing`, [ap1, L]);   // (나간 뒤에도 남은 참여 조건이 있다 해도 세지 않음)
    const stale = await part(L, ap2).catch(() => null);
    if (stale) await wakeAt(L, stale, at('11:00'));
    const forA = await counts(A, g), forB = await counts(B, g);
    const byId = (r, ap) => r.find((x) => x.appointment_id === ap);
    const outsiders = [await counts(X, g), await counts(I, g), await counts(L, g)];
    await as(null);
    const nobody = await q(`select * from public.group_appointment_counts($1)`, [g]);
    await as(null, 'anon');
    const anon = await expectErr(() => q(`select * from public.group_appointment_counts($1)`, [g]), /permission denied/);
    await su();
    return forA.length === 2 && byId(forA, ap1).joined_count === 2 && byId(forA, ap1).i_joined === true && byId(forA, ap2).joined_count === 0 && byId(forA, ap2).i_joined === false
      && byId(forB, ap2).i_joined === false && outsiders.every((r) => r.length === 0) && nobody.length === 0 && anon === true ? true : { forA, forB, outsiders, nobody, anon };
  });

  await check('9장 참여자 조회: appointment_joiners(약속) — 그 그룹 참여 중 멤버마다 참여 / 알람 없음 두 가지뿐(안 누름 · 빠짐 · 끔은 모두 알람 없음), 그룹 밖 · 초대만 · 로그인 없음은 빈 결과', async () => {
    const A = await join_(26, '에이'), B = await join_(27, '비'), C = await join_(28, '안누름'), D = await join_(29, '끔'), X = await join_(30, '밖');
    const g = await mkGroup(A, [B, C, D]);
    const ap = await appt(A, g, at('10:00'));
    const pa = await part(A, ap), pb = await part(B, ap), pd = await part(D, ap);
    await wakeAt(A, pa, at('07:00')); await wakeAt(B, pb, at('06:30')); await wakeAt(D, pd, at('06:30'), false);
    const r = await joiners(A, ap);
    const joinedOf = (u) => r.find((x) => x.user_id === u)?.joined;
    const out = await joiners(X, ap);
    const none = await joiners(A, NOBODY);
    await call(A, 'public.block_user($1)', [B]);                       // 차단 쌍은 줄은 있되 참여 여부가 비어 있음(어느 쪽에서 보든)
    const fromA = await joiners(A, ap), fromB = await joiners(B, ap);
    await as(null);
    const nobody = await q(`select * from public.appointment_joiners($1)`, [ap]);
    await su();
    const pick = (rows, u) => rows.find((x) => x.user_id === u);
    const shape = (rows, u) => [pick(rows, u).joined, pick(rows, u).hidden];
    return r.length === 4 && joinedOf(A) === true && joinedOf(B) === true && joinedOf(C) === false && joinedOf(D) === false && out.length === 0 && none.length === 0 && nobody.length === 0
      && r.every((x) => x.hidden === false)
      && fromA.length === 4 && JSON.stringify(shape(fromA, B)) === '[false,true]' && JSON.stringify(shape(fromA, D)) === '[false,false]' && JSON.stringify(shape(fromA, A)) === '[true,false]'
      && JSON.stringify(shape(fromB, A)) === '[false,true]' && JSON.stringify(shape(fromB, B)) === '[true,false]' ? true : { r, out, none, nobody, fromA, fromB };
  });

  await check('9장 인원수: 차단 쌍은 합계에서 빠짐 — 참여 여부를 비운 사람이 합계로 되짚이지 않게(내 쪽 · 상대 쪽 모두), 내 참여는 늘 셈', async () => {
    const A = await join_(40, '에이'), B = await join_(41, '비'), C = await join_(42, '씨');
    const g = await mkGroup(A, [B, C]);
    const ap = await appt(A, g, at('10:00'));
    const pa = await part(A, ap), pb = await part(B, ap), pc = await part(C, ap);
    await wakeAt(A, pa, at('07:00')); await wakeAt(B, pb, at('06:30')); await wakeAt(C, pc, at('06:30'));
    const before = (await counts(A, g))[0].joined_count;
    await call(A, 'public.block_user($1)', [B]);
    const fromA = (await counts(A, g))[0], fromB = (await counts(B, g))[0], fromC = (await counts(C, g))[0];
    return before === 3 && fromA.joined_count === 2 && fromA.i_joined === true && fromB.joined_count === 2 && fromB.i_joined === true && fromC.joined_count === 3 ? true : { before, fromA, fromB, fromC };
  });

  await check('9-32(DB): 만든 사람도 공동 약속을 지난 날(어제 이전, 사람마다 폰 시간대 0시 기준)로 못 옮김(오류 42501) — 오늘 안의 시각으로 옮기기는 됨(이미 지난 오늘 시각도), 지난 날의 공동 약속은 만든 사람도 못 고침 · 참여 조건도 새로 못 만듦, 오늘 이미 지난 약속은 고치기 · 참여 가능', async () => {
    const A = await join_(43, '만든이'), B = await join_(44, '참여');
    const g = await mkGroup(A, [B]);
    const ap = await appt(A, g, at('10:00'));
    await as(A);
    const toPast = await expectErr(() => q(`update public.appointments set appointment_at = private.day_start($2) - interval '1 second' where appointment_id = $1`, [ap, A]), /row-level security/);
    const toSoon = await q(`update public.appointments set appointment_at = now() + interval '1 hour' where appointment_id = $1 returning appointment_id`, [ap]);
    const toEarlyToday = await q(`update public.appointments set appointment_at = private.day_start($2) where appointment_id = $1 returning appointment_id`, [ap, A]);   // 오늘 0시 = 오늘 안
    await su();
    // 오늘 이미 지난 약속 (오늘 0시 + 1분): 만든 사람이 고칠 수 있고 다른 참여자가 참여 조건을 만들 수 있음. 어제 약속은 둘 다 못 함
    const earlyToday = (await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '오늘 이른 약속', private.day_start($1) + interval '1 minute', '학교') returning appointment_id`, [A, g]))[0].appointment_id;
    const yesterday = (await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '어제 약속', private.day_start($1) - interval '1 second', '학교') returning appointment_id`, [A, g]))[0].appointment_id;
    await as(A);
    const editEarly = await q(`update public.appointments set title = '고침' where appointment_id = $1 returning appointment_id`, [earlyToday]);
    const editYesterday = await q(`update public.appointments set title = '고침' where appointment_id = $1 returning appointment_id`, [yesterday]);
    await su();
    await as(B);
    const joinEarly = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [earlyToday, B]);
    const joinYesterday = await expectErr(() => q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2)`, [yesterday, B]), /row-level security/);
    await su();
    const past = await appt(A, g, at('10:00', PAST), '지난 약속');
    await as(A);
    const editPast = await q(`update public.appointments set title = '고침' where appointment_id = $1 returning appointment_id`, [past]);
    await su();
    return toPast === true && toSoon.length === 1 && toEarlyToday.length === 1 && editPast.length === 0
      && editEarly.length === 1 && editYesterday.length === 0 && joinEarly.length === 1 && joinYesterday === true ? true : { toPast, toSoon, toEarlyToday, editPast, editEarly, editYesterday, joinEarly, joinYesterday };
  });

  // ---- 그룹을 나갈 때 정리 -------------------------------------------------------------------

  await check('9-29(11/9 결정): 그룹을 나가면 그 그룹의 앞으로 약속의 참여 · 알람만 지움 — 지난 약속의 참여 · 울림 · 이동 시간 기록은 남고, 다른 사람 · 다른 그룹은 그대로, 내보내져도 같음', async () => {
    const A = await join_(31, '만든이'), B = await join_(32, '나감'), K = await join_(33, '내보내짐');
    const g = await mkGroup(A, [B, K]), other = await mkGroup(B, [A]);
    const fut = await appt(A, g, at('10:00')), past = await appt(A, g, at('10:00', PAST)), outside = await appt(B, other, at('10:00'));
    const bf = await part(B, fut), bp = await part(B, past), bo = await part(B, outside), kf = await part(K, fut), kp = await part(K, past);
    await q(`update public.appointment_participants set arrived_at = $2::timestamptz, actual_travel_minutes = 25 where participant_id = any($1::uuid[])`, [[bp, kp], at('09:55', PAST)]);
    await wakeAt(B, bf, at('07:00')); const rung = await wakeAt(B, bp, at('07:00', PAST)); await wakeAt(B, bo, at('07:00')); await wakeAt(K, kf, at('07:00')); await wakeAt(K, kp, at('07:00', PAST));
    await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at) values ($1, $2, 'TRIGGERED', $3::timestamptz)`, [rung, B, at('07:00', PAST)]);
    await as(B);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, B]);       // 나가기
    await as(A);
    await q(`delete from public.group_members where group_id = $1 and user_id = $2`, [g, K]);                              // 내보내기
    await su();
    const rec = (await q(`select arrived_at, actual_travel_minutes from public.appointment_participants where participant_id = $1`, [bp]))[0];
    const recK = (await q(`select arrived_at from public.appointment_participants where participant_id = $1`, [kp]))[0];
    const r = {
      bFuture: await partRows(B, fut), bPast: await partRows(B, past), bOther: await partRows(B, outside), kFuture: await partRows(K, fut), kPast: await partRows(K, past),
      bAlarms: await alarmRows(B), kAlarms: await alarmRows(K), events: await n(`select 1 from public.alarm_events where user_id = $1`, [B]),
      appts: await n(`select 1 from public.appointments where group_id = $1`, [g]),
    };
    return r.bFuture === 0 && r.bPast === 1 && r.bOther === 1 && r.kFuture === 0 && r.kPast === 1 && r.bAlarms === 2 && r.kAlarms === 1 && r.events === 1 && r.appts === 2
      && iso(rec.arrived_at) === iso(at('09:55', PAST)) && rec.actual_travel_minutes === 25 && iso(recK.arrived_at) === iso(at('09:55', PAST)) ? true : { r, rec, recK };
  });

  await check('9-29(하루 경계): 하루 경계(private.day_start)는 사람마다 프로필 시간대의 오늘 0시(없으면 서울) — 나갈 때 그 사람 오늘 0시 이후 약속의 참여만 지우고 어제 약속의 참여는 남김', async () => {
    const A = await join_(45, '만든이'), B = await join_(46, '나감');
    await q(`update public.profiles set timezone = 'UTC' where user_id = $1`, [B]);
    const [{ seoul, utc, ghost }] = await q(`select private.day_start($1) = ((now() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul') as seoul,
                                                    private.day_start($2) = ((now() at time zone 'UTC')::date::timestamp at time zone 'UTC') as utc,
                                                    private.day_start('b9000000-0000-4000-8000-999999999999') = ((now() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul') as ghost`, [A, B]);
    const g = await mkGroup(A, [B]);
    const [{ appointment_id: today }] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '오늘 이른 약속', private.day_start($3) + interval '1 minute', '학교') returning appointment_id`, [A, g, B]);
    const [{ appointment_id: yesterday }] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '어제 약속', private.day_start($3) - interval '1 second', '학교') returning appointment_id`, [A, g, B]);
    await part(B, today); await part(B, yesterday);
    await as(B);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, B]);
    await su();
    const left = (await q(`select ap.appointment_id from public.appointment_participants ap where ap.user_id = $1`, [B])).map((x) => x.appointment_id);
    return seoul === true && utc === true && ghost === true && left.length === 1 && left[0] === yesterday ? true : { seoul, utc, ghost, left, today, yesterday };
  });

  await check('9-28: 그룹의 마지막 참여 멤버가 나가면 그룹이 지워지며 약속 · 참여 · 알람이 모두 지워짐 — 각자 하루 기록(기상 기록)은 남음', async () => {
    const A = await join_(34, '혼자'), B = await join_(35, '곧나감');
    const g = await mkGroup(A, [B]);
    const ap = await appt(A, g, at('10:00')), past = await appt(A, g, at('10:00', PAST));
    const pa = await part(A, ap), pb = await part(B, ap), pp = await part(B, past);
    await wakeAt(A, pa, at('07:00')); await wakeAt(B, pb, at('07:00'));
    await q(`insert into public.daily_records (user_id, record_date, wake_confirmed_at) values ($1, $2::date, $3::timestamptz)`, [B, PAST, at('07:10', PAST)]);
    await as(B);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, B]);
    await as(A);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, A]);
    await su();
    const r = { groups: await n(`select 1 from public.groups where group_id = $1`, [g]), appts: await n(`select 1 from public.appointments where group_id = $1`, [g]), parts: await n(`select 1 from public.appointment_participants where participant_id = any($1::uuid[])`, [[pa, pb, pp]]),
                alarms: await n(`select 1 from public.alarms where user_id = any($1::uuid[])`, [[A, B]]), records: await n(`select 1 from public.daily_records where user_id = $1`, [B]) };
    return r.groups === 0 && r.appts === 0 && r.parts === 0 && r.alarms === 0 && r.records === 1 ? true : r;
  });

  await check('9장(나간 뒤): 그룹을 나간 사람은 자기가 만든 그 그룹 약속을 더 지울 수 없음 — 남은 그룹원에게 영향이 없게', async () => {
    const A = await join_(36, '남음'), B = await join_(37, '만들고나감');
    const g = await mkGroup(A, [B]);
    const ap = await appt(B, g, at('10:00'));
    await as(B);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, B]);
    const del = await q(`delete from public.appointments where appointment_id = $1 returning appointment_id`, [ap]);
    const upd = await q(`update public.appointments set title = '나가고 고침' where appointment_id = $1 returning appointment_id`, [ap]);
    await su();
    return del.length === 0 && upd.length === 0 && (await n(`select 1 from public.appointments where appointment_id = $1`, [ap])) === 1 ? true : { del, upd };
  });

  // ---- 그날 가장 이른 약속 -------------------------------------------------------------------

  await check('9-34: 같은 그룹 같은 날 약속이 둘이면 기상 상태는 그날 가장 이른 기상 알람 하나로 — 둘째 약속의 알람은 따로 줄을 만들지 않음', async () => {
    const A = await join_(38, '에이'), B = await join_(39, '비');
    const g = await mkGroup(A, [B]);
    await q(`update public.group_members set wake_share_opt_in = true where group_id = $1`, [g]);
    const ap1 = await appt(A, g, at('09:00')), ap2 = await appt(A, g, at('14:00'));
    const p1 = await part(B, ap1), p2 = await part(B, ap2);
    await wakeAt(B, p2, at('12:00')); await wakeAt(B, p1, at('06:30'));
    const rows = await q(`select * from private.group_wake_rows($1, $2, $3::date, $4::timestamptz)`, [A, g, FUTURE, at('05:00')]);
    const b = rows.filter((x) => x.user_id === B);
    return b.length === 1 && iso(b[0].wake_alarm_at) === iso(at('06:30')) ? true : { b };
  });

  // ---- 탐색 시험 X-APPT-04: 나가는 사람의 앞으로 약속 중 참여자가 한 명도 안 남은 것은 같이 지움 -------------

  await check('X-APPT-04 · X-STATE-02: 그룹을 나가 참여자가 0명이 되고 만든 사람 칸도 빈 앞으로 약속(내가 만들고 혼자 참여한 약속 · 만든 사람 칸이 이미 비고 나만 참여한 약속)은 같이 지워지고, 다른 참여자가 남은 약속 · 만든 사람이 남은 약속 · 지난 약속은 그대로 — 지난 약속 참여 기록은 다시 초대받아 들어와도 남음', async () => {
    const A = await join_(50, '나가는이'), B = await join_(51, '남는이');
    const g = await mkGroup(A, [B]);
    const solo = await appt(A, g, at('10:00'), '혼자 참여한 약속'), shared = await appt(A, g, at('11:00'), '같이 참여한 약속');
    const orphanMine = await appt(A, g, at('12:00'), '만든 사람 칸이 이미 빈 약속'), bOwned = await appt(B, g, at('13:00'), '남이 만들고 나만 참여한 약속');
    const past = await appt(A, g, at('10:00', PAST), '지난 약속');
    await part(A, solo); await part(A, shared); await part(B, shared); await part(A, past); await part(A, orphanMine); await part(A, bOwned);
    await q(`alter table public.appointments disable trigger keep_keys`);       // 탈퇴 연쇄(12장)가 하는 일을 흉내: 만든 사람 칸 비우기
    try {
      await q(`update public.appointments set creator_id = null where appointment_id = $1`, [orphanMine]);
    } finally {
      await q(`alter table public.appointments enable trigger keep_keys`);
    }
    await as(A);
    const [sum] = await q(`select * from public.my_account_delete_summary()`);   // 내가 만들어 남을 공동 약속 수 — 나가며 같이 지워질 혼자 참여한 앞으로 약속은 뺌
    const left = await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2 returning 1`, [g, A]);
    await su();
    const exists = (ap) => n(`select 1 from public.appointments where appointment_id = $1`, [ap]);
    const after = { solo: await exists(solo), orphanMine: await exists(orphanMine), shared: await exists(shared), bOwned: await exists(bOwned), past: await exists(past) };
    const sharedRow = (await q(`select creator_id from public.appointments where appointment_id = $1`, [shared]))[0];
    const parts = { aShared: await partRows(A, shared), bShared: await partRows(B, shared), aPast: await partRows(A, past) };
    // 다시 초대받아 들어옴 — 지난 약속 참여 기록은 그대로
    await q(`update public.group_members set invite_status = 'INVITED', invited_by = $3, invited_at = now(), joined_at = null where group_id = $1 and user_id = $2`, [g, A, B]);
    const back = await call(A, 'public.accept_group_invite($1, false)', [g]);
    const aPastBack = await partRows(A, past);
    return left.length === 1 && after.solo === 0 && after.orphanMine === 0 && after.shared === 1 && after.bOwned === 1 && after.past === 1 && sum.group_appointments_staying === 2
      && sharedRow.creator_id === null && parts.aShared === 0 && parts.bShared === 1 && parts.aPast === 1 && back.status === 'JOINED' && aPastBack === 1 ? true : { sum, left, after, sharedRow, parts, back, aPastBack };
  });

  // ---- 탐색 시험 X-PRIV-09: 남의 그룹 공동 약속의 제목 · 장소는 가림 ----------------------------------------

  await check('X-PRIV-09: 알람 조회 권한으로 보는 약속 정보(get_shared_alarm_appointments)에서 보는 사람이 그 그룹 멤버가 아닌 공동 약속은 제목 "그룹 일정" · 장소 빈 글자 — 같은 그룹 멤버가 보면 그대로, 개인 일정은 그대로, 시각은 그대로', async () => {
    const O = await join_(53, '주인'), V = await join_(54, '그룹밖친구'), M = await join_(55, '같은그룹친구');
    const g = await mkGroup(O, [M]);                                          // V는 이 그룹 멤버가 아님
    const befriend = async (a, b) => {
      await call(a, 'public.send_friend_request($1)', [b]);
      await call(b, 'public.accept_friend_request($1)', [a]);
      await q(`delete from public.rate_limit_events where user_id = any($1::uuid[])`, [[a, b]]);
    };
    const grant = async (owner, grantee) => {
      const [f] = await q(`select friend_id from public.friends where least(requester_id, addressee_id) = least($1::uuid, $2::uuid) and greatest(requester_id, addressee_id) = greatest($1::uuid, $2::uuid)`, [owner, grantee]);
      await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, 'FRIEND', $3, true)`, [owner, grantee, f.friend_id]);
    };
    await befriend(O, V); await befriend(O, M); await grant(O, V); await grant(O, M);
    const group = await appt(O, g, at('10:00'), '비밀 모임'), solo = await appt(O, null, at('14:00'), '개인 일정');
    await wakeAt(O, await part(O, group), at('07:00')); await wakeAt(O, await part(O, solo), at('12:00'));
    const seen = async (viewer) => { await as(viewer); const r = await q(`select * from public.get_shared_alarm_appointments($1)`, [O]); await su(); return r; };
    const byTitle = (r, ap) => r.find((x) => x.appointment_id === ap);
    const outsider = await seen(V), member = await seen(M);
    const og = byTitle(outsider, group), os = byTitle(outsider, solo), mg = byTitle(member, group), ms = byTitle(member, solo);
    return outsider.length === 2 && og.title === '그룹 일정' && og.dest_name === '' && iso(og.appointment_at) === iso(at('10:00')) && os.title === '개인 일정' && os.dest_name === '학교'
      && member.length === 2 && mg.title === '비밀 모임' && mg.dest_name === '학교' && ms.title === '개인 일정' ? true : { outsider, member };
  });
}
