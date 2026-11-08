// 친구 3장 — 친구 관계 (친구_시험케이스.md 3장 DB 층, 11/8 확정)
//   항목 이름 앞 번호 = 시험케이스 번호
//   함수 층(3-01 · 3-02 · 3-27 · 3-29 · 3-34의 FRIEND_REQUEST · FRIEND_ACCEPTED 푸시)은 푸시 종류를 notify에 넣는 11장에서 — 여기선 DB가 돌려주는 상태 값까지
//   사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch03({ q, as, su, check, expectErr }) {
  const id = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  const join_ = async (n, nickname, { onboarded = true } = {}) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`,
      [id(n), `f3-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    if (onboarded) await q(`update public.profiles set onboarded_at = now() where user_id = $1`, [id(n)]);
    return id(n);
  };
  const call = async (uid, fn, arg) => { await as(uid); const [r] = await q(`select public.${fn}($1) as r`, [arg]); await su(); return r.r; };
  const request = (a, b) => call(a, 'send_friend_request', b);
  const accept = (b, a) => call(b, 'accept_friend_request', a);
  const decline = (b, a) => call(b, 'decline_friend_request', a);
  const cancel = (a, b) => call(a, 'cancel_friend_request', b);
  const remove = (a, b) => call(a, 'remove_friend', b);
  const rowOf = async (a, b) => (await q(`select requester_id, addressee_id, status::text, accepted_at from public.friends
                                          where least(requester_id, addressee_id) = least($1::uuid, $2::uuid)
                                            and greatest(requester_id, addressee_id) = greatest($1::uuid, $2::uuid)`, [a, b]))[0] ?? null;
  const clearLimits = (uid) => q(`delete from public.rate_limit_events where user_id = $1`, [uid]);

  const A = await join_(1, '에이');
  const B = await join_(2, '비');
  const C = await join_(3, '씨');

  await check('3-01 · 3-04 · 3-07 · 3-30(DB 몫): 요청하면 대기 행 1개(REQUESTED), 또 요청하면 ALREADY_REQUESTED(행 그대로), A가 취소하면 행이 사라짐(CANCELED)', async () => {
    const r1 = await request(A, B);
    const r2 = await request(A, B);
    const row = await rowOf(A, B);
    const [{ n }] = await q(`select count(*)::int as n from public.friends where requester_id = $1 and addressee_id = $2`, [A, B]);
    const c = await cancel(A, B);
    const again = await cancel(A, B);
    const gone = await rowOf(A, B);
    await clearLimits(A);
    return r1.status === 'REQUESTED' && r2.status === 'ALREADY_REQUESTED' && row.status === 'PENDING' && row.requester_id === A && n === 1
      && c.status === 'CANCELED' && again.status === 'GONE' && gone === null ? true : { r1, r2, row, n, c, again, gone };
  });

  await check('3-02 · 3-26 · 3-29(DB 몫): 받은 사람이 수락하면 친구(ACCEPTED), 수락 시각은 서버가 그 순간 넣음, 두 번 누르면 ALREADY_FRIEND', async () => {
    await request(A, B);
    const a1 = await accept(B, A);
    const a2 = await accept(B, A);
    const [row] = await q(`select status::text, abs(extract(epoch from (accepted_at - now()))) < 5 as fresh from public.friends where requester_id = $1 and addressee_id = $2`, [A, B]);
    await clearLimits(A);
    return a1.status === 'ACCEPTED' && a2.status === 'ALREADY_FRIEND' && row.status === 'ACCEPTED' && row.fresh === true ? true : { a1, a2, row };
  });

  await check('3-06: 이미 친구에게 또 요청하면 ALREADY_FRIEND, 행 그대로', async () => {
    const r = await request(A, B);
    const r2 = await request(B, A);
    const row = await rowOf(A, B);
    return r.status === 'ALREADY_FRIEND' && r2.status === 'ALREADY_FRIEND' && row.status === 'ACCEPTED' ? true : { r, r2, row };
  });

  await check('3-14 · 3-41: 친구 + 서로 공유를 켬 → 한쪽이 끊으면(REMOVED) 행이 사라지고 양쪽이 준 친구 출처 권한 행이 모두 지워짐', async () => {
    const [{ friend_id: f }] = await q(`select friend_id from public.friends where requester_id = $1 and addressee_id = $2`, [A, B]);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm)
             values ($1, $2, 'FRIEND', $3, true, true), ($2, $1, 'FRIEND', $3, true, false)`, [A, B, f]);
    const r = await remove(B, A);
    const again = await remove(B, A);
    const [{ n }] = await q(`select count(*)::int as n from public.sharing_permissions where source_type = 'FRIEND' and source_id = $1`, [f]);
    return r.status === 'REMOVED' && again.status === 'GONE' && (await rowOf(A, B)) === null && n === 0 ? true : { r, again, n };
  });

  await check('3-16 · 3-42: 끊은 뒤 다시 요청하면 대기부터, 다시 친구가 돼도 옛 권한은 없음', async () => {
    const r = await request(A, B);
    const pending = (await rowOf(A, B)).status;
    await accept(B, A);
    const [{ n }] = await q(`select count(*)::int as n from public.sharing_permissions where $1 in (owner_id, grantee_id) and source_type = 'FRIEND'`, [A]);
    await clearLimits(A);
    return r.status === 'REQUESTED' && pending === 'PENDING' && n === 0 ? true : { r, pending, n };
  });

  await check('3-03 · 3-09 · 3-23: 거절하면 행이 사라지고(DECLINED, 알림 없음), A가 다시 요청하면 새 대기 행 — 거절 3번 뒤 4번째도 됨', async () => {
    const D = await join_(4, '디');
    const out = [];
    for (let i = 0; i < 3; i++) {
      out.push((await request(A, D)).status);
      out.push((await decline(D, A)).status);
      out.push((await rowOf(A, D)) === null);
    }
    const fourth = await request(A, D);
    const row = await rowOf(A, D);
    const lateDecline = await decline(C, A);   // 받은 요청이 없는데 거절
    await clearLimits(A);
    return JSON.stringify(out) === JSON.stringify(['REQUESTED', 'DECLINED', true, 'REQUESTED', 'DECLINED', true, 'REQUESTED', 'DECLINED', true])
      && fourth.status === 'REQUESTED' && row.status === 'PENDING' && lateDecline.status === 'GONE' ? true : { out, fourth, row, lateDecline };
  });

  await check('3-05 · 3-27(DB 몫): 서로 거의 동시에 요청 — 나중 요청이 자동 수락(ACCEPTED), 행 1개 · 요청자는 먼저 보낸 쪽', async () => {
    const E = await join_(5, '이');
    const F = await join_(6, '에프');
    const first = await request(E, F);
    const second = await request(F, E);
    const rows = await q(`select requester_id, status::text, accepted_at is not null as acc from public.friends where $1 in (requester_id, addressee_id)`, [E]);
    await clearLimits(E);
    await clearLimits(F);
    return first.status === 'REQUESTED' && second.status === 'ACCEPTED' && rows.length === 1 && rows[0].requester_id === E
      && rows[0].status === 'ACCEPTED' && rows[0].acc === true ? true : { first, second, rows };
  });

  await check('3-08 · 2-38(요청 부분): 자기에게 요청은 SELF, 없는 사람 · 온보딩 전 · 차단 쌍에게는 NOT_FOUND(같은 응답) — 기록 안 셈', async () => {
    const NO = await join_(7, '온보딩전', { onboarded: false });
    const BL = await join_(8, '차단');
    await q(`insert into public.user_blocks (blocker_id, blocked_id) values ($1, $2)`, [A, BL]);   // A가 BL을 차단 (4장)
    const self = await request(A, A);
    const shapes = [await request(A, '30000000-0000-4000-8000-999999999999'), await request(A, NO), await request(A, BL), await request(BL, A)];
    const [{ n }] = await q(`select count(*)::int as n from public.rate_limit_events where user_id = $1 and action = 'FRIEND_REQUEST'`, [A]);
    return self.status === 'SELF' && shapes.every((x) => JSON.stringify(x) === JSON.stringify({ status: 'NOT_FOUND' })) && n === 0 ? true : { self, shapes, n };
  });

  await check('3-10: 1분 안에 10번 요청 → 11번째는 LIMIT + 남은 초 · 행 안 생김, 1분 지나면 다시 됨', async () => {
    const S = await join_(10, '보내는사람');
    const T = [];
    for (let i = 0; i < 11; i++) T.push(await join_(11 + i, `받는${i}`));
    const ten = [];
    for (let i = 0; i < 10; i++) ten.push((await request(S, T[i])).status);
    const eleventh = await request(S, T[10]);
    const none = await rowOf(S, T[10]);
    await q(`update public.rate_limit_events set created_at = created_at - interval '61 seconds' where user_id = $1`, [S]);
    const later = await request(S, T[10]);
    return ten.every((x) => x === 'REQUESTED') && eleventh.status === 'LIMIT' && eleventh.retry_after_seconds >= 1 && eleventh.retry_after_seconds <= 60
      && none === null && later.status === 'REQUESTED' ? true : { ten, eleventh, none, later };
  });

  await check('3-11 · 3-35: 하루 50번 — 51번째는 LIMIT(취소해도 안 줄어듦), 하루 경계는 보내는 사람 프로필 시간대 0시(어제 것은 안 셈)', async () => {
    const S = await join_(30, '하루상한');
    const R = [await join_(31, '하나'), await join_(32, '둘'), await join_(33, '셋')];
    // 시험을 돌리는 시각과 상관없이 보내는 사람 시간대에서 지금이 낮 12시쯤이 되게 고정 시간대(Etc/GMT±N)를 고름 — 자정 근처에 돌아도 흔들리지 않게
    const [{ tz }] = await q(`select 'Etc/GMT' || case when h >= 12 then '+' || (h - 12) else '-' || (12 - h) end as tz
                              from (select extract(hour from now() at time zone 'UTC')::int as h) x`);
    await q(`update public.profiles set timezone = $2 where user_id = $1`, [S, tz]);
    const day0 = `((now() at time zone $2)::date::timestamp at time zone $2)`;
    // 어제 50번(그 시간대 0시 1분 전) — 오늘 셈에 안 들어감
    await q(`insert into public.rate_limit_events (user_id, action, created_at) select $1, 'FRIEND_REQUEST', ${day0} - interval '1 minute' from generate_series(1, 50)`, [S, tz]);
    // 오늘 49번(0시 1시간 뒤 = 지금보다 한참 전이라 1분 제한에는 안 걸림)
    await q(`insert into public.rate_limit_events (user_id, action, created_at) select $1, 'FRIEND_REQUEST', ${day0} + interval '1 hour' from generate_series(1, 49)`, [S, tz]);
    const fiftieth = await request(S, R[0]);
    const c = await cancel(S, R[0]);
    const fiftyFirst = await request(S, R[0]);
    const other = await request(S, R[1]);
    return fiftieth.status === 'REQUESTED' && c.status === 'CANCELED' && fiftyFirst.status === 'LIMIT' && other.status === 'LIMIT'
      && fiftyFirst.retry_after_seconds > 60 ? true : { fiftieth, c, fiftyFirst, other };
  });

  await check('3-12: 친구 100명이면 요청도 FRIEND_LIMIT, 상대가 100명인 사람의 요청을 수락해도 FRIEND_LIMIT(행은 대기 그대로)', async () => {
    const FULL = await join_(40, '친구많음');
    const P = await join_(41, '대기중');
    const Q = await join_(42, '새사람');
    await q(`insert into public.friends (requester_id, addressee_id, status) values ($1, $2, 'PENDING')`, [FULL, P]);
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email) select gen_random_uuid(), 'f3-full-' || g || '@example.com' from generate_series(1, 100) g`);
    await su();
    await q(`insert into public.friends (requester_id, addressee_id, status, accepted_at)
             select $1, u.id, 'ACCEPTED', now() from auth.users u where u.email like 'f3-full-%'`, [FULL]);
    const r = await request(FULL, Q);
    const a = await accept(P, FULL);
    const row = await rowOf(FULL, P);
    await q(`delete from public.friends where requester_id = $1 and addressee_id in (select id from auth.users where email like 'f3-full-%' limit 1)`, [FULL]);
    const a2 = await accept(P, FULL);   // 99명이 되면 수락됨
    await q(`delete from auth.users where email like 'f3-full-%'`);
    return r.status === 'FRIEND_LIMIT' && a.status === 'FRIEND_LIMIT' && row.status === 'PENDING' && a2.status === 'ACCEPTED' ? true : { r, a, row, a2 };
  });

  await check('3-13: 받은 요청이 31일 지나면 배치가 지우고, 29일 지난 것은 남김 (5분 예약 friend-requests-expire)', async () => {
    const O = await join_(50, '오래된요청');
    const N = await join_(51, '덜오래된');
    await q(`insert into public.friends (requester_id, addressee_id, status, requested_at) values ($1, $3, 'PENDING', now() - interval '31 days'),
                                                                                         ($2, $3, 'PENDING', now() - interval '29 days')`, [O, N, C]);
    await q(`select private.expire_friend_requests()`);
    const old = await rowOf(O, C);
    const fresh = await rowOf(N, C);
    const [job] = await q(`select schedule, command from cron.job where jobname = 'friend-requests-expire'`);
    return old === null && fresh?.status === 'PENDING' && job?.schedule === '*/5 * * * *' && job.command === 'select private.expire_friend_requests()'
      ? true : { old, fresh, job };
  });

  await check('3-15: 친구 + 같은 그룹 — 끊으면 친구 출처 권한만 지워지고 그룹 출처 권한 · 그룹 기상 공유 동의는 그대로', async () => {
    const G1 = await join_(60, '그룹친구1');
    const G2 = await join_(61, '그룹친구2');
    await q(`insert into public.friends (requester_id, addressee_id, status, accepted_at) values ($1, $2, 'ACCEPTED', now())`, [G1, G2]);
    const [{ friend_id: f }] = await q(`select friend_id from public.friends where requester_id = $1 and addressee_id = $2`, [G1, G2]);
    const [{ group_id: g }] = await q(`insert into public.groups (group_name, owner_id) values ('같이', $1) returning group_id`, [G1]);
    await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at, wake_share_opt_in) values ($1, $2, 'JOINED', now(), true)`, [g, G2]);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm)
             values ($1, $2, 'FRIEND', $3, true), ($1, $2, 'GROUP', $4, true)`, [G2, G1, f, g]);
    const r = await remove(G1, G2);
    const left = await q(`select source_type::text from public.sharing_permissions where owner_id = $1 and grantee_id = $2`, [G2, G1]);
    const [m] = await q(`select invite_status::text, wake_share_opt_in from public.group_members where group_id = $1 and user_id = $2`, [g, G2]);
    return r.status === 'REMOVED' && left.length === 1 && left[0].source_type === 'GROUP' && m.invite_status === 'JOINED' && m.wake_share_opt_in === true
      ? true : { r, left, m };
  });

  await check('3-17 · 3-18 · 3-33: 남(C)은 A-B 행을 못 읽고 · 고치지도 · 지우지도 못함(0행), 받은 사람도 남의 요청(A→C) 행은 못 건드림', async () => {
    await request(A, C);
    await as(C);
    const [{ friend_id: fAB }] = await (async () => { await su(); return q(`select friend_id from public.friends where requester_id = $1 and addressee_id = $2`, [A, B]); })();
    await as(C);
    const read = await q(`select 1 from public.friends where friend_id = $1`, [fAB]);
    const upd = await q(`update public.friends set requested_at = now() where friend_id = $1 returning 1`, [fAB]);
    const del = await q(`delete from public.friends where friend_id = $1 returning 1`, [fAB]);
    await as(B);
    const other = await q(`update public.friends set status = 'ACCEPTED' where requester_id = $1 and addressee_id = $2 returning 1`, [A, C]);
    const otherDel = await q(`delete from public.friends where requester_id = $1 and addressee_id = $2 returning 1`, [A, C]);
    await su();
    const still = await rowOf(A, B);
    await cancel(A, C);
    await clearLimits(A);
    return read.length === 0 && upd.length === 0 && del.length === 0 && other.length === 0 && otherDel.length === 0 && still?.status === 'ACCEPTED'
      ? true : { read, upd, del, other, otherDel, still };
  });

  await check('3-24 · 3-25 · 3-26: 직접 update로도 대기 → 친구만 됨 — PENDING · BLOCKED로 바꾸기 · 수락 되돌리기는 막힘, 직접 수락해도 accepted_at은 서버 시각', async () => {
    const H = await join_(70, '직접');
    await request(H, B);
    await as(B);
    const toBlocked = await expectErr(() => q(`update public.friends set status = 'BLOCKED' where requester_id = $1 and addressee_id = $2`, [H, B]), /대기 → 친구/);
    const [acc] = await q(`update public.friends set status = 'ACCEPTED', accepted_at = '2025-01-01 00:00+09' where requester_id = $1 and addressee_id = $2
                           returning abs(extract(epoch from (accepted_at - now()))) < 5 as fresh`, [H, B]);
    const back = await expectErr(() => q(`update public.friends set status = 'PENDING' where requester_id = $1 and addressee_id = $2`, [H, B]), /대기 → 친구/);
    const clock = await expectErr(() => q(`update public.friends set accepted_at = now() - interval '1 year' where requester_id = $1 and addressee_id = $2`, [H, B]), /수락 시각/);
    await su();
    await clearLimits(H);
    return toBlocked === true && acc?.fresh === true && back === true && clock === true ? true : { toBlocked, acc, back, clock };
  });

  await check('3-28: 수락하는 순간 A가 취소했으면 GONE(행 없음) — 받은 요청에서도 사라짐', async () => {
    const I = await join_(80, '취소한사람');
    await request(I, B);
    await cancel(I, B);
    const a = await accept(B, I);
    await clearLimits(I);
    return a.status === 'GONE' && (await rowOf(I, B)) === null ? true : a;
  });

  await check('3-31 · 3-32: 직접 insert로 남을 요청자로 넣거나(requester_id = C) ACCEPTED로 넣으면 거절', async () => {
    const J = await join_(81, '위조');
    await as(J);
    const spoof = await expectErr(() => q(`insert into public.friends (requester_id, addressee_id) values ($1, $2)`, [C, B]), /row-level security/);
    const accepted = await expectErr(() => q(`insert into public.friends (requester_id, addressee_id, status) values ($1, $2, 'ACCEPTED')`, [J, B]), /row-level security/);
    await su();
    return spoof === true && accepted === true ? true : { spoof, accepted };
  });

  await check('3-19 · 3-38 · 3-39(DB 몫): 친구 · 대기 상대가 탈퇴하면 행이 사라져 목록 · 보낸 요청 · 친구 수에서 빠짐', async () => {
    const K = await join_(82, '남는사람');
    const L1 = await join_(83, '탈퇴친구');
    const L2 = await join_(84, '탈퇴대기');
    await q(`insert into public.friends (requester_id, addressee_id, status, accepted_at) values ($1, $2, 'ACCEPTED', now())`, [K, L1]);
    await q(`insert into public.friends (requester_id, addressee_id, status) values ($1, $2, 'PENDING')`, [K, L2]);
    await q(`delete from auth.users where id = any($1::uuid[])`, [[L1, L2]]);
    await as(K);
    const rows = await q(`select 1 from public.friends`);
    await su();
    return rows.length === 0 ? true : rows;
  });

  await check('3-43 · 3-44(DB 몫): B가 바꿔 둔 A 알람은 끊은 뒤에도 바뀐 대로 남고, 끊은 뒤 B가 A 알람을 고치려 하면 0행', async () => {
    const M = await join_(85, '알람주인');
    const NB = await join_(86, '바꾼친구');
    await q(`insert into public.friends (requester_id, addressee_id, status, accepted_at) values ($1, $2, 'ACCEPTED', now())`, [M, NB]);
    const [{ friend_id: f }] = await q(`select friend_id from public.friends where requester_id = $1 and addressee_id = $2`, [M, NB]);
    const [{ appointment_id: ap }] = await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, '수업', now() + interval '1 day', '학교') returning appointment_id`, [M]);
    const [{ participant_id: p }] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap, M]);
    const [{ alarm_id: al }] = await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', now() + interval '20 hours') returning alarm_id`, [p, M]);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm) values ($1, $2, 'FRIEND', $3, true, true)`, [M, NB, f]);
    await as(NB);
    const changed = await q(`update public.alarms set scheduled_at = scheduled_at + interval '5 minutes' where alarm_id = $1 returning scheduled_at`, [al]);
    await su();
    await remove(M, NB);
    const [kept] = await q(`select scheduled_at from public.alarms where alarm_id = $1`, [al]);
    await as(NB);
    const after = await q(`update public.alarms set scheduled_at = scheduled_at + interval '5 minutes' where alarm_id = $1 returning 1`, [al]);
    await su();
    return changed.length === 1 && new Date(kept.scheduled_at).getTime() === new Date(changed[0].scheduled_at).getTime() && after.length === 0
      ? true : { changed, kept, after };
  });

  await check('3장 함수: 로그인 정보가 없으면 42501, anon은 실행 권한 없음, 배치 정리 함수는 앱이 못 부름', async () => {
    await as(null);
    const errs = [];
    for (const fn of ['send_friend_request', 'accept_friend_request', 'decline_friend_request', 'cancel_friend_request', 'remove_friend']) {
      errs.push(await expectErr(() => q(`select public.${fn}($1)`, [B]), /로그인이 필요함/));
    }
    await as(null, 'anon');
    const anon = await expectErr(() => q(`select public.send_friend_request($1)`, [B]), /permission denied/);
    await as(A);
    const batch = await expectErr(() => q(`select private.expire_friend_requests()`), /permission denied/);
    await su();
    return errs.every((x) => x === true) && anon === true && batch === true ? true : { errs, anon, batch };
  });
}
