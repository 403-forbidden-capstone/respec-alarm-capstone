// 논리설계 16장 대본 37단계. 단계 번호 · 누가 · 장은 문서 그대로, 아래 본문은 그 단계가 DB에 일으키는 일을 supabase-js로 함
//   사람 대본의 화면 확인(글자 · 버튼 모양)은 여기서 안 봄 — 화면에 보일 데이터가 맞는지만 봄
//   아직 없는 기능은 skip(), 있는데 대본대로 안 되면 must() / ok()가 FAIL
//   함수 입력 모양을 가정한 곳(PGRST202 = 그런 입력의 함수 없음)은 SKIP으로 떨어지고, S1이 만든 모양에 맞춰 고침
import { randomUUID } from 'node:crypto';

import { must, ok, skip } from './harness.mjs';
import { E2E_PREFIX } from './snapshot.mjs';
import { rpcOf } from './rpc-map.mjs';

const RUN_DAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // 자정을 넘겨 돌려도 한 실행 안에서는 같은 날
const todayKst = () => RUN_DAY;
const at = (hhmm) => `${todayKst()}T${hhmm}:00+09:00`;
const inFuture = (ms) => new Date(Date.now() + ms).toISOString();
const rand = () => randomUUID().slice(0, 6);

// 함수를 부름. "그런 입력의 함수 없음"이면 SKIP (S1이 만든 모양과 다르다는 뜻)
async function callRpc(client, fn, args) {
  const res = await client.rpc(fn, args);
  if (res.error?.code === 'PGRST202') skip(`${fn} 입력 모양이 가정과 달라 steps.mjs를 맞춰야 함`);
  return res;
}

// 아이디 검색 → { status, profile, relation }. 2장 search_by_handle이 없으면 옛 find_profile 한 행을 같은 모양으로 맞춤
async function searchHandle(ctx, client, query) {
  const fn = rpcOf(ctx.caps, 'search_handle');
  if (fn) {
    const r = ok(await callRpc(client, fn, { p_query: query }), '아이디 검색');
    if (r.status === 'LIMIT') skip(`검색이 1분 10회 제한에 걸림 (${r.retry_after_seconds}초 뒤 다시)`);
    return r;
  }
  const rows = ok(await callRpc(client, ctx.fn.find_profile, { p_handle: query }), '아이디 검색');
  return rows.length ? { status: 'FOUND', profile: rows[0], relation: null } : { status: 'NOT_FOUND', profile: null, relation: null };
}

// 친구 요청 · 수락 (3장). 함수가 DB에 없으면 옛 길(표 직접 쓰기)로 같은 일을 함
async function friendRow(ctx, x, y) {
  const rows = ok(
    await ctx.admin.from('friends').select('friend_id, requester_id, addressee_id, status, accepted_at').in('requester_id', [x, y]).in('addressee_id', [x, y]),
    '친구 행 읽기',
  );
  return rows[0] ?? null;
}
async function sendRequest(ctx, client, from, to) {
  const fn = rpcOf(ctx.caps, 'friend_request');
  if (!fn) {
    ok(await client.from('friends').insert({ requester_id: from, addressee_id: to }), '친구 요청(옛 길)');
    return 'REQUESTED';
  }
  const r = ok(await callRpc(client, fn, { p_target_id: to }), '친구 요청');
  if (r.status === 'LIMIT') skip(`친구 요청이 1분 10회 제한에 걸림 (${r.retry_after_seconds}초 뒤 다시)`);
  return r.status;
}
async function acceptRequest(ctx, client, requesterId, addresseeId) {
  const fn = rpcOf(ctx.caps, 'friend_accept');
  if (!fn) {
    const row = await friendRow(ctx, requesterId, addresseeId);
    ok(await client.from('friends').update({ status: 'ACCEPTED', accepted_at: new Date().toISOString() }).eq('friend_id', row.friend_id), '수락(옛 길)');
    return 'ACCEPTED';
  }
  return ok(await callRpc(client, fn, { p_requester_id: requesterId }), '수락').status;
}

const pushNote = (ctx, who) => ctx.note(`${who}에게 푸시 도착 확인 생략 (보낼 수 있는지 · 받는 사람은 위에서 확인, 도착은 사람 대본)`);

// 11장: 서버 함수(notify)가 푸시를 보내기 전에 부르는 판정 — can_send_push(두 사람 사이), plan_group_push(그룹 받는 사람). service_role 전용이라 admin으로 부름
async function canPush(ctx, sender, target, kind, what) {
  if (!ctx.caps.hasRpc('can_send_push')) return ctx.note('푸시 판정 함수(can_send_push)가 DB에 없어 판정 확인 생략');
  const r = ok(await ctx.admin.rpc('can_send_push', { p_sender_id: sender, p_target_id: target, p_kind: kind }), `${what} 푸시 판정`);
  must(r === true, `${what} 푸시를 보낼 수 없다고 판정됨 (${kind})`);
}
async function groupPush(ctx, sender, kind, appt) {
  if (!ctx.caps.hasRpc('plan_group_push')) {
    ctx.note('그룹 푸시 판정 함수(plan_group_push)가 DB에 없어 받는 사람 확인 생략');
    return null;
  }
  const r = ok(await ctx.admin.rpc('plan_group_push', { p_sender_id: sender, p_group_id: ctx.s.group, p_kind: kind, p_appointment_id: appt ?? null }), `그룹 푸시 판정 ${kind}`);
  must(r.status === 'OK', `그룹 푸시 판정이 OK가 아님: ${kind} ${r.status}`);
  must(!r.recipients.includes(sender), '그룹 푸시 받는 사람에 보낸 본인이 들어 있음');
  return r.recipients;
}

// ---- 가입 (1 · 2) — OAuth는 supabase-js로 못 하므로 이메일 임시 계정으로 "가입 직후 상태"만 봄 ----
async function signupCheck(ctx, label) {
  const email = `e2e-new-${label}-${rand()}@example.com`;
  const created = await ctx.admin.auth.admin.createUser({ email, password: ctx.password, email_confirm: true });
  must(!created.error, `임시 계정 만들기: ${created.error?.message}`);
  const id = created.data.user.id;
  try {
    const cols = ['handle', ...(ctx.caps.hasCol('profiles', 'handle_changed_at') ? ['handle_changed_at'] : [])];
    const p = ok(await ctx.admin.from('profiles').select(cols.join(',')).eq('user_id', id).single(), '프로필 읽기');
    if (!p.handle) skip('가입 때 자동 아이디(respec_xxxx)가 안 생김 (2장 미구현)');
    must(/^respec_[a-z0-9]{4,}$/.test(p.handle), `자동 아이디 모양이 다름: ${p.handle}`);
    must(p.handle_changed_at == null, '가입 직후인데 직접 바꾼 시각이 있음 (자동 아이디는 "바꿔 보세요" 상태여야 함)');
    // 온보딩 전(onboarded_at 비어 있음)이라 남이 검색해도 안 나와야 함 — 시험 계정을 service_role로 온보딩 끝낸 상태로 만든 뒤에는 나옴
    if (rpcOf(ctx.caps, 'search_handle')) {
      const before = await searchHandle(ctx, ctx.c, p.handle);
      must(before.status === 'NOT_FOUND', `온보딩 전 계정이 검색됨: ${before.status}`);
      ok(await ctx.admin.from('profiles').update({ onboarded_at: new Date().toISOString() }).eq('user_id', id), '온보딩 끝냄(service_role)');
      const after = await searchHandle(ctx, ctx.c, p.handle);
      must(after.status === 'FOUND' && after.profile.user_id === id, `온보딩 뒤에도 검색 안 됨: ${after.status}`);
    }
    ctx.note('카카오 · 구글 로그인 화면은 못 봄 (이메일 임시 계정으로 가입 직후 상태만 확인)');
  } finally {
    await ctx.admin.auth.admin.deleteUser(id);
  }
}

// ---- 15장 (남용 · 보안) 대본 층 — 단계 5 · 22에 붙여 봄 ----
// 15-02: 함수 밖 직접 insert는 닫혀 있음 (횟수 제한 · 차단 검사를 우회하지 못하게)
async function directInsertClosed(ctx) {
  const r = await ctx.a.from('friends').insert({ requester_id: ctx.ids.A, addressee_id: ctx.ids.B, status: 'PENDING' });
  must(r.error, '함수 밖 직접 insert로 친구 요청이 만들어짐 (15-02)');
  must(/row-level security|permission denied|violates/i.test(r.error.message), `직접 insert 거절 이유가 권한이 아님: ${r.error.message}`);
  const left = ok(await ctx.admin.from('friends').select('friend_id').eq('requester_id', ctx.ids.A).eq('addressee_id', ctx.ids.B), '친구 행');
  must(left.length === 0, '거절됐다는데 친구 행이 남음');
}

