// 친구 12장 — 계정 삭제 (친구_시험케이스.md 12장 DB · 함수 층, 11/8 확정 + 11/9 헤드 결정 '나갈 때 만든 사람 칸 비우기')
//   항목 이름 앞 번호 = 시험케이스 번호
//   이 장 DB에 없는 것: 12-07 · 12-08 · 12-20 · 12-21 · 12-25의 화면 글자 · 12-26(앱 · 웹) · 12-23(대본) · 12-13(반복 공동 약속이 아직 없어 그 PR 때) —
//   서버 함수 층(12-14 ~ 12-17)은 supabase/functions/_shared/account.test.ts. 계정을 지우는 일(auth.admin.deleteUser)은 여기서 auth.users 행 삭제로 흉내
//   사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch12({ q, as, su, svc, check, expectErr }) {
  const id = (n) => `bc000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const NOBODY = 'bc000000-0000-4000-8000-999999999999';
  const FUTURE = '2099-03-01';
  const PAST = '2026-10-01';
  const at = (hhmm, day = FUTURE) => `${day}T${hhmm}:00+09:00`;

  const join_ = async (n, nickname) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `f12-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f12_user_${n}`]);
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
  const grant = async (owner, grantee) => {
    const f = await friendId(owner, grantee);
    await as(owner);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm)
             values ($1, $2, 'FRIEND', $3, true, true)`, [owner, grantee, f]);
    await su();
  };
  // 그룹 — 만든 사람은 트리거가 참여 중으로 넣고, 나머지는 바로 참여 중, invited는 초대만
  const mkGroup = async (owner, others = [], invited = []) => {
    await as(owner);
    const [g] = await q(`insert into public.groups (group_name, owner_id) values ('탈퇴그룹', $1) returning group_id, invite_code`, [owner]);
    await su();
    for (const u of others) await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at) values ($1, $2, 'JOINED', now())`, [g.group_id, u]);
    for (const u of invited) await q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'INVITED')`, [g.group_id, u]);
    return { g: g.group_id, code: g.invite_code };
  };
  const appt = async (creator, g, when, title = '약속') =>
    (await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, $3, $4::timestamptz, '학교') returning appointment_id`, [creator, g, title, when]))[0].appointment_id;
  const part = async (u, ap) => (await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap, u]))[0].participant_id;
  const wakeAt = async (u, pt, when) => (await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', $3::timestamptz) returning alarm_id`, [pt, u, when]))[0].alarm_id;
  const n = async (sql, params = []) => (await q(`select count(*)::int as n from (${sql}) t`, params))[0].n;
  const prepare = async (uid) => { await svc(); const [r] = await q(`select public.prepare_account_delete($1) as r`, [uid]); await su(); return r.r; };
  const summary = async (uid) => { await as(uid); const [r] = await q(`select * from public.my_account_delete_summary()`); await su(); return r; };
  const remove = (uid) => q(`delete from auth.users where id = $1`, [uid]);           // auth.admin.deleteUser 흉내 (프로필 · 나머지는 연쇄)
  const creatorOf = async (ap) => (await q(`select creator_id from public.appointments where appointment_id = $1`, [ap]))[0]?.creator_id;
  const exists = async (table, col, v) => (await n(`select 1 from public.${table} where ${col} = $1`, [v])) > 0;

  // ---- 탈퇴 한 사람의 모든 것 ------------------------------------------------------------------

  await check('12-01 · 12-02 · 12-24: 그룹 3개(다른 멤버 있는 2개 + 혼자 1개) · 친구 · 권한 · 차단 · 개인 약속 · 알람 · 토큰이 있는 사람이 탈퇴하면 — 요약 숫자가 맞고, 3개 그룹에서 모두 나가 혼자였던 그룹만 사라지고, 공동 약속은 남아 만든 사람이 비며, 나머지 개인 정보는 모두 지워짐', async () => {
    const A = await join_(1, '탈퇴자'), B = await join_(2, '비'), C = await join_(3, '씨'), D = await join_(4, '디'), F = await join_(5, '친구'), X = await join_(6, '차단당함');
    await befriend(A, F); await befriend(A, B);
    const Y = await join_(8, '먼저요청'); await befriend(Y, A);                       // 상대가 먼저 요청한 친구도 친구 수에 셈
    const Z = await join_(7, '요청만');
    await call(A, 'public.send_friend_request($1)', [Z]);                            // 대기 중인 요청은 친구 수에 안 셈
    await grant(A, F); await grant(F, A);
    await call(A, 'public.block_user($1)', [X]);
    const g1 = await mkGroup(A, [B, C]), g2 = await mkGroup(A, []), g3 = await mkGroup(D, [A]);
    const g4 = await mkGroup(D, [], [A]);                                             // 초대만 받은 그룹 — 나갈 그룹 수에 안 셈
    const soloAp = await appt(A, g2.g, at('09:00'));                                  // 사라질 그룹의 약속 — 남을 공동 약속 수에 안 셈
    const futureAp = await appt(A, g1.g, at('10:00')), pastAp = await appt(A, g1.g, at('10:00', PAST)), otherAp = await appt(D, g3.g, at('11:00'));
    await part(A, futureAp); await part(B, futureAp); await part(A, pastAp); await part(A, otherAp);
    const personal = await appt(A, null, at('12:00'), '개인 일정');
    const ptP = await part(A, personal);
    await wakeAt(A, ptP, at('08:00'));
    await q(`insert into public.push_tokens (user_id, token) values ($1, 'ExponentPushToken[abcdefghijklmnopqrstuv]')`, [A]);
    const before = await summary(A);
    const r = await prepare(A);
    const afterPrepare = {
      joined: await n(`select 1 from public.group_members where user_id = $1`, [A]),
      personal: await n(`select 1 from public.appointments where appointment_id = $1`, [personal]),
      tokens: await n(`select 1 from public.push_tokens where user_id = $1`, [A]),
      futureCreator: await creatorOf(futureAp),
    };
    await remove(A);
    const gone = {
      profile: await exists('profiles', 'user_id', A),
      friends: await n(`select 1 from public.friends where requester_id = $1 or addressee_id = $1`, [A]),
      perms: await n(`select 1 from public.sharing_permissions where owner_id = $1 or grantee_id = $1`, [A]),
      blocks: await n(`select 1 from public.user_blocks where blocker_id = $1 or blocked_id = $1`, [A]),
      alarms: await n(`select 1 from public.alarms where user_id = $1`, [A]),
      parts: await n(`select 1 from public.appointment_participants where user_id = $1`, [A]),
    };
    const kept = {
      g1: await exists('groups', 'group_id', g1.g), g2: await exists('groups', 'group_id', g2.g), g3: await exists('groups', 'group_id', g3.g), g4: await exists('groups', 'group_id', g4.g),
      soloAp: await exists('appointments', 'appointment_id', soloAp),
      invitedLeft: await n(`select 1 from public.group_members where user_id = $1`, [A]),
      futureAp: await exists('appointments', 'appointment_id', futureAp), pastAp: await exists('appointments', 'appointment_id', pastAp), otherAp: await exists('appointments', 'appointment_id', otherAp),
      pastCreator: await creatorOf(pastAp), otherCreator: await creatorOf(otherAp),
      bFriendsWithA: await n(`select 1 from public.friends where requester_id = $1 or addressee_id = $1`, [B]),
    };
    return before.groups_leaving === 3 && before.groups_disappearing === 1 && before.group_appointments_staying === 2 && before.friends === 3
      && r.groups_left === 3 && r.groups_deleted === 1 && r.personal_deleted === 1 && r.group_appointments_kept === 2
      && afterPrepare.joined === 0 && afterPrepare.personal === 0 && afterPrepare.tokens === 0 && afterPrepare.futureCreator === null
      && gone.profile === false && gone.friends === 0 && gone.perms === 0 && gone.blocks === 0 && gone.alarms === 0 && gone.parts === 0
      && kept.g1 === true && kept.g2 === false && kept.g3 === true && kept.g4 === true && kept.soloAp === false && kept.invitedLeft === 0 && kept.futureAp && kept.pastAp && kept.otherAp
      && kept.pastCreator === null && kept.otherCreator === D && kept.bFriendsWithA === 0 ? true : { before, r, afterPrepare, gone, kept };
  });

  await check('12-03: 내가 만든 그룹에 다른 참여 멤버가 있으면 그룹은 그대로(코드 · 멤버 그대로, 그룹장 넘김 없음, 그룹장 칸만 비어 있음)', async () => {
    const A = await join_(10, '만든이'), B = await join_(11, '남는이');
    const { g, code } = await mkGroup(A, [B]);
    await prepare(A); await remove(A);
    const grp = (await q(`select owner_id, invite_code from public.groups where group_id = $1`, [g]))[0];
    const members = (await q(`select user_id from public.group_members where group_id = $1 and invite_status = 'JOINED'`, [g])).map((x) => x.user_id);
    return grp && grp.owner_id === null && grp.invite_code === code && members.length === 1 && members[0] === B ? true : { grp, members, code };
  });

  await check('12-04 · 12-05: 혼자 있던 그룹은 공동 약속 · 초대 · 코드까지 지워지고, 마지막 참여 멤버가 나가면 초대만 받은 사람이 남아 있어도 그룹 삭제 + 그 초대도 사라짐', async () => {
    const A = await join_(12, '혼자'), D = await join_(13, '초대만');
    const solo = await mkGroup(A, []);
    const soloAp = await appt(A, solo.g, at('10:00')); await part(A, soloAp);
    const withInvite = await mkGroup(A, [], [D]);
    const r = await prepare(A);
    await remove(A);
    return r.groups_left === 2 && r.groups_deleted === 2
      && !(await exists('groups', 'group_id', solo.g)) && !(await exists('appointments', 'appointment_id', soloAp)) && !(await exists('groups', 'group_id', withInvite.g))
      && (await n(`select 1 from public.group_members where group_id = $1`, [withInvite.g])) === 0 && (await exists('profiles', 'user_id', D)) ? true : { r };
  });

  await check('12-06: 개인 약속은 계정이 지워지기 전에 먼저 지워지고(L3 함정 5), 준비 없이 계정만 지워도(시드 · 도구) 삭제가 막히지 않게 같이 지워짐 — 개인 약속의 만든 사람 칸은 비울 수 없음(직접 비우기 · 만든 사람 없는 개인 약속 만들기 모두 거부)', async () => {
    const A = await join_(14, '개인약속'), B = await join_(29, '준비없이');
    const personal = await appt(A, null, at('09:00'), '개인');
    const rawPersonal = await appt(B, null, at('09:30'), '준비 없이 지울 개인');
    const pastPersonal = await appt(A, null, at('09:00', PAST), '지난 개인');          // 지난 개인 약속도 준비가 먼저 지움(L3 함정 5)
    const clear = await expectErr(() => q(`update public.appointments set creator_id = null where appointment_id = $1`, [personal]), /바꿀 수 없음/);
    const noOwner = await expectErr(() => q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values (null, null, '주인 없는 개인', $1::timestamptz, '학교')`, [at('08:00')]), /appointments_creator_or_group|check constraint/);
    const r = await prepare(A);
    const goneBeforeDelete = !(await exists('appointments', 'appointment_id', personal));
    await remove(A);
    await remove(B);                                                                            // 준비 없이 바로
    return clear === true && noOwner === true && r.personal_deleted === 2 && goneBeforeDelete && !(await exists('appointments', 'appointment_id', pastPersonal)) && !(await exists('profiles', 'user_id', A))
      && !(await exists('profiles', 'user_id', B)) && !(await exists('appointments', 'appointment_id', rawPersonal)) ? true : { clear, noOwner, r, goneBeforeDelete };
  });

  await check('12-09 · 12-10 · 12-11 · 12-12 · 12-22: 탈퇴하면 그룹 기상 목록 · 미확인 알림 후보에서 빠지고, 내가 바꿔 둔 친구 알람(MANUAL)은 친구 것이라 남고, 차단 행 · 푸시 토큰 · 푸시 기록이 정리됨', async () => {
    const A = await join_(15, '탈퇴'), B = await join_(16, '친구'), C = await join_(17, '그룹원');
    await befriend(A, B);
    const { g } = await mkGroup(C, [A, B]);
    await q(`update public.group_members set wake_share_opt_in = true where group_id = $1`, [g]);
    const ap = await appt(C, g, at('10:00')); const pa = await part(A, ap); await part(B, ap); await part(C, ap);
    const aAlarm = await wakeAt(A, pa, at('07:00'));
    await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at) values ($1, $2, 'TRIGGERED', $3::timestamptz), ($1, $2, 'MISSED', $4::timestamptz)`, [aAlarm, A, at('07:00'), at('07:30')]);
    const bPt = (await q(`select participant_id from public.appointment_participants where user_id = $1 and appointment_id = $2`, [B, ap]))[0].participant_id;
    const bAlarm = await wakeAt(B, bPt, at('07:30'));
    await q(`update public.alarms set time_source = 'MANUAL', original_scheduled_at = $2::timestamptz where alarm_id = $1`, [bAlarm, at('07:40')]);
    await q(`insert into public.push_sends (kind, sender_id, target_id, sent_at) values ('WAKE_PING', $1, $2, now())`, [A, B]);
    await q(`insert into public.push_tokens (user_id, token) values ($1, 'ExponentPushToken[zyxwvutsrqponmlkjihgfe]')`, [A]);
    const viewBefore = (await q(`select user_id from private.group_wake_rows($1, $2, $3::date, $4::timestamptz)`, [C, g, FUTURE, at('12:00')])).map((x) => x.user_id);
    await svc(); const nudgeBefore = await q(`select sleeper_id from public.claim_wake_nudges($1::timestamptz)`, [at('07:40')]); await su();   // 탈퇴 전에는 A가 미확인 알림의 대상
    await call(A, 'public.block_user($1)', [C]);
    await prepare(A); await remove(A);
    const viewAfter = (await q(`select user_id from private.group_wake_rows($1, $2, $3::date, $4::timestamptz)`, [C, g, FUTURE, at('12:00')])).map((x) => x.user_id);
    await svc(); const claimed = await q(`select * from public.claim_wake_nudges($1::timestamptz)`, [at('07:40')]); await su();
    const bAfter = (await q(`select scheduled_at, time_source, original_scheduled_at from public.alarms where alarm_id = $1`, [bAlarm]))[0];
    return viewBefore.includes(A) && !viewAfter.includes(A) && nudgeBefore.some((x) => x.sleeper_id === A) && claimed.every((x) => x.sleeper_id !== A && x.recipient_id !== A)
      && bAfter && bAfter.time_source === 'MANUAL' && new Date(bAfter.scheduled_at).toISOString() === new Date(at('07:30')).toISOString() && bAfter.original_scheduled_at !== null
      && (await n(`select 1 from public.user_blocks where blocker_id = $1 or blocked_id = $1`, [A])) === 0
      && (await n(`select 1 from public.push_tokens where user_id = $1`, [A])) === 0
      && (await n(`select 1 from public.push_sends where sender_id = $1 or target_id = $1`, [A])) === 0 ? true : { viewBefore, viewAfter, nudgeBefore, claimed, bAfter };
  });

  await check('12-18 · 12-24: 같은 그룹의 마지막 두 참여 멤버가 차례로 탈퇴해도(동시 탈퇴와 같은 결과) 그룹이 남지 않음 — 둘째가 나갈 때 마지막이 되어 삭제', async () => {
    const A = await join_(18, '첫째'), B = await join_(19, '둘째');
    const { g } = await mkGroup(A, [B]);
    const ap = await appt(A, g, at('10:00')); await part(A, ap); await part(B, ap);
    const ra = await prepare(A);
    const mid = await exists('groups', 'group_id', g);
    const rb = await prepare(B);
    await remove(A); await remove(B);
    return ra.groups_left === 1 && ra.groups_deleted === 0 && mid === true && rb.groups_left === 1 && rb.groups_deleted === 1
      && !(await exists('groups', 'group_id', g)) && !(await exists('appointments', 'appointment_id', ap)) ? true : { ra, rb, mid };
  });

  await check('12-27: 탈퇴한 사람의 아이디는 바로 풀려 다른 사람이 바로 가져갈 수 있음 (묶어 두는 표 없음)', async () => {
    const A = await join_(20, '떠남'), B = await join_(21, '가져감');
    const old = (await q(`select handle from public.profiles where user_id = $1`, [A]))[0].handle;
    await prepare(A); await remove(A);
    await clearLimits(B);
    const r = await call(B, 'public.change_my_handle($1)', [old]);
    return r.status === 'OK' && (await q(`select handle from public.profiles where user_id = $1`, [B]))[0].handle === old ? true : r;
  });

  await check('12-28 · 9-아: 만든 사람이 탈퇴한 공동 약속은 참여자 누구나 고치고(시각 변경 가능), 참여 안 한 그룹원은 못 고침', async () => {
    const A = await join_(22, '만든이'), B = await join_(23, '참여'), C = await join_(24, '참여안함');
    const { g } = await mkGroup(A, [B, C]);
    const ap = await appt(A, g, at('10:00')); await part(A, ap); await part(B, ap);
    await prepare(A); await remove(A);
    await as(B);
    const byParticipant = await q(`update public.appointments set appointment_at = $2::timestamptz where appointment_id = $1 returning appointment_id`, [ap, at('09:30')]);
    await su(); await as(C);
    const byOther = await q(`update public.appointments set title = '남의 약속' where appointment_id = $1 returning appointment_id`, [ap]);
    await su();
    return (await creatorOf(ap)) === null && byParticipant.length === 1 && byOther.length === 0 ? true : { byParticipant, byOther };
  });

  // ---- 탈퇴가 아니라 그룹만 나갈 때 (11/9 헤드 결정) ----------------------------------------------

  await check('나갈 때 만든 사람 칸 비우기(11/9 헤드 결정): 그룹을 나가면 그 사람이 만든 앞으로 공동 약속의 만든 사람 칸이 비어 남은 참여자가 고치고, 지난 약속은 기록으로 만든 사람이 남음 · 아직 참여 중인 사람이 직접 비우는 길은 막힘', async () => {
    const A = await join_(25, '나감'), B = await join_(26, '남음');
    const { g } = await mkGroup(A, [B]);
    const futureAp = await appt(A, g, at('10:00')), pastAp = await appt(A, g, at('10:00', PAST)), bAp = await appt(B, g, at('11:00'));
    await part(A, futureAp); await part(B, futureAp);
    const selfClear = await (async () => { await as(A); const r = await expectErr(() => q(`update public.appointments set creator_id = null where appointment_id = $1`, [futureAp]), /바꿀 수 없음|row-level security/); await su(); return r; })();
    const svcClear = await (async () => { await svc(); const r = await expectErr(() => q(`update public.appointments set creator_id = null where appointment_id = $1`, [futureAp]), /바꿀 수 없음/); await su(); return r; })();
    const swap = await expectErr(() => q(`update public.appointments set creator_id = $2 where appointment_id = $1`, [futureAp, B]), /바꿀 수 없음/);
    const rootGroupSwap = await expectErr(() => q(`update public.appointments set group_id = null where appointment_id = $1`, [futureAp]), /바꿀 수 없음/);
    await as(A);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, A]);
    await su();
    const after = { future: await creatorOf(futureAp), past: await creatorOf(pastAp), b: await creatorOf(bAp) };
    await as(B);
    const edited = await q(`update public.appointments set title = '남은 사람이 고침' where appointment_id = $1 returning appointment_id`, [futureAp]);
    await su();
    const afterLeaveSwap = await expectErr(() => q(`update public.appointments set creator_id = $2 where appointment_id = $1`, [pastAp, B]), /바꿀 수 없음/);   // 나간 뒤에도 비우기만 되고 다른 사람으로 바꾸기는 안 됨
    return selfClear === true && svcClear === true && swap === true && rootGroupSwap === true && afterLeaveSwap === true && after.future === null && after.past === A && after.b === B && edited.length === 1 ? true : { selfClear, svcClear, swap, rootGroupSwap, afterLeaveSwap, after, edited };
  });

  await check('나갈 때(여러 그룹 · 경계): 한 그룹만 나가면 그 그룹의 앞으로 약속만 만든 사람이 비고 다른 그룹 약속은 그대로 — 나가기(LEFT)와 내보내기(DELETE) 모두, 기준은 그 사람 시간대 오늘 0시(1분 뒤 약속은 비고 1분 전은 남음)', async () => {
    const A = await join_(30, '나감'), B = await join_(31, '남음'), K = await join_(32, '내보내짐'), N = await join_(33, '뉴질랜드');
    await q(`update public.profiles set timezone = 'Pacific/Auckland' where user_id = $1`, [N]);
    const startOf = async (u) => new Date((await q(`select private.day_start($1) as t`, [u]))[0].t).getTime();
    const plus = (t, min) => new Date(t + min * 60_000).toISOString();
    const g1 = await mkGroup(A, [B, K, N]), g2 = await mkGroup(A, [B, K, N]);
    const startA = await startOf(A), startN = await startOf(N);
    const a1 = await appt(A, g1.g, at('10:00')), a2 = await appt(A, g2.g, at('10:00'));
    const aAfter = await appt(A, g1.g, plus(startA, 1)), aBefore = await appt(A, g1.g, plus(startA, -1)), aExact = await appt(A, g1.g, plus(startA, 0));   // 오늘 0시 경계 (정확히 0시는 '앞으로'에 들어감)
    const k1 = await appt(K, g1.g, at('11:00')), k2 = await appt(K, g2.g, at('11:00'));
    const nAfter = await appt(N, g1.g, plus(startN, 1)), nBefore = await appt(N, g1.g, plus(startN, -1));        // 다른 시간대 사람의 경계
    await as(A);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g1.g, A]);
    await su();
    await as(B);
    const kicked = await q(`delete from public.group_members where group_id = $1 and user_id = $2 returning 1`, [g1.g, K]);
    await su();
    await as(N);
    await q(`delete from public.group_members where group_id = $1 and user_id = $2`, [g1.g, N]);
    await su();
    const c = {
      a1: await creatorOf(a1), a2: await creatorOf(a2), aAfter: await creatorOf(aAfter), aBefore: await creatorOf(aBefore), aExact: await creatorOf(aExact),
      k1: await creatorOf(k1), k2: await creatorOf(k2), nAfter: await creatorOf(nAfter), nBefore: await creatorOf(nBefore),
    };
    return kicked.length === 1 && c.a1 === null && c.aAfter === null && c.aExact === null && c.aBefore === A && c.a2 === A
      && c.k1 === null && c.k2 === K && c.nAfter === null && c.nBefore === N ? true : { c, kicked: kicked.length, startA, startN };
  });

  await check('준비 없이 계정만 지워도(대시보드 · 도구) 참여 중인 공동 약속 만든 사람의 계정이 지워져 — 외래키 처리 순서가 뒤집혀도(약속 칸이 먼저 비워져도) 막히지 않고 만든 사람 칸만 비움', async () => {
    // 같은 사건의 외래키 처리는 만들어진 순서(oid)로 돎 — 멤버 외래키를 약속 외래키보다 나중에 다시 만들어 '약속 칸이 먼저, 멤버가 나중'을 흉내 냄
    await q(`alter table public.group_members drop constraint group_members_user_id_fkey`);
    await q(`alter table public.group_members add constraint group_members_user_id_fkey foreign key (user_id) references public.profiles (user_id) on delete cascade`);
    const A = await join_(34, '만든이'), B = await join_(35, '남음');
    const { g } = await mkGroup(A, [B]);
    const ap = await appt(A, g, at('10:00')); await part(B, ap);
    await remove(A);                                                                           // prepare 없이
    return (await creatorOf(ap)) === null && (await exists('appointments', 'appointment_id', ap)) && !(await exists('profiles', 'user_id', A))
      && (await n(`select 1 from public.group_members where group_id = $1 and user_id = $2`, [g, B])) === 1 ? true : { creator: await creatorOf(ap) };
  });

  await check('12-19: 탈퇴 준비 뒤 상대가 그 사람에게 권한을 줘도 계정이 지워지면 권한 행이 남지 않고, 지워진 사람에게는 새로 줄 수 없음', async () => {
    const A = await join_(36, '탈퇴'), B = await join_(37, '권한줌');
    await befriend(A, B);
    const f = await friendId(A, B);
    await prepare(A);
    await as(B);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, 'FRIEND', $3, true)`, [B, A, f]);   // 탈퇴 직전에 줌
    await su();
    await remove(A);
    const left = await n(`select 1 from public.sharing_permissions where owner_id = $1 or grantee_id = $1`, [A]);
    await as(B);
    const after = await expectErr(() => q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, 'FRIEND', $3, true)`, [B, A, f]), /.*/);
    await su();
    return left === 0 && after === true ? true : { left, after };
  });

  // ---- 함수 약속 · 권한 ------------------------------------------------------------------------

  await check('12장 함수: prepare_account_delete는 몇 번 불러도 같고(둘째는 모두 0) 없는 사람이어도 오류 없이 0, 요약은 본인 것만 · 아무것도 없으면 0', async () => {
    const A = await join_(27, '없음');
    const empty = await summary(A);
    const r1 = await prepare(A), r2 = await prepare(A), ghost = await prepare(NOBODY), nobody = await prepare(null);
    const zero = { groups_left: 0, groups_deleted: 0, personal_deleted: 0, group_appointments_kept: 0 };
    return JSON.stringify(empty) === JSON.stringify({ groups_leaving: 0, groups_disappearing: 0, group_appointments_staying: 0, friends: 0 })
      && JSON.stringify(r1) === JSON.stringify(zero) && JSON.stringify(r2) === JSON.stringify(zero) && JSON.stringify(ghost) === JSON.stringify(zero) && JSON.stringify(nobody) === JSON.stringify(zero) ? true : { empty, r1, r2, ghost, nobody };
  });

  await check('12장 실행 권한: prepare_account_delete는 서버 역할만(앱 · 익명은 못 부름), my_account_delete_summary는 로그인한 사람만, 앱이 creator_id를 직접 비우는 길은 없음', async () => {
    const A = await join_(28, '권한');
    await as(A);
    const app = await expectErr(() => q(`select public.prepare_account_delete($1)`, [A]), /permission denied/);
    const own = await q(`select * from public.my_account_delete_summary()`);
    await as(null, 'anon');
    const anon = [await expectErr(() => q(`select public.prepare_account_delete($1)`, [A]), /permission denied/), await expectErr(() => q(`select * from public.my_account_delete_summary()`), /permission denied/)];
    await su();
    return app === true && own.length === 1 && anon.every((x) => x === true) ? true : { app, own, anon };
  });
}