// 15-27: 개발용 초기화는 부른 사람의 친구 · 그룹만 지우고 다른 사람 관계는 그대로. 임시 계정으로 함 (시드 계정을 비우지 않으려고)
async function devResetCheck(ctx) {
  if (!ctx.caps.hasRpc('dev_reset_my_data')) skip('dev_reset_my_data가 DB에 없음');
  const email = `e2e-reset-${rand()}@example.com`;
  const created = await ctx.admin.auth.admin.createUser({ email, password: ctx.password, email_confirm: true });
  must(!created.error, `임시 계정 만들기: ${created.error?.message}`);
  const T = created.data.user.id;
  try {
    ok(await ctx.admin.from('profiles').update({ nickname: '초기화시험', onboarded_at: new Date().toISOString() }).eq('user_id', T), '프로필 채우기');
    const { createClient } = await import('@supabase/supabase-js');
    const tc = createClient(ctx.url, ctx.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const si = await tc.auth.signInWithPassword({ email, password: ctx.password });
    must(!si.error, `임시 계정 로그인: ${si.error?.message}`);
    must((await sendRequest(ctx, tc, T, ctx.ids.B)) === 'REQUESTED', '임시 계정의 친구 요청이 REQUESTED가 아님');
    must((await acceptRequest(ctx, ctx.b, T, ctx.ids.B)) === 'ACCEPTED', 'B의 수락이 ACCEPTED가 아님');
    const g = ok(await tc.from('groups').insert({ group_name: `${E2E_PREFIX}초기화 그룹`, owner_id: T }).select().single(), '임시 계정 그룹');
    const bBefore = ok(await ctx.admin.from('friends').select('friend_id').or(`requester_id.eq.${ctx.ids.B},addressee_id.eq.${ctx.ids.B}`), 'B 친구 행 (전)');
    const res = ok(await tc.rpc('dev_reset_my_data'), '개발용 초기화');
    must(res?.friend_data, `초기화 결과에 친구 쪽 정리 요약이 없음: ${JSON.stringify(res)}`);
    const mine = ok(await ctx.admin.from('friends').select('friend_id').or(`requester_id.eq.${T},addressee_id.eq.${T}`), '임시 계정 친구 행');
    must(mine.length === 0, `초기화했는데 친구 행이 ${mine.length}개 남음`);
    const mem = ok(await ctx.admin.from('group_members').select('user_id').eq('group_id', g.group_id).eq('user_id', T), '임시 계정 멤버 행');
    must(mem.length === 0, '초기화했는데 그룹 멤버 행이 남음');
    const bAfter = ok(await ctx.admin.from('friends').select('friend_id').or(`requester_id.eq.${ctx.ids.B},addressee_id.eq.${ctx.ids.B}`), 'B 친구 행 (후)');
    must(bAfter.length === bBefore.length - 1, `B의 다른 친구 관계가 영향 받음: ${bBefore.length} → ${bAfter.length}`);
    const noLogin = await createClient(ctx.url, ctx.anonKey, { auth: { persistSession: false, autoRefreshToken: false } }).rpc('dev_reset_my_data');
    must(noLogin.error, '로그인 없이 개발용 초기화가 불림');
  } finally {
    await ctx.admin.from('groups').delete().like('group_name', `${E2E_PREFIX}초기화%`);
    const del = await ctx.admin.auth.admin.deleteUser(T);
    if (del.error) throw new Error(`임시 계정 지우기 실패: ${del.error.message}`);
  }
}

// 15-16: 그룹 기상 신호 채널은 서버 트리거만 보냄 — 멤버가 직접 broadcast를 보내도 다른 멤버에게 안 감
async function broadcastClosed(ctx) {
  const topic = `group:${ctx.s.group}:wake`;
  const got = [];
  const rx = ctx.b.channel(topic, { config: { private: true, broadcast: { self: false } } });
  rx.on('broadcast', { event: 'refresh' }, (m) => got.push(m));
  const subscribed = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    rx.subscribe((status) => {
      if (status === 'SUBSCRIBED') { clearTimeout(t); resolve(true); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(t); resolve(false); }
    });
  });
  try {
    if (!subscribed) skip('Realtime 비공개 채널을 못 열어 broadcast 거부 확인 생략 (로컬 Realtime 상태 확인)');
    const tx = ctx.a.channel(topic, { config: { private: true } });
    const txOpen = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 4000);
      tx.subscribe((status) => { if (status === 'SUBSCRIBED') { clearTimeout(t); resolve(true); } });
    });
    try {
      // 보내는 쪽이 채널을 못 열었다면 '서버가 거부'인지 '안 보냄'인지 구분이 안 되므로 확인 생략
      if (!txOpen) skip('보내는 쪽(A) 비공개 채널이 안 열려 broadcast 거부 확인 생략');
      await tx.send({ type: 'broadcast', event: 'refresh', payload: { date: todayKst(), from: 'e2e' } });
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      await ctx.a.removeChannel(tx);
    }
    must(got.length === 0, `A가 직접 보낸 기상 신호가 B에게 도착함 (${got.length}건)`);
  } finally {
    await ctx.b.removeChannel(rx);
  }
}

export const STEPS = [
  { n: 1, who: 'A', ch: '2 · 13', action: '카카오로 가입 → 자동 아이디', run: (ctx) => signupCheck(ctx, 'a') },
  { n: 2, who: 'B', ch: '2 · 13', action: '구글로 가입 → 자동 아이디', run: (ctx) => signupCheck(ctx, 'b') },
  {
    n: 3,
    who: 'A',
    ch: '2',
    action: '내 아이디 [바꾸기] → 다음 변경은 30일 뒤',
    async run(ctx) {
      if (!ctx.caps.hasCol('profiles', 'handle_changed_at')) skip('아이디 바꾸기 미구현 (2장: handle_changed_at 없음)');
      const fn = rpcOf(ctx.caps, 'change_handle');
      if (!fn) skip('change_my_handle이 DB에 없음');
      // 앱이 handle을 직접 쓰면 막혀야 함 (42501)
      const direct = await ctx.a.from('profiles').update({ handle: `e2e_a_${rand()}` }).eq('user_id', ctx.ids.A);
      must(direct.error?.code === '42501', `handle 직접 update가 안 막힘: ${direct.error?.code ?? '성공'}`);
      // 처음 바꾸기(자동 아이디 · 시드 아이디)는 30일에 안 세고, 다음 바꾸기부터 30일 제한 — 둘째에서 제한 시각이 생기면 셋째는 LIMIT
      const change = async (h) => ok(await callRpc(ctx.a, fn, { p_handle: h }), '아이디 변경');
      const h1 = `e2e_a_${rand()}`;
      const r1 = await change(h1);
      if (r1.status === 'LIMIT') skip(`A가 이미 아이디 변경 제한 중(${r1.next_change_at}까지) — 지난 실행 복원 실패면 node run.mjs --restore`);
      must(r1.status === 'OK' && r1.handle === h1, `첫 변경이 OK가 아님: ${r1.status}`);
      let last = r1;
      if (!r1.next_change_at) {
        last = await change(`e2e_a_${rand()}`);
        must(last.status === 'OK' && last.next_change_at, `둘째 변경에 30일 제한 시각이 안 생김: ${last.status} (A의 onboarded_at이 비어 있으면 안 생김)`);
      }
      const p = ok(await ctx.admin.from('profiles').select('handle_changed_at, handle_next_change_at').eq('user_id', ctx.ids.A).single(), '읽기');
      must(p.handle_changed_at, '변경 시각(handle_changed_at)이 안 남음');
      const again = await change(`e2e_a_${rand()}`);
      must(again.status === 'LIMIT' && again.next_change_at === last.next_change_at, `30일 안에 또 바꿀 수 있음: ${again.status}`);
    },
  },
  {
    n: 4,
    who: 'A',
    ch: '2',
    action: 'B 아이디 검색 → 닉네임 · 사진 · @아이디',
    async run(ctx) {
      const r = await searchHandle(ctx, ctx.a, ctx.handles.B);
      must(r.status === 'FOUND' && r.profile?.user_id === ctx.ids.B, `B가 검색 결과로 안 나옴: ${r.status}`);
      must(r.profile.nickname && r.profile.handle, '닉네임 · 아이디가 없음');
      if (r.relation !== null) must(r.relation === 'NONE', `친구 관계가 비어 있어야 하는데 relation=${r.relation}`);
    },
  },
  {
    n: 5,
    who: 'A',
    ch: '2 · 15',
    action: '없는 아이디 → 찾을 수 없어요',
    async run(ctx) {
      const r = await searchHandle(ctx, ctx.a, `nobody_${rand()}`);
      must(r.status === 'NOT_FOUND' && !r.profile, `없는 아이디인데 결과가 나옴: ${r.status}`);
      // 15장 대본 층: 직접 insert 닫힘(15-02) · 시드 계정 아이디는 demo_ 로 구분(15-28) · 개발용 초기화(15-27)
      if (rpcOf(ctx.caps, 'friend_request')) await directInsertClosed(ctx);
      must(/^demo_/.test(ctx.handles.B), `시드 계정 아이디가 demo_로 시작하지 않음: ${ctx.handles.B}`);
      await devResetCheck(ctx);
    },
  },
  {
    n: 6,
    who: 'A',
    ch: '3',
    action: '[친구 요청] → 요청 보냄, 보낸 목록',
    async run(ctx) {
      const st = await sendRequest(ctx, ctx.a, ctx.ids.A, ctx.ids.B);
      must(st === 'REQUESTED', `요청 결과가 REQUESTED가 아님: ${st}`);
      const row = await friendRow(ctx, ctx.ids.A, ctx.ids.B);
      must(row?.status === 'PENDING' && row.requester_id === ctx.ids.A, `요청 행이 PENDING이 아님: ${row?.status}`);
      ctx.s.fAB = row.friend_id;
      if (rpcOf(ctx.caps, 'friend_request')) {
        const dup = await sendRequest(ctx, ctx.a, ctx.ids.A, ctx.ids.B);
        must(dup === 'ALREADY_REQUESTED', `같은 요청을 또 보냈는데 ${dup}`);
      }
      const sent = ok(await ctx.a.from('friends').select('friend_id').eq('requester_id', ctx.ids.A).eq('status', 'PENDING'), '보낸 목록');
      must(sent.some((r) => r.friend_id === row.friend_id), 'A의 보낸 목록에 없음');
      const got = ok(await ctx.b.from('friends').select('friend_id').eq('addressee_id', ctx.ids.B).eq('status', 'PENDING'), '받은 요청');
      must(got.some((r) => r.friend_id === row.friend_id), 'B의 받은 요청에 없음');
      await canPush(ctx, ctx.ids.A, ctx.ids.B, 'FRIEND_REQUEST', '친구 요청');
      pushNote(ctx, 'B');
    },
  },
  {
    n: 7,
    who: 'B',
    ch: '3',
    action: '받은 요청 [수락] → 친구, 공유는 아직 없어요',
    deps: [6],
    async run(ctx) {
      const st = await acceptRequest(ctx, ctx.b, ctx.ids.A, ctx.ids.B);
      must(st === 'ACCEPTED', `수락 결과가 ACCEPTED가 아님: ${st}`);
      if (rpcOf(ctx.caps, 'friend_accept')) {
        const again = await acceptRequest(ctx, ctx.b, ctx.ids.A, ctx.ids.B);
        must(again === 'ALREADY_FRIEND', `두 번 수락했는데 ${again}`);
        const row = await friendRow(ctx, ctx.ids.A, ctx.ids.B);
        must(row?.accepted_at, '수락 시각이 서버에서 안 채워짐');
        const back = await ctx.b.from('friends').update({ status: 'PENDING' }).eq('friend_id', ctx.s.fAB).select();   // 11/9부터 앱의 직접 update 길이 닫혀 오류 없이 0행
        must(!back.error && (back.data ?? []).length === 0, `직접 update가 막히지 않음: ${back.error?.code ?? `${(back.data ?? []).length}행`}`);
        const kept = await friendRow(ctx, ctx.ids.A, ctx.ids.B);
        must(kept?.status === 'ACCEPTED', `수락을 되돌릴 수 있음: ${kept?.status ?? '행 없음'}`);
      }
      const seen = ok(await ctx.a.from('friends').select('status').eq('friend_id', ctx.s.fAB), 'A 쪽 확인');
      must(seen[0]?.status === 'ACCEPTED', 'A 목록에서 친구가 아님');
      const perms = ok(await ctx.admin.from('sharing_permissions').select('permission_id').eq('source_id', ctx.s.fAB), '권한 확인');
      must(perms.length === 0, '수락만 했는데 권한 행이 생김');
      await canPush(ctx, ctx.ids.B, ctx.ids.A, 'FRIEND_ACCEPTED', '친구 수락');
      pushNote(ctx, 'A');
    },
  },
  {
    n: 8,
    who: 'A',
    ch: '5',
    action: '[새 그룹 만들기] → 공유창(코드) → 동의 시트',
    async run(ctx) {
      const g = ok(
        await ctx.a.from('groups').insert({ group_name: `${E2E_PREFIX}그룹`, owner_id: ctx.ids.A }).select().single(),
        '그룹 만들기',
      );
      ctx.s.group = g.group_id;
      ctx.s.code = g.invite_code;
      must(g.invite_code, '초대 코드가 없음');
      if (rpcOf(ctx.caps, 'group_code')) {
        must(/^[A-HJ-NP-Z2-9]{8}$/.test(g.invite_code), `초대 코드가 8자 대문자 · 숫자(0 O 1 I 뺌)가 아님: ${g.invite_code}`);
        const direct = await ctx.a.from('groups').update({ invite_code: 'ABCDEFGH' }).eq('group_id', g.group_id);
        must(direct.error?.code === '42501', `초대 코드를 직접 바꿀 수 있음: ${direct.error?.code ?? '성공'}`);
        const sheet = ok(await callRpc(ctx.a, ctx.fn.group_code, { p_group_id: g.group_id }), '코드 시트');
        must(sheet.status === 'OK' && sheet.code === g.invite_code, `코드 시트가 같은 코드를 주지 않음: ${sheet.status}`);
      }
      const me = ok(await ctx.a.from('group_members').select('invite_status, wake_share_opt_in').eq('group_id', g.group_id).eq('user_id', ctx.ids.A), '내 멤버 행');
      must(me[0]?.invite_status === 'JOINED', '만든 사람이 바로 멤버(JOINED)가 아님');
    },
  },
  {
    n: 9,
    who: 'A',
    ch: '5 · 6',
    action: '동의 시트 [공유] → 그룹 카드, 기상 공유 켜짐',
    deps: [8],
    async run(ctx) {
      const r = ok(
        await ctx.a.from('group_members').update({ wake_share_opt_in: true }).eq('group_id', ctx.s.group).eq('user_id', ctx.ids.A).select(),
        '동의 켜기',
      );
      must(r[0]?.wake_share_opt_in === true, '기상 공유 동의가 안 켜짐');
    },
  },
  {
    n: 10,
    who: 'B',
    ch: '5',
    action: '[그룹 참여하기] 코드 입력 → 미리보기',
    deps: [8],
    async run(ctx) {
      const preview = rpcOf(ctx.caps, 'group_preview');
      if (preview) {
        const pv = ok(await callRpc(ctx.b, preview, { p_code: ctx.s.code }), '코드 미리보기');
        must(pv.status === 'FOUND' && pv.group_name === `${E2E_PREFIX}그룹`, `미리보기가 FOUND + 그룹 이름이 아님: ${pv.status} ${pv.group_name}`);
        must(pv.member_count === 1 && pv.already_joined === false, `미리보기 인원 · 참여 여부가 다름: ${pv.member_count} ${pv.already_joined}`);
        const bad = ok(await callRpc(ctx.b, preview, { p_code: 'ZZZZZZZZ' }), '틀린 코드 미리보기');
        must(bad.status === 'NOT_FOUND', `틀린 코드가 NOT_FOUND가 아님: ${bad.status}`);
      } else {
        ctx.note('코드 입력 미리보기(이름 · 인원 · 오류) 확인 생략 (5장 미구현)');
      }
      const join = rpcOf(ctx.caps, 'group_join');
      if (join) {
        const r = ok(await callRpc(ctx.b, join, { p_code: ctx.s.code }), '코드로 참여');
        must(r.status === 'JOINED' && r.group_id === ctx.s.group, `참여 결과가 JOINED가 아님: ${r.status}`);
        const again = ok(await callRpc(ctx.b, join, { p_code: ctx.s.code }), '코드로 다시 참여');
        must(again.status === 'ALREADY_JOINED', `이미 참여했는데 ${again.status}`);
      } else {
        const id = ok(await callRpc(ctx.b, ctx.fn.join_group, { p_invite_code: ctx.s.code }), '코드로 참여');
        must(id === ctx.s.group, '다른 그룹으로 참여됨');
      }
      const me = ok(await ctx.b.from('group_members').select('invite_status').eq('group_id', ctx.s.group).eq('user_id', ctx.ids.B), '내 멤버 행');
      must(me[0]?.invite_status === 'JOINED', 'B가 JOINED가 아님');
    },
  },
  {
    n: 11,
    who: 'B',
    ch: '5 · 11',
    action: '참여 → 동의 [공유] → 그룹 안, A에게 새 멤버 푸시',
    deps: [10],
    async run(ctx) {
      ok(await ctx.b.from('group_members').update({ wake_share_opt_in: true }).eq('group_id', ctx.s.group).eq('user_id', ctx.ids.B), '동의 켜기');
      const rows = ok(await ctx.a.from('group_members').select('user_id, invite_status, wake_share_opt_in').eq('group_id', ctx.s.group), 'A가 본 멤버');
      const b = rows.find((r) => r.user_id === ctx.ids.B);
      must(b?.invite_status === 'JOINED' && b.wake_share_opt_in, 'A 화면에 B가 동의한 멤버로 안 보임');
      const to = await groupPush(ctx, ctx.ids.B, 'GROUP_MEMBER_JOINED');
      if (to) must(to.includes(ctx.ids.A) && !to.includes(ctx.ids.B), `새 멤버 푸시 받는 사람이 A가 아님: ${to.length}명`);
      pushNote(ctx, 'A');
    },
  },
  {
    n: 12,
    who: 'C',
    ch: '3',
    action: 'F01에서 A에게 요청, A 수락 → 친구',
    async run(ctx) {
      const st = await sendRequest(ctx, ctx.c, ctx.ids.C, ctx.ids.A);
      must(st === 'REQUESTED', `C의 요청 결과가 REQUESTED가 아님: ${st}`);
      const row = await friendRow(ctx, ctx.ids.C, ctx.ids.A);
      must(row?.status === 'PENDING', 'C의 요청 행이 없음');
      ctx.s.fAC = row.friend_id;
      const acc = await acceptRequest(ctx, ctx.a, ctx.ids.C, ctx.ids.A);
      must(acc === 'ACCEPTED', `A의 수락 결과가 ACCEPTED가 아님: ${acc}`);
      const seen = ok(await ctx.c.from('friends').select('status').eq('friend_id', row.friend_id), 'C 쪽 확인');
      must(seen[0]?.status === 'ACCEPTED', 'C 목록에서 친구가 아님');
      ctx.note('C 가입(OAuth)은 시드 계정으로 대신');
    },
  },
  {
    n: 13,
    who: 'A',
    ch: '5',
    action: 'G02 [+ 초대] C 고름 → C 줄 초대 중',
    deps: [8, 12],
    async run(ctx) {
      const invite = rpcOf(ctx.caps, 'group_invite');
      if (invite) {
        const r = ok(await callRpc(ctx.a, invite, { p_group_id: ctx.s.group, p_user_id: ctx.ids.C }), '친구 초대');
        must(r.status === 'INVITED', `초대 결과가 INVITED가 아님: ${r.status}`);
        const dup = ok(await callRpc(ctx.a, invite, { p_group_id: ctx.s.group, p_user_id: ctx.ids.C }), '친구 초대(두 번째)');
        must(dup.status === 'ALREADY_INVITED', `같은 사람을 또 초대했는데 ${dup.status}`);
      } else {
        ok(await ctx.a.from('group_members').insert({ group_id: ctx.s.group, user_id: ctx.ids.C, invite_status: 'INVITED' }), '친구 초대(옛 길)');
      }
      const mine = ok(await ctx.c.from('group_members').select('invite_status').eq('group_id', ctx.s.group).eq('user_id', ctx.ids.C), 'C가 본 초대');
      must(mine[0]?.invite_status === 'INVITED', 'C에게 초대 카드가 안 보임');
      const cards = rpcOf(ctx.caps, 'group_invites');
      if (cards) {
        const list = ok(await callRpc(ctx.c, cards, {}), '받은 초대 목록');
        const card = list.find((r) => r.group_id === ctx.s.group);
        must(card && card.invited_by === ctx.ids.A, 'C의 받은 초대 카드에 이 그룹(초대한 사람 A)이 없음');
      }
    },
  },
  {
    n: 14,
    who: 'C',
    ch: '5',
    action: '초대 카드 [수락] → 동의 → 그룹 3명',
    deps: [13],
    async run(ctx) {
      const accept = rpcOf(ctx.caps, 'group_accept');
      if (accept) {
        // 직접 상태를 바꾸는 옛 방식은 막혀 있어야 함 (초대 수락 · 다시 참여는 함수로만)
        const direct = await ctx.c.from('group_members').update({ invite_status: 'JOINED' }).eq('group_id', ctx.s.group).eq('user_id', ctx.ids.C);
        must(direct.error?.code === '42501', `초대를 직접 update로 수락할 수 있음: ${direct.error?.code ?? '성공'}`);
        const r = ok(await callRpc(ctx.c, accept, { p_group_id: ctx.s.group, p_wake_share: true }), '초대 수락');
        must(r.status === 'JOINED', `수락 결과가 JOINED가 아님: ${r.status}`);
        const again = ok(await callRpc(ctx.c, accept, { p_group_id: ctx.s.group, p_wake_share: true }), '초대 수락(두 번째)');
        must(again.status === 'ALREADY_JOINED', `두 번 수락했는데 ${again.status}`);
        const me = ok(await ctx.c.from('group_members').select('wake_share_opt_in').eq('group_id', ctx.s.group).eq('user_id', ctx.ids.C), 'C의 동의');
        must(me[0]?.wake_share_opt_in === true, '수락할 때 낸 기상 공유 동의가 안 켜짐');
      } else {
        ok(
          await ctx.c.from('group_members').update({ invite_status: 'JOINED', joined_at: new Date().toISOString(), wake_share_opt_in: true }).eq('group_id', ctx.s.group).eq('user_id', ctx.ids.C),
          '초대 수락(옛 길)',
        );
      }
      const rows = ok(await ctx.a.from('group_members').select('user_id').eq('group_id', ctx.s.group).eq('invite_status', 'JOINED'), '멤버 수');
      must(rows.length === 3, `JOINED가 3명이 아님: ${rows.length}`);
      const to = await groupPush(ctx, ctx.ids.C, 'GROUP_MEMBER_JOINED');
      if (to) must(to.includes(ctx.ids.A) && to.includes(ctx.ids.B) && !to.includes(ctx.ids.C), `새 멤버 푸시 받는 사람이 A · B가 아님: ${to.length}명`);
      pushNote(ctx, 'A · B');
    },
  },
  {
    n: 15,
    who: 'A',
    ch: '5',
    action: 'G02 이름 바꾸기 (멤버 누구나)',
    deps: [8],
    async run(ctx) {
      const r = ok(await ctx.a.from('groups').update({ group_name: `${E2E_PREFIX}그룹 (이름 바꿈)` }).eq('group_id', ctx.s.group).select(), 'A의 이름 변경');
      must(r.length === 1, 'A가 이름을 못 바꿈');
      // 5장부터 owner_id는 '만든 사람 기록'일 뿐이고 이름은 참여 중 멤버 누구나 고침. 5장 함수가 없는 DB에서만 B 확인을 생략
      if (ctx.caps.hasCol('groups', 'owner_id') && !rpcOf(ctx.caps, 'group_join')) {
        ctx.note('B(만든 사람 아님)의 이름 변경 확인 생략 — 그룹장 없음 미반영 (5장 미구현: owner_id 정책이 남아 있음)');
      } else {
        const b = ok(await ctx.b.from('groups').update({ group_name: `${E2E_PREFIX}그룹 (B가 바꿈)` }).eq('group_id', ctx.s.group).select(), 'B의 이름 변경');
        must(b.length === 1, '멤버 B가 이름을 못 바꿈 (그룹장 없음 규칙)');
      }
    },
  },
  {
    n: 16,
    who: 'B',
    ch: '6',
    action: 'F03 A에게 알람 조회 · 설정 켜기 → 저장',
    deps: [7, 14],
    async run(ctx) {
      ok(
        await ctx.b.from('sharing_permissions').insert({
          owner_id: ctx.ids.B,
          grantee_id: ctx.ids.A,
          source_type: 'FRIEND',
          source_id: ctx.s.fAB,
          can_view_alarm: true,
          can_edit_alarm: true,
        }),
        '권한 저장',
      );
      const got = ok(await ctx.a.from('sharing_permissions').select('can_view_alarm, can_edit_alarm').eq('owner_id', ctx.ids.B).eq('grantee_id', ctx.ids.A), 'A가 받은 권한');
      must(got.length === 1 && got[0].can_view_alarm && got[0].can_edit_alarm, 'A가 받은 권한이 저장한 값과 다름');
      // 6장 '설정이면 조회': 조회를 끄면 설정도 같이 꺼지고, 설정만 켠 행은 못 들어감
      const row = ok(await ctx.admin.from('sharing_permissions').select('permission_id').eq('owner_id', ctx.ids.B).eq('grantee_id', ctx.ids.A), '권한 행');
      const pid = row[0].permission_id;
      const off = await ctx.b.from('sharing_permissions').update({ can_view_alarm: false }).eq('permission_id', pid).select();
      if (off.error) throw new Error(`조회 끄기: ${off.error.message}`);
      must(off.data[0]?.can_edit_alarm === false, '조회를 껐는데 설정이 같이 안 꺼짐 (설정⊂조회)');
      const editOnly = await ctx.b.from('sharing_permissions').update({ can_view_alarm: false, can_edit_alarm: true }).eq('permission_id', pid);
      must(editOnly.error, '설정만 켠 행이 저장됨 (설정⊂조회 위반)');
      ok(await ctx.b.from('sharing_permissions').update({ can_view_alarm: true, can_edit_alarm: true }).eq('permission_id', pid), '다시 켜기');
      // 그룹 권한 저장 함수: 그룹원 전원에게 한 번에
      const save = rpcOf(ctx.caps, 'save_group_permissions');
      if (save) {
        const r = ok(await callRpc(ctx.b, save, { p_group_id: ctx.s.group, p_can_view_alarm: true, p_can_edit_alarm: false }), '그룹 권한 저장');
        must(r.status === 'OK' && r.saved === 2, `그룹 권한 저장 결과가 OK · 2명(A · C)이 아님: ${r.status} ${r.saved}`);
        const gp = ok(await ctx.admin.from('sharing_permissions').select('grantee_id, source_type, can_view_alarm, can_edit_alarm').eq('owner_id', ctx.ids.B).eq('source_type', 'GROUP').eq('source_id', ctx.s.group), '그룹 출처 권한');
        must(gp.length === 2 && gp.every((p) => p.can_view_alarm && !p.can_edit_alarm), '그룹 출처 권한이 저장한 값(조회만, 2명)과 다름');
      }    },
  },
  {
    n: 17,
    who: 'A',
    ch: '9',
    action: 'H05 새 일정 + 함께할 그룹 → 공동 약속',
    deps: [14],
    async run(ctx) {
      const id = randomUUID();
      ctx.s.apptAt = new Date(Math.ceil((Date.now() + 5 * 3600e3) / 60e3) * 60e3).toISOString();
      ok(
        await ctx.a.from('appointments').insert({
          appointment_id: id,
          series_id: id,
          creator_id: ctx.ids.A,
          group_id: ctx.s.group,
          title: `${E2E_PREFIX}점심`,
          appointment_at: ctx.s.apptAt, // 실행 시각 + 5시간 — 언제 돌려도 '앞으로 약속'이고 8장 고정 시각(7:35)보다 뒤
          dest_name: '세종대학교',
          dest_lat: 37.5509,
          dest_lng: 127.0736,
          memo: '대본 17단계',
        }),
        '공동 약속 저장',
      );
      ctx.s.appt = id;
      for (const [who, c] of [['B', ctx.b], ['C', ctx.c]]) {
        const seen = ok(await c.from('appointments').select('appointment_id').eq('appointment_id', id), `${who}가 본 약속`);
        must(seen.length === 1, `그룹원 ${who}에게 공동 약속이 안 보임`);
      }
    },
  },
  {
    n: 18,
    who: 'B',
    ch: '9',
    action: 'G02 연결 일정 [내 알람 만들기] → 참여',
    deps: [17],
    async run(ctx) {
      if (rpcOf(ctx.caps, 'join_appointment')) skip('join_appointment 입력 모양을 아직 안 맞춤');
      ctx.note('[내 알람 만들기]의 내 기본값(출발지 · 수단 · 준비 시간) 채우기 확인 생략 (앱이 채우는 값이라 화면 시험 몫)');
      const part = ok(
        await ctx.b.from('appointment_participants').insert({ appointment_id: ctx.s.appt, user_id: ctx.ids.B, prepare_minutes: 60 }).select().single(),
        '참여 행',
      );
      const alarm = ok(
        await ctx.b.from('alarms').insert({ participant_id: part.participant_id, user_id: ctx.ids.B, alarm_type: 'WAKE', scheduled_at: at('06:30') }).select().single(),
        '내 알람',
      );
      ctx.s.alarmB = alarm.alarm_id;
      ctx.s.partB = part.participant_id;
      // 9장 인원수 · 참여자 조회: 참여 = 약속에 알람이 켜져 있음
      if (ctx.caps.hasRpc('group_appointment_counts')) {
        const counts = ok(await ctx.a.rpc('group_appointment_counts', { p_group_id: ctx.s.group }), '약속 인원수');
        const row = counts.find((c) => c.appointment_id === ctx.s.appt);
        must(row && row.joined_count === 1 && row.i_joined === false, `인원수가 B 1명 · A는 참여 안 함이어야 함: ${JSON.stringify(row)}`);
        const joiners = ok(await ctx.a.rpc('appointment_joiners', { p_appointment_id: ctx.s.appt }), '참여자 조회');
        must(joiners.find((j) => j.user_id === ctx.ids.B)?.joined === true, '참여자 조회에 B가 참여로 안 보임');
      }
    },
  },
  {
    n: 19,
    who: 'C',
    ch: '9 · 7',
    action: '누르지 않음 → C는 알람 없음',
    deps: [17],
    async run(ctx) {
      const part = ok(await ctx.c.from('appointment_participants').select('participant_id').eq('appointment_id', ctx.s.appt), 'C의 참여 행');
      must(part.length === 0, 'C는 안 눌렀는데 참여 행이 있음');
      const anyC = ok(await ctx.admin.from('appointment_participants').select('participant_id').eq('appointment_id', ctx.s.appt).eq('user_id', ctx.ids.C), 'C 참여 행(관리자)');
      must(anyC.length === 0, '아무도 안 눌렀는데 C의 참여 행이 자동으로 생김 (알람은 참여 행에 붙으므로 알람도 없음)');
    },
  },
  {
    n: 20,
    who: 'A',
    ch: '8',
    action: 'G03(B) 알람 시각 지난 뒤 [깨우기]',
    deps: [11, 18],
    async run(ctx) {
      const fn = rpcOf(ctx.caps, 'wake_ping');
      if (!fn) skip('깨우기 함수가 DB에 없음');
      // plan_wake_ping은 서버 함수(notify)가 부르는 service_role 전용 — 판정에 쓰는 시각을 대본이 정함 (B의 기상 알람 6:30이 지난 7:00)
      const now = at('07:00');
      const args = { p_sender: ctx.ids.A, p_target: ctx.ids.B, p_reserve: true, p_now: now, p_group_id: ctx.s.group };
      const first = ok(await ctx.admin.rpc(fn, args), '깨우기');
      must(first.status === 'OK' && first.count === 1, `첫 깨우기가 OK가 아님: ${first.status} ${first.count}`);
      const again = ok(await ctx.admin.rpc(fn, args), '깨우기(바로 또)');
      must(again.status === 'WAIT', `5분 안에 또 눌렀는데 ${again.status}`);
      const mine = rpcOf(ctx.caps, 'my_wake_pings');
      if (mine) {
        const got = ok(await callRpc(ctx.b, mine, {}), 'B가 받은 깨우기');
        must(got.some((r) => r.sender_id === ctx.ids.A), 'B의 받은 깨우기 한 줄에 A가 없음');
      }
      ctx.note('깨우기 푸시 도착 확인 생략 (푸시 보냄은 서버 함수 몫, 도착은 사람 대본)');
    },
  },
  {
    n: 21,
    who: 'B',
    ch: '8 · 7',
    action: 'H08 푸시 → [일어났어요] → 기상 확인 한 건',
    deps: [18],
    async run(ctx) {
      ok(
        await ctx.b.from('alarm_events').insert({ alarm_id: ctx.s.alarmB, user_id: ctx.ids.B, event_type: 'WAKE_CONFIRMED', event_at: at('08:08'), input_source: 'BUTTON' }),
        '기상 확인',
      );
      const n = ok(await ctx.b.from('alarm_events').select('event_id').eq('alarm_id', ctx.s.alarmB).eq('event_type', 'WAKE_CONFIRMED'), '기상 확인 수');
      must(n.length === 1, `기상 확인이 한 건이 아님: ${n.length}`);
      // 7장: 같은 사람 같은 기상한 날 둘째 확인은 오류 없이 저장하지 않음 (먼저 것이 남음)
      const second = await ctx.b.from('alarm_events').insert({ alarm_id: ctx.s.alarmB, user_id: ctx.ids.B, event_type: 'WAKE_CONFIRMED', event_at: at('08:30'), input_source: 'BUTTON' });
      must(!second.error, `둘째 기상 확인이 오류가 남: ${second.error?.message}`);
      const after = ok(await ctx.b.from('alarm_events').select('event_at').eq('alarm_id', ctx.s.alarmB).eq('event_type', 'WAKE_CONFIRMED'), '기상 확인 수(둘째 뒤)');
      must(after.length === 1 && new Date(after[0].event_at).getTime() === new Date(at('08:08')).getTime(), '하루 한 건이 아니거나 먼저 것이 안 남음');
      // 하루 기록의 기상 시각도 같이
      const rec = ok(await ctx.admin.from('daily_records').select('wake_confirmed_at').eq('user_id', ctx.ids.B).eq('record_date', todayKst()), 'B의 오늘 기록');
      must(rec[0]?.wake_confirmed_at && new Date(rec[0].wake_confirmed_at).getTime() === new Date(at('08:08')).getTime(), `기상 확인 때 오늘 하루 기록의 기상 시각이 8:08로 같이 안 채워짐: ${rec[0]?.wake_confirmed_at}`);
      pushNote(ctx, '그룹원');
    },
  },
  {
    n: 22,
    who: 'A',
    ch: '7',
    action: 'G01 / G03 열기 → B 일어났어요 8:08',
    deps: [11, 21],
    async run(ctx) {
      const rows = ok(await callRpc(ctx.a, ctx.fn.group_wake, { p_group_id: ctx.s.group, p_date: todayKst() }), '그룹 기상 상태');
      const b = rows.find((r) => r.user_id === ctx.ids.B);
      must(b, 'A가 본 그룹 기상 줄에 B가 없음 (B는 기상 공유에 동의했음)');
      must(b.wake_status === 'CONFIRMED', `B가 일어났어요로 안 보임: ${b.wake_status}`);
      must(new Date(b.wake_confirmed_at).getTime() === new Date(at('08:08')).getTime(), `B 기상 확인 시각이 8:08(KST)이 아님: ${b.wake_confirmed_at}`);
      // 줄인 응답: 미루기 횟수 · 알람 끈 시각 같은 칸은 내 줄만
      const mine = rows.find((r) => r.is_me);
      must(mine, 'A 자신의 줄이 없음');
      // 15장 대본 층: 조회 날짜는 어제 · 오늘 · 내일만 (지난 이력을 거슬러 읽는 길 막음), 직접 broadcast 거부(15-16)
      for (const days of [3, -3]) {
        const d = new Date(Date.parse(`${todayKst()}T00:00:00Z`) + days * 86400e3).toISOString().slice(0, 10);
        const far = ok(await callRpc(ctx.a, ctx.fn.group_wake, { p_group_id: ctx.s.group, p_date: d }), `기상 조회 ${d}`);
        must(far.length === 0, `${d} 날짜로 조회하면 줄이 나오면 안 되는데 ${far.length}개 나옴`);
      }
      // 그룹에 없는 사람(임시 계정)을 대상으로 — 이미 초대된 C로 하면 중복 키 오류로 정책이 열려 있어도 통과함
      const tmp = await ctx.admin.auth.admin.createUser({ email: `e2e-inv-${rand()}@example.com`, password: ctx.password, email_confirm: true });
      must(!tmp.error, `임시 계정 만들기: ${tmp.error?.message}`);
      try {
        const direct = await ctx.a.from('group_members').insert({ group_id: ctx.s.group, user_id: tmp.data.user.id, invite_status: 'INVITED' });
        must(direct.error, '함수 밖 직접 insert로 그룹 초대가 만들어짐 (15-02)');
        must(/row-level security|permission denied/i.test(direct.error.message), `직접 초대 거절 이유가 권한이 아님: ${direct.error.message}`);
        const row = ok(await ctx.admin.from('group_members').select('user_id').eq('group_id', ctx.s.group).eq('user_id', tmp.data.user.id), '멤버 행');
        must(row.length === 0, '거절됐다는데 멤버 행이 남음');
      } finally {
        const del = await ctx.admin.auth.admin.deleteUser(tmp.data.user.id);
        if (del.error) throw new Error(`임시 계정 지우기 실패: ${del.error.message}`);
      }
      await broadcastClosed(ctx);
    },
  },
  {
    n: 23,
    who: 'C',
    ch: '8 · 11',
    action: '확인 없이 알람 시각 지남 → 미확인 알림 → 10분 뒤 깨워 볼까요?',
    deps: [10, 14, 19],
    async run(ctx) {
      const fn = rpcOf(ctx.caps, 'unconfirmed_batch');
      if (!fn) skip('미확인 알림 함수가 DB에 없음');
      // C의 기상 알람(6:50)이 울렸는데 확인 없이 지남 → 서버가 남긴 미확인 기록(7:20), 10분 뒤(7:35) 배치가 A · B에게 '깨워 볼까요?'
      const part = ok(await ctx.admin.from('appointment_participants').insert({ appointment_id: ctx.s.appt, user_id: ctx.ids.C, prepare_minutes: 60 }).select().single(), 'C 참여 행(준비)');
      const alarm = ok(await ctx.admin.from('alarms').insert({ participant_id: part.participant_id, user_id: ctx.ids.C, alarm_type: 'WAKE', scheduled_at: at('06:50') }).select().single(), 'C 기상 알람(준비)');
      ctx.s.partC = part.participant_id;
      ctx.s.alarmC = alarm.alarm_id;
      ok(await ctx.admin.from('alarm_events').insert({ alarm_id: alarm.alarm_id, user_id: ctx.ids.C, event_type: 'MISSED', event_at: at('07:20') }), 'C 미확인 기록(준비)');
      const nudge = ok(await ctx.admin.rpc(fn, { p_now: at('07:35') }), '미확인 알림 배치');
      const mine = nudge.filter((r) => r.sleeper_id === ctx.ids.C);
      // C는 시드의 다른 그룹(캡스톤팀)에도 있어 그 그룹원도 받는 사람에 들어올 수 있음 → A · B가 들어 있는지, 한 사람에게 한 번인지 봄
      const to = mine.filter((r) => r.kind === 'NUDGE').map((r) => r.recipient_id);
      must(to.includes(ctx.ids.A) && to.includes(ctx.ids.B), `깨워 볼까요? 받는 사람에 A · B가 없음: ${to.length}명`);
      must(new Set(to).size === to.length, '한 사람에게 깨워 볼까요?가 두 번 이상 정해짐');
      must(!to.includes(ctx.ids.C), '안 일어난 본인 C가 받는 사람에 들어 있음');
      const dup = ok(await ctx.admin.rpc(fn, { p_now: at('07:35') }), '미확인 알림 배치(또)');
      must(dup.filter((r) => r.sleeper_id === ctx.ids.C).length === 0, '같은 알림이 두 번 정해짐');
      // C가 늦게 확인하면 후속 '일어났어요' 한 번
      ok(await ctx.c.from('alarm_events').insert({ alarm_id: alarm.alarm_id, user_id: ctx.ids.C, event_type: 'WAKE_CONFIRMED', event_at: at('07:40'), input_source: 'BUTTON' }), 'C 늦은 기상 확인');
      const up = ok(await ctx.admin.rpc(fn, { p_now: at('07:45') }), '후속 배치');
      const upTo = up.filter((r) => r.kind === 'UP' && r.sleeper_id === ctx.ids.C).map((r) => r.recipient_id);
      must(upTo.includes(ctx.ids.A) && upTo.includes(ctx.ids.B), `일어났어요 후속 받는 사람에 A · B가 없음: ${upTo.length}명`);
      must(new Set(upTo).size === upTo.length, '한 사람에게 후속이 두 번 이상 정해짐');
      ctx.note('미확인 알림 푸시 도착 확인 생략 (받는 사람 정하기까지만, 도착은 사람 대본)');
    },
  },
  {
    n: 24,
    who: 'B',
    ch: '7',
    action: 'G02 기상 숨기기(C에게)',
    deps: [10, 14, 21],
    async run(ctx) {
      const fn = rpcOf(ctx.caps, 'wake_hide');
      if (!fn) skip('기상 숨기기 함수가 DB에 없음');
      const self = ok(await callRpc(ctx.b, fn, { p_user_id: ctx.ids.B, p_hidden: true }), '나 자신 숨기기');
      must(self.status === 'NOT_FOUND', `나 자신 숨기기가 NOT_FOUND가 아님: ${self.status}`);
      const hide = ok(await callRpc(ctx.b, fn, { p_user_id: ctx.ids.C, p_hidden: true }), 'C에게 숨기기');
      must(hide.status === 'OK', `숨기기 결과가 OK가 아님: ${hide.status}`);
      const wake = (client) => callRpc(client, ctx.fn.group_wake, { p_group_id: ctx.s.group, p_date: todayKst() });
      const seenByC = ok(await wake(ctx.c), 'C가 본 그룹 기상');
      const bAtC = seenByC.find((r) => r.user_id === ctx.ids.B);
      must(!bAtC || (!bAtC.wake_confirmed_at && bAtC.wake_status !== 'CONFIRMED'), '숨겼는데 C에게 B의 기상이 보임');
      const seenByA = ok(await wake(ctx.a), 'A가 본 그룹 기상');
      must(seenByA.find((r) => r.user_id === ctx.ids.B)?.wake_status === 'CONFIRMED', '숨기지 않은 A에게도 B의 기상이 안 보임');
      const show = ok(await callRpc(ctx.b, fn, { p_user_id: ctx.ids.C, p_hidden: false }), 'C에게 다시 보이기');
      must(show.status === 'OK', `다시 보이기 결과가 OK가 아님: ${show.status}`);
      const back = ok(await wake(ctx.c), 'C가 다시 본 그룹 기상');
      must(back.find((r) => r.user_id === ctx.ids.B)?.wake_status === 'CONFIRMED', '다시 보이게 했는데 C에게 안 보임');
    },
  },
  {
    n: 25,
    who: 'A',
    ch: '10',
    action: 'G04(B) 알람 +5분 골라 [보내기] → 제안 알림',
    deps: [16, 18],
    async run(ctx) {
      const fn = rpcOf(ctx.caps, 'alarm_suggest');
      if (!fn) skip('알람 제안 함수가 DB에 없음');
      // 제안은 '앞으로 울릴' 알람만 → 대본 시각(오늘 6:30)이 지났을 수 있어 B의 약속 카드에 지금 + 3시간 알람을 하나 더 만듦
      const base = new Date(Date.now() + 3 * 3600e3);
      base.setSeconds(0, 0);
      const alarm = ok(await ctx.admin.from('alarms').insert({ participant_id: ctx.s.partB, user_id: ctx.ids.B, alarm_type: 'DEPARTURE', scheduled_at: base.toISOString() }).select().single(), 'B의 앞으로 울릴 알람(준비)');
      ctx.s.alarmProp = alarm.alarm_id;
      ctx.s.alarmPropAt = base.getTime();
      const too = ok(await callRpc(ctx.a, fn, { p_alarm_id: alarm.alarm_id, p_new_at: new Date(base.getTime() + 90 * 60e3).toISOString() }), '제안(90분)');
      must(too.status === 'LIMIT', `±60분을 넘는 제안이 LIMIT이 아님: ${too.status}`);
      const same = ok(await callRpc(ctx.a, fn, { p_alarm_id: alarm.alarm_id, p_new_at: base.toISOString() }), '제안(같은 시각)');
      must(same.status === 'SAME', `같은 시각 제안이 SAME이 아님: ${same.status}`);
      const r = ok(await callRpc(ctx.a, fn, { p_alarm_id: alarm.alarm_id, p_new_at: new Date(base.getTime() + 5 * 60e3).toISOString() }), '제안(+5분)');
      must(r.status === 'OK' && r.proposal_id, `제안 결과가 OK가 아님: ${r.status}`);
      ctx.s.proposal = r.proposal_id;
      // 권한이 없는 C는 B의 알람을 제안 못 함
      const noPerm = ok(await callRpc(ctx.c, fn, { p_alarm_id: alarm.alarm_id, p_new_at: new Date(base.getTime() + 10 * 60e3).toISOString() }), 'C의 제안');
      must(noPerm.status === 'FORBIDDEN', `설정 권한 없는 C의 제안이 FORBIDDEN이 아님: ${noPerm.status}`);
      const mine = rpcOf(ctx.caps, 'my_proposals');
      if (mine) {
        const cards = ok(await callRpc(ctx.b, mine, {}), 'B가 받은 제안');
        must(cards.some((c) => c.proposal_id === r.proposal_id), 'B의 받은 제안 카드에 이 제안이 없음');
      }
      await canPush(ctx, ctx.ids.A, ctx.ids.B, 'ALARM_CHANGED', '알람 바꾸기 제안');
      const noPush = ctx.caps.hasRpc('can_send_push') ? ok(await ctx.admin.rpc('can_send_push', { p_sender_id: ctx.ids.C, p_target_id: ctx.ids.B, p_kind: 'ALARM_CHANGED' }), 'C의 푸시 판정') : false;
      must(noPush === false, '설정 권한이 없는 C가 B에게 알람 바뀜 푸시를 보낼 수 있다고 판정됨');
      pushNote(ctx, 'B');
    },
  },
  {
    n: 26,
    who: 'B',
    ch: '10',
    action: '제안 화면 [적용] → 알람 시각 바뀜, A에게 반영됨',
    deps: [25],
    async run(ctx) {
      const fn = rpcOf(ctx.caps, 'alarm_suggest_apply');
      if (!fn) skip('제안 적용 함수가 DB에 없음');
      const r = ok(await callRpc(ctx.b, fn, { p_proposal_id: ctx.s.proposal, p_apply: true }), '제안 적용');
      must(r.status === 'APPLIED', `적용 결과가 APPLIED가 아님: ${r.status}`);
      const a = ok(await ctx.admin.from('alarms').select('scheduled_at, original_scheduled_at, time_source').eq('alarm_id', ctx.s.alarmProp).single(), '바뀐 알람');
      must(new Date(a.scheduled_at).getTime() === ctx.s.alarmPropAt + 5 * 60e3, `알람이 +5분으로 안 바뀜: ${a.scheduled_at}`);
      must(new Date(a.original_scheduled_at).getTime() === ctx.s.alarmPropAt, '원래 시각이 안 남음');
      must(a.time_source === 'MANUAL', `time_source가 MANUAL이 아님: ${a.time_source}`);
      const again = ok(await callRpc(ctx.b, fn, { p_proposal_id: ctx.s.proposal, p_apply: true }), '제안 적용(두 번째)');
      must(again.status === 'NOT_FOUND', `이미 적용한 제안을 또 적용했는데 ${again.status}`);
      const sent = rpcOf(ctx.caps, 'sent_proposals');
      if (sent) {
        const list = ok(await callRpc(ctx.a, sent, { p_owner_id: ctx.ids.B }), 'A가 보낸 제안');
        must(list.some((p) => p.proposal_id === ctx.s.proposal && p.status === 'APPLIED'), 'A의 보낸 제안에 "반영됨"(APPLIED)이 없음');
      }
    },
  },
  {
    n: 27,
    who: 'A',
    ch: '9',
    action: '일정 시각 · 장소 변경 저장 → 참여자에게 공동 약속 변경 푸시, 재계산',
    deps: [17, 18],
    async run(ctx) {
      const newAt = new Date(new Date(ctx.s.apptAt).getTime() + 30 * 60e3).toISOString();
      const r = ok(
        await ctx.a.from('appointments').update({ appointment_at: newAt, dest_name: '강남역 2번출구' }).eq('appointment_id', ctx.s.appt).select(),
        '약속 변경',
      );
      must(r.length === 1, '약속이 안 바뀜');
      const seen = ok(await ctx.b.from('appointments').select('appointment_at, dest_name').eq('appointment_id', ctx.s.appt), 'B가 본 약속');
      must(new Date(seen[0]?.appointment_at).getTime() === new Date(newAt).getTime() && seen[0].dest_name === '강남역 2번출구', 'B 화면 약속이 안 바뀜');
      // #619: 공동 약속은 그룹원 누구나 고침 — 만든 사람이 아닌 B도 (알람에 안 닿는 메모만 바꿔 뒤 단계에 영향 없게)
      const bTry = await ctx.b.from('appointments').update({ memo: 'B가 고침' }).eq('appointment_id', ctx.s.appt).select();
      must(!bTry.error && (bTry.data ?? []).length === 1, '만든 사람이 아닌 그룹원 B가 공동 약속을 못 고침');
      // 변경 푸시 받는 사람 = 그 약속에 참여한 그룹원 (B), 보낸 A 제외
      const to = await groupPush(ctx, ctx.ids.A, 'GROUP_APPT_CHANGED', ctx.s.appt);
      if (to) must(to.includes(ctx.ids.B) && !to.includes(ctx.ids.A), `약속 변경 푸시 받는 사람에 B가 없음: ${to.length}명`);
      ctx.note('참여자 알람 재계산 확인 생략 (알람 시각 계산은 앱의 계산 몫, 이 시험은 푸시 받는 사람까지)');
    },
  },
  {
    n: 28,
    who: 'B',
    ch: '9',
    action: 'G02 [나는 빠지기] → 내 알람만 지워짐, 알림 없음',
    deps: [18],
    async run(ctx) {
      ok(await ctx.b.from('appointment_participants').delete().eq('appointment_id', ctx.s.appt).eq('user_id', ctx.ids.B), '빠지기');
      const alarm = ok(await ctx.b.from('alarms').select('alarm_id').eq('alarm_id', ctx.s.alarmB), '내 알람');
      must(alarm.length === 0, '빠졌는데 내 알람이 남음');
      const appt = ok(await ctx.a.from('appointments').select('appointment_id').eq('appointment_id', ctx.s.appt), '약속');
      must(appt.length === 1, '공동 약속 자체가 같이 지워짐');
      if (ctx.caps.hasRpc('group_appointment_counts')) {
        const joiners = ok(await ctx.a.rpc('appointment_joiners', { p_appointment_id: ctx.s.appt }), '참여자 조회');
        must(joiners.find((j) => j.user_id === ctx.ids.B)?.joined === false, '빠졌는데 참여자 조회에 B가 참여로 남음');
        const counts = ok(await ctx.a.rpc('group_appointment_counts', { p_group_id: ctx.s.group }), '약속 인원수');
        const now = counts.find((c) => c.appointment_id === ctx.s.appt)?.joined_count;
        // 대본 23번에서 C가 알람을 만들었으면 C 한 명이 남음, 아니면 0
        must(now === (ctx.s.alarmC ? 1 : 0), `빠진 뒤 인원수가 다름: ${now}`);
      }
      ctx.note('"알림 없음" 확인 생략 (보내지 않는다는 것은 푸시 기록 표로 못 봄 — 사람 대본)');
    },
  },
  {
    n: 29,
    who: 'A',
    ch: '6',
    action: 'F02(C) 권한 끄기 → C의 G04 목록에서 빠짐, 알림 없음',
    deps: [12],
    async run(ctx) {
      // 대본에는 없는 준비: A 개인 약속 + 알람 하나, C에게 조회 권한 주기
      const id = randomUUID();
      ok(
        await ctx.a.from('appointments').insert({
          appointment_id: id,
          series_id: id,
          creator_id: ctx.ids.A,
          title: `${E2E_PREFIX}개인 약속`,
          appointment_at: at('18:00'),
          dest_name: '동네 치과',
        }),
        'A 개인 약속',
      );
      const part = ok(await ctx.a.from('appointment_participants').insert({ appointment_id: id, user_id: ctx.ids.A }).select().single(), 'A 참여 행');
      ok(await ctx.a.from('alarms').insert({ participant_id: part.participant_id, user_id: ctx.ids.A, alarm_type: 'DEPARTURE', scheduled_at: at('17:00') }), 'A 알람');
      const perm = ok(
        await ctx.a
          .from('sharing_permissions')
          .insert({ owner_id: ctx.ids.A, grantee_id: ctx.ids.C, source_type: 'FRIEND', source_id: ctx.s.fAC, can_view_alarm: true })
          .select()
          .single(),
        'C에게 조회 권한',
      );
      const before = ok(await callRpc(ctx.c, ctx.fn.shared_alarms, { p_owner_id: ctx.ids.A }), 'C가 본 공유 알람(전)');
      must(before.some((r) => r.appointment_id === id), '권한이 있는데 C의 목록에 A의 약속이 안 보임');
      ok(await ctx.a.from('sharing_permissions').update({ can_view_alarm: false, can_edit_alarm: false }).eq('permission_id', perm.permission_id), '권한 끄기');
      const after = ok(await callRpc(ctx.c, ctx.fn.shared_alarms, { p_owner_id: ctx.ids.A }), 'C가 본 공유 알람(후)');
      must(after.length === 0, `권한을 껐는데 C 목록에 A의 약속이 ${after.length}개 남음`);
      ctx.note('"알림 없음" 확인 생략 (11장 푸시 기록 표 미구현)');
    },
  },
  {
    n: 30,
    who: 'C',
    ch: '4',
    action: 'F01 A의 요청에 [차단] → 대기 요청 지움',
    deps: [12],
    async run(ctx) {
      if (!ctx.caps.hasTable('user_blocks') || !rpcOf(ctx.caps, 'block_user')) skip('차단이 아직 없음 (4장 미구현: user_blocks · block_user)');
      // 대본 12단계에서 이미 친구가 됐으므로, 차단할 "A의 대기 요청"을 만들려고 친구를 끊고 A가 다시 요청
      ok(await ctx.admin.from('friends').delete().eq('friend_id', ctx.s.fAC), 'A–C 친구 끊기(준비)');
      const st = await sendRequest(ctx, ctx.a, ctx.ids.A, ctx.ids.C);
      must(st === 'REQUESTED', `A의 새 요청(준비)이 REQUESTED가 아님: ${st}`);
      const blk = ok(await callRpc(ctx.c, ctx.fn.block_user, { p_user_id: ctx.ids.A }), '차단');
      must(blk.status === 'BLOCKED', `차단 결과가 BLOCKED가 아님: ${blk.status}`);
      const again = ok(await callRpc(ctx.c, ctx.fn.block_user, { p_user_id: ctx.ids.A }), '차단(두 번째)');
      must(again.status === 'ALREADY_BLOCKED', `두 번 차단했는데 ${again.status}`);
      const perms = ok(
        await ctx.admin.from('sharing_permissions').select('permission_id').in('owner_id', [ctx.ids.A, ctx.ids.C]).in('grantee_id', [ctx.ids.A, ctx.ids.C]),
        '두 사람 사이 권한',
      );
      must(perms.length === 0, '차단했는데 두 사람 사이 공유 권한이 남음');
      const mine = ok(await callRpc(ctx.c, ctx.fn.my_blocks, {}), 'C의 차단 목록');
      must(mine.some((r) => r.user_id === ctx.ids.A), 'C의 차단 목록에 A가 없음');
      const theirs = ok(await callRpc(ctx.a, ctx.fn.my_blocks, {}), 'A의 차단 목록');
      must(!theirs.some((r) => r.user_id === ctx.ids.C), '차단당한 A의 목록에 C가 보임 (차단 사실이 새어 나감)');
      const retry = await sendRequest(ctx, ctx.a, ctx.ids.A, ctx.ids.C);
      must(retry === 'NOT_FOUND', `차단당한 뒤 A가 요청하면 NOT_FOUND여야 함: ${retry}`);
      const reportFn = rpcOf(ctx.caps, 'submit_report');
      if (reportFn) {
        const rep = ok(await callRpc(ctx.c, reportFn, { p_target_type: 'USER', p_target_id: ctx.ids.A, p_reason: 'HARASSMENT' }), '신고');
        must(rep.status === 'REPORTED', `신고 결과가 REPORTED가 아님: ${rep.status}`);
        const rep2 = ok(await callRpc(ctx.c, reportFn, { p_target_type: 'USER', p_target_id: ctx.ids.A, p_reason: 'HARASSMENT' }), '신고(두 번째)');
        must(rep2.status === 'ALREADY_REPORTED', `같은 대상 하루 두 번 신고가 됨: ${rep2.status}`);
        const direct = await ctx.c.from('reports').select('report_id');
        must(direct.error || (direct.data ?? []).length === 0, '앱이 신고 표를 직접 읽을 수 있음');
        ctx.note('신고 처리(웹 운영 화면, 팀원만) 확인 생략 (4장 빈 곳: 처리 함수 문서 보충 대기)');
      }
      const pending = ok(await ctx.c.from('friends').select('friend_id').eq('requester_id', ctx.ids.A).eq('addressee_id', ctx.ids.C), 'C의 받은 요청');
      must(pending.length === 0, '차단했는데 A의 대기 요청이 남음');
    },
  },
  {
    n: 31,
    who: 'A',
    ch: '2 · 4',
    action: 'C 아이디 검색 → 찾을 수 없어요',
    deps: [30],
    async run(ctx) {
      must(ctx.handles.C, 'C의 아이디를 못 읽음');
      const r = await searchHandle(ctx, ctx.a, ctx.handles.C);
      must(r.status === 'NOT_FOUND', `차단당했는데 C가 검색됨: ${r.status}`);
    },
  },
  {
    n: 32,
    who: 'A',
    ch: '4',
    action: 'G02 C 줄 → 이름만, 기상 공유 안 함',
    deps: [30, 14],
    async run(ctx) {
      // 비교 기준: C에게 오늘 기상 확인을 먼저 만들어 둠 (없으면 "안 보임"이 당연해서 확인이 안 됨)
      if (!ctx.s.alarmC) {
        const part = ok(await ctx.c.from('appointment_participants').insert({ appointment_id: ctx.s.appt, user_id: ctx.ids.C, prepare_minutes: 60 }).select().single(), 'C 참여 행(준비)');
        const alarm = ok(await ctx.c.from('alarms').insert({ participant_id: part.participant_id, user_id: ctx.ids.C, alarm_type: 'WAKE', scheduled_at: at('06:40') }).select().single(), 'C 알람(준비)');
        ok(await ctx.c.from('alarm_events').insert({ alarm_id: alarm.alarm_id, user_id: ctx.ids.C, event_type: 'WAKE_CONFIRMED', event_at: at('08:10'), input_source: 'BUTTON' }), 'C 기상 확인(준비)');
      }
      const rows = ok(await callRpc(ctx.a, ctx.fn.group_wake, { p_group_id: ctx.s.group, p_date: todayKst() }), '그룹 기상 상태');
      const c = rows.find((r) => r.user_id === ctx.ids.C);
      must(!c || (!c.wake_confirmed_at && c.wake_status !== 'CONFIRMED'), 'C의 기상 정보가 A에게 보임');
    },
  },
  {
    n: 33,
    who: 'C',
    ch: '4',
    action: '설정 차단 목록 [풀기] → 다시 친구는 새 요청부터',
    deps: [30],
    async run(ctx) {
      const ub = ok(await callRpc(ctx.c, ctx.fn.unblock_user, { p_user_id: ctx.ids.A }), '차단 풀기');
      must(ub.status === 'UNBLOCKED', `풀기 결과가 UNBLOCKED가 아님: ${ub.status}`);
      const ub2 = ok(await callRpc(ctx.c, ctx.fn.unblock_user, { p_user_id: ctx.ids.A }), '차단 풀기(두 번째)');
      must(ub2.status === 'GONE', `이미 푼 사람을 또 풀었는데 ${ub2.status}`);
      const left = ok(await callRpc(ctx.c, ctx.fn.my_blocks, {}), 'C의 차단 목록');
      must(!left.some((r) => r.user_id === ctx.ids.A), '풀었는데 차단 목록에 남음');
      const f = ok(await ctx.admin.from('friends').select('friend_id').in('requester_id', [ctx.ids.A, ctx.ids.C]).in('addressee_id', [ctx.ids.A, ctx.ids.C]), '친구 행');
      must(f.length === 0, '차단을 풀었는데 옛 친구 관계가 되살아남');
      const found = await searchHandle(ctx, ctx.a, ctx.handles.C);
      must(found.status === 'FOUND', `차단을 풀었는데 A가 C를 다시 못 찾음: ${found.status}`);
      // 다시 친구는 새 요청부터 (친구 · 권한이 복구되지 않음)
      const st = await sendRequest(ctx, ctx.a, ctx.ids.A, ctx.ids.C);
      must(st === 'REQUESTED', `풀린 뒤 새 요청이 REQUESTED가 아님: ${st}`);
      ok(await ctx.admin.from('friends').delete().in('requester_id', [ctx.ids.A, ctx.ids.C]).in('addressee_id', [ctx.ids.A, ctx.ids.C]), '새 요청 정리');
    },
  },
  {
    n: 34,
    who: 'A',
    ch: '5',
    action: 'G02 멤버 C [내보내기] → 알림 없음, 코드 새로 바뀜',
    deps: [14],
    async run(ctx) {
      const before = ok(await ctx.a.from('groups').select('invite_code').eq('group_id', ctx.s.group).single(), '코드');
      ok(await ctx.a.from('group_members').delete().eq('group_id', ctx.s.group).eq('user_id', ctx.ids.C), '내보내기');
      const left = ok(await ctx.a.from('group_members').select('user_id').eq('group_id', ctx.s.group).eq('user_id', ctx.ids.C), '멤버 확인');
      must(left.length === 0, 'C가 그룹에 남음');
      const after = ok(await ctx.a.from('groups').select('invite_code').eq('group_id', ctx.s.group).single(), '코드');
      must(after.invite_code !== before.invite_code, '내보냈는데 초대 코드가 안 바뀜');
      const join = rpcOf(ctx.caps, 'group_join');
      if (join) {
        const retry = ok(await callRpc(ctx.c, join, { p_code: before.invite_code }), '내보낸 뒤 옛 코드로 다시 참여');
        must(retry.status === 'NOT_FOUND', `내보낸 사람이 옛 코드로 다시 들어옴: ${retry.status}`);
      }
      // 9장: 그룹에서 빠지면 그 그룹의 '앞으로' 약속의 참여 · 알람이 지워짐 (대본 23번에서 C가 만든 참여)
      if (ctx.s.partC) {
        const pt = ok(await ctx.admin.from('appointment_participants').select('participant_id').eq('participant_id', ctx.s.partC), 'C의 참여 행');
        must(pt.length === 0, '내보냈는데 C의 앞으로 약속 참여가 남음');
        const al = ok(await ctx.admin.from('alarms').select('alarm_id').eq('alarm_id', ctx.s.alarmC), 'C의 알람');
        must(al.length === 0, '내보냈는데 C의 앞으로 약속 알람이 남음');
      }
      ctx.note('"알림 없음" 확인 생략 (보내지 않는다는 것은 푸시 기록 표로 못 봄 — 사람 대본)');
    },
  },
  {
    n: 35,
    who: 'B',
    ch: '5 · 9',
    action: '[나가기] → 공동 약속 알람 n개도 지워져요, 그룹에서 나감',
    deps: [10],
    async run(ctx) {
      if (rpcOf(ctx.caps, 'leave_group')) skip('leave_group 입력 모양을 아직 안 맞춤');
      ok(await ctx.b.from('group_members').update({ invite_status: 'LEFT' }).eq('group_id', ctx.s.group).eq('user_id', ctx.ids.B), '나가기');
      const g = ok(await ctx.b.from('groups').select('group_id').eq('group_id', ctx.s.group), 'B가 볼 수 있는 그룹');
      must(g.length === 0, '나갔는데 B가 그룹을 계속 봄');
      // A가 남아 있으니 그룹은 그대로
      const still = ok(await ctx.a.from('groups').select('group_id').eq('group_id', ctx.s.group), 'A가 본 그룹');
      must(still.length === 1, 'B가 나갔는데 그룹이 사라짐');
      if (rpcOf(ctx.caps, 'group_join')) {
        // 마지막 참여 멤버가 나가면 그룹이 자동으로 지워짐 (5장): 따로 만든 한 사람짜리 그룹으로 확인해 위 흐름의 그룹은 건드리지 않음
        const side = ok(await ctx.a.from('groups').insert({ group_name: `${E2E_PREFIX}마지막 멤버`, owner_id: ctx.ids.A }).select().single(), '한 사람 그룹');
        ok(await ctx.a.from('group_members').update({ invite_status: 'LEFT' }).eq('group_id', side.group_id).eq('user_id', ctx.ids.A), '마지막 멤버 나가기');
        const gone = ok(await ctx.admin.from('groups').select('group_id').eq('group_id', side.group_id), '그룹 남았나');
        must(gone.length === 0, '마지막 멤버가 나갔는데 그룹이 안 지워짐');
      } else {
        ctx.note('마지막 멤버가 나가면 그룹 자동 삭제 확인 생략 (5장 미구현)');
      }
      ctx.note('나가기 확인창의 "공동 약속 알람 n개" 글자 확인 생략 (화면 몫)');
    },
  },
  {
    n: 36,
    who: 'A',
    ch: '12',
    action: '설정 [계정 삭제] 확인 두 번 → 마지막 멤버라 그룹 · 공동 약속 삭제',
    deps: [12],
    async run(ctx) {
      const prep = rpcOf(ctx.caps, 'prepare_account_delete');
      if (!prep) skip('계정 삭제 준비 함수가 DB에 없음');
      // 시드 계정(demo-me)은 지울 수 없어 임시 계정 X가 A 대신 함. X: B와 친구 · 혼자 있는 그룹 · B와 함께 있는 그룹(공동 약속) · 개인 약속
      const email = `e2e-del-${rand()}@example.com`;
      const created = await ctx.admin.auth.admin.createUser({ email, password: ctx.password, email_confirm: true });
      must(!created.error, `임시 계정 만들기: ${created.error?.message}`);
      const X = created.data.user.id;
      ctx.s.delX = X;
      try {
      ok(await ctx.admin.from('profiles').update({ nickname: '삭제시험', onboarded_at: new Date().toISOString() }).eq('user_id', X), '프로필 채우기');
      const handle = ok(await ctx.admin.from('profiles').select('handle').eq('user_id', X).single(), '아이디').handle;
      ctx.s.delXHandle = handle;
      const { createClient } = await import('@supabase/supabase-js');
      const xc = createClient(ctx.url, ctx.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const si = await xc.auth.signInWithPassword({ email, password: ctx.password });
      must(!si.error, `임시 계정 로그인: ${si.error?.message}`);

      const st = await sendRequest(ctx, xc, X, ctx.ids.B);
      must(st === 'REQUESTED', `X의 친구 요청이 REQUESTED가 아님: ${st}`);
      const acc = await acceptRequest(ctx, ctx.b, X, ctx.ids.B);
      must(acc === 'ACCEPTED', `B의 수락이 ACCEPTED가 아님: ${acc}`);

      const mkAppt = (client, over) => {
        const id = randomUUID();
        return client.from('appointments').insert({
          appointment_id: id, series_id: id, creator_id: X, title: `${E2E_PREFIX}삭제 시험`, appointment_at: inFuture(5 * 3600e3),
          dest_name: '세종대학교', dest_lat: 37.5509, dest_lng: 127.0736, ...over,
        }).select().single();
      };
      const g1 = ok(await xc.from('groups').insert({ group_name: `${E2E_PREFIX}삭제 그룹 혼자`, owner_id: X }).select().single(), '혼자 있는 그룹');
      const a1 = ok(await mkAppt(xc, { group_id: g1.group_id }), '혼자 있는 그룹의 약속');
      const g2 = ok(await xc.from('groups').insert({ group_name: `${E2E_PREFIX}삭제 그룹 함께`, owner_id: X }).select().single(), 'B와 함께 있는 그룹');
      const join = rpcOf(ctx.caps, 'group_join');
      if (join) {
        const j = ok(await callRpc(ctx.b, join, { p_code: g2.invite_code }), 'B 참여');
        must(j.status === 'JOINED', `B 참여가 JOINED가 아님: ${j.status}`);
      } else {
        ok(await callRpc(ctx.b, ctx.fn.join_group, { p_invite_code: g2.invite_code }), 'B 참여(옛 길)');
      }
      const a2 = ok(await mkAppt(xc, { group_id: g2.group_id }), 'B와 함께 있는 그룹의 약속');
      const a3 = ok(await mkAppt(xc, { group_id: null, title: `${E2E_PREFIX}개인 삭제 시험` }), '개인 약속');
      ctx.s.delAppts = [a1.appointment_id, a2.appointment_id, a3.appointment_id];

      // 설정 > [계정 삭제] 확인 문구용 영향 요약
      const sum = rpcOf(ctx.caps, 'account_summary');
      if (sum) {
        const rows = ok(await callRpc(xc, sum, {}), '삭제 영향 요약');
        const r = Array.isArray(rows) ? rows[0] : rows;
        // 나갈 그룹 2개 = 혼자 있어 사라질 1개 + B와 함께 있어 남는 1개 (사라질 그룹도 나갈 그룹에 들어감)
        must(r.groups_leaving === 2 && r.groups_disappearing === 1 && r.group_appointments_staying === 1 && r.friends === 1,
          `영향 요약이 다름: ${JSON.stringify(r)}`);
      }
      // 서버가 계정을 지우기 전에 준비 → 두 번 불러도 같음 → 계정 삭제
      const p1 = ok(await ctx.admin.rpc(prep, { p_user_id: X }), '삭제 준비');
      must(p1.groups_left === 2 && p1.groups_deleted === 1 && p1.personal_deleted === 1 && p1.group_appointments_kept === 1, `삭제 준비 결과가 다름: ${JSON.stringify(p1)}`);
      const p2 = ok(await ctx.admin.rpc(prep, { p_user_id: X }), '삭제 준비(두 번째)');
      must(p2.groups_left === 0 && p2.personal_deleted === 0, `두 번째 준비가 0이 아님: ${JSON.stringify(p2)}`);
      const del = await ctx.admin.auth.admin.deleteUser(X);
      must(!del.error, `계정 삭제: ${del.error?.message}`);
      ctx.s.delXGone = true;

      const left = ok(await ctx.admin.from('groups').select('group_id').in('group_id', [g1.group_id, g2.group_id]), '그룹 남았나');
      must(left.length === 1 && left[0].group_id === g2.group_id, '마지막 멤버였던 그룹이 안 지워졌거나 B와 함께 있던 그룹이 지워짐');
      const apps = ok(await ctx.admin.from('appointments').select('appointment_id, creator_id').in('appointment_id', ctx.s.delAppts), '약속 남았나');
      const byId = Object.fromEntries(apps.map((a) => [a.appointment_id, a]));
      must(!byId[a1.appointment_id], '혼자 있던 그룹의 공동 약속이 안 지워짐');
      must(!byId[a3.appointment_id], '개인 약속이 안 지워짐');
      must(byId[a2.appointment_id] && byId[a2.appointment_id].creator_id === null, 'B와 함께 있던 공동 약속이 "만든 사람 알 수 없음"으로 남지 않음');
      } finally {
        // 중간에 실패해도 임시 계정(과 B와의 친구 행 · 개인 약속)이 남지 않게
        if (!ctx.s.delXGone) await ctx.admin.auth.admin.deleteUser(X).catch(() => {});
      }
    },
  },
  {
    n: 37,
    who: 'A',
    ch: '12',
    action: '삭제 후 B가 검색 → A 아이디 찾을 수 없어요, 친구 목록에서 사라짐',
    deps: [36],
    async run(ctx) {
      // 삭제된 X의 아이디를 B가 검색 → 찾을 수 없어요, 친구 목록에서 사라짐
      const r = await searchHandle(ctx, ctx.b, ctx.s.delXHandle);
      must(r.status === 'NOT_FOUND', `삭제한 계정이 검색됨: ${r.status}`);
      const f = ok(await ctx.admin.from('friends').select('friend_id').or(`requester_id.eq.${ctx.s.delX},addressee_id.eq.${ctx.s.delX}`), '친구 행');
      must(f.length === 0, '삭제한 계정의 친구 행이 남음');
      const mine = ok(await ctx.b.from('friends').select('friend_id, requester_id, addressee_id'), 'B의 친구 목록');
      must(!mine.some((x) => x.requester_id === ctx.s.delX || x.addressee_id === ctx.s.delX), 'B의 친구 목록에 삭제한 계정이 남음');
      // 공동 약속은 만든 사람 없이 B 쪽에 남음 → 시험 뒤 지움 (이름 머리말 E2E)
      ok(await ctx.admin.from('appointments').delete().in('appointment_id', ctx.s.delAppts), '남은 공동 약속 정리');
    },
  },
];
