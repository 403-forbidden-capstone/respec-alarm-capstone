// 논리설계 16장 대본 37단계. 단계 번호 · 누가 · 장은 문서 그대로, 아래 본문은 그 단계가 DB에 일으키는 일을 supabase-js로 함
//   사람 대본의 화면 확인(글자 · 버튼 모양)은 여기서 안 봄 — 화면에 보일 데이터가 맞는지만 봄
//   아직 없는 기능은 skip(), 있는데 대본대로 안 되면 must() / ok()가 FAIL
//   함수 입력 모양을 가정한 곳(PGRST202 = 그런 입력의 함수 없음)은 SKIP으로 떨어지고, S1이 만든 모양에 맞춰 고침
import { randomUUID } from 'node:crypto';

import { must, ok, skip } from './harness.mjs';
import { E2E_PREFIX } from './snapshot.mjs';
import { rpcOf } from './rpc-map.mjs';

const todayKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const at = (hhmm) => `${todayKst()}T${hhmm}:00+09:00`;
const rand = () => randomUUID().slice(0, 6);

// 함수를 부름. "그런 입력의 함수 없음"이면 SKIP (S1이 만든 모양과 다르다는 뜻)
async function callRpc(client, fn, args) {
  const res = await client.rpc(fn, args);
  if (res.error?.code === 'PGRST202') skip(`${fn} 입력 모양이 가정과 달라 steps.mjs를 맞춰야 함`);
  return res;
}

const pushNote = (ctx, who) => ctx.note(`${who}에게 푸시 도착 확인 생략 (11장 푸시 기록 표 미구현)`);

// ---- 가입 (1 · 2) — OAuth는 supabase-js로 못 하므로 이메일 임시 계정으로 "가입 직후 상태"만 봄 ----
async function signupCheck(ctx, label) {
  const email = `e2e-new-${label}-${rand()}@example.com`;
  const created = await ctx.admin.auth.admin.createUser({ email, password: ctx.password, email_confirm: true });
  must(!created.error, `임시 계정 만들기: ${created.error?.message}`);
  const id = created.data.user.id;
  try {
    const p = ok(await ctx.admin.from('profiles').select('handle').eq('user_id', id).single(), '프로필 읽기');
    if (!p.handle) skip('가입 때 자동 아이디(respec_xxxx)가 안 생김 (2장 미구현)');
    must(/^respec_[a-z0-9]{4,}$/.test(p.handle), `자동 아이디 모양이 다름: ${p.handle}`);
    ctx.note('카카오 · 구글 로그인 화면은 못 봄 (이메일 임시 계정으로 가입 직후 상태만 확인)');
  } finally {
    await ctx.admin.auth.admin.deleteUser(id);
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
      if (rpcOf(ctx.caps, 'change_handle')) skip('change_handle 입력 모양을 아직 안 맞춤');
      const h1 = `e2e_a_${rand()}`;
      ok(await ctx.a.from('profiles').update({ handle: h1 }).eq('user_id', ctx.ids.A), '아이디 변경');
      const p = ok(await ctx.admin.from('profiles').select('handle, handle_changed_at').eq('user_id', ctx.ids.A).single(), '읽기');
      must(p.handle === h1 && p.handle_changed_at, '변경 시각이 안 남음');
      const second = await ctx.a.from('profiles').update({ handle: `e2e_a_${rand()}` }).eq('user_id', ctx.ids.A);
      must(second.error, '30일 안에 또 바꿀 수 있음');
    },
  },
  {
    n: 4,
    who: 'A',
    ch: '2',
    action: 'B 아이디 검색 → 닉네임 · 사진 · @아이디',
    async run(ctx) {
      const rows = ok(await callRpc(ctx.a, ctx.fn.find_profile, { p_handle: ctx.handles.B }), '아이디 검색');
      must(rows.length === 1 && rows[0].user_id === ctx.ids.B, 'B가 검색 결과 한 줄로 안 나옴');
      must(rows[0].nickname && rows[0].handle, '닉네임 · 아이디가 없음');
    },
  },
  {
    n: 5,
    who: 'A',
    ch: '2 · 15',
    action: '없는 아이디 → 찾을 수 없어요',
    async run(ctx) {
      const rows = ok(await callRpc(ctx.a, ctx.fn.find_profile, { p_handle: `nobody_${rand()}` }), '아이디 검색');
      must(rows.length === 0, '없는 아이디인데 결과가 나옴');
    },
  },
  {
    n: 6,
    who: 'A',
    ch: '3',
    action: '[친구 요청] → 요청 보냄, 보낸 목록',
    async run(ctx) {
      if (rpcOf(ctx.caps, 'friend_request')) skip('friend_request 입력 모양을 아직 안 맞춤');
      const row = ok(
        await ctx.a.from('friends').insert({ requester_id: ctx.ids.A, addressee_id: ctx.ids.B }).select().single(),
        '친구 요청',
      );
      must(row.status === 'PENDING', `요청 상태가 PENDING이 아님: ${row.status}`);
      ctx.s.fAB = row.friend_id;
      const sent = ok(await ctx.a.from('friends').select('friend_id').eq('requester_id', ctx.ids.A).eq('status', 'PENDING'), '보낸 목록');
      must(sent.some((r) => r.friend_id === row.friend_id), 'A의 보낸 목록에 없음');
      const got = ok(await ctx.b.from('friends').select('friend_id').eq('addressee_id', ctx.ids.B).eq('status', 'PENDING'), '받은 요청');
      must(got.some((r) => r.friend_id === row.friend_id), 'B의 받은 요청에 없음');
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
      ok(await ctx.b.from('friends').update({ status: 'ACCEPTED', accepted_at: new Date().toISOString() }).eq('friend_id', ctx.s.fAB), '수락');
      const seen = ok(await ctx.a.from('friends').select('status').eq('friend_id', ctx.s.fAB), 'A 쪽 확인');
      must(seen[0]?.status === 'ACCEPTED', 'A 목록에서 친구가 아님');
      const perms = ok(await ctx.admin.from('sharing_permissions').select('permission_id').eq('source_id', ctx.s.fAB), '권한 확인');
      must(perms.length === 0, '수락만 했는데 권한 행이 생김');
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
      if (!rpcOf(ctx.caps, 'group_preview')) ctx.note('코드 입력 미리보기(이름 · 인원 · 오류) 확인 생략 (5장 미구현)');
      const id = ok(await callRpc(ctx.b, ctx.fn.join_group, { p_invite_code: ctx.s.code }), '코드로 참여');
      must(id === ctx.s.group, '다른 그룹으로 참여됨');
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
      pushNote(ctx, 'A');
    },
  },
  {
    n: 12,
    who: 'C',
    ch: '3',
    action: 'F01에서 A에게 요청, A 수락 → 친구',
    async run(ctx) {
      if (rpcOf(ctx.caps, 'friend_request')) skip('friend_request 입력 모양을 아직 안 맞춤');
      const row = ok(await ctx.c.from('friends').insert({ requester_id: ctx.ids.C, addressee_id: ctx.ids.A }).select().single(), 'C의 요청');
      ctx.s.fAC = row.friend_id;
      ok(await ctx.a.from('friends').update({ status: 'ACCEPTED', accepted_at: new Date().toISOString() }).eq('friend_id', row.friend_id), 'A의 수락');
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
      ok(
        await ctx.a.from('group_members').insert({ group_id: ctx.s.group, user_id: ctx.ids.C, invite_status: 'INVITED' }),
        '친구 초대',
      );
      const mine = ok(await ctx.c.from('group_members').select('invite_status').eq('group_id', ctx.s.group).eq('user_id', ctx.ids.C), 'C가 본 초대');
      must(mine[0]?.invite_status === 'INVITED', 'C에게 초대 카드가 안 보임');
    },
  },
  {
    n: 14,
    who: 'C',
    ch: '5',
    action: '초대 카드 [수락] → 동의 → 그룹 3명',
    deps: [13],
    async run(ctx) {
      ok(
        await ctx.c
          .from('group_members')
          .update({ invite_status: 'JOINED', joined_at: new Date().toISOString(), wake_share_opt_in: true })
          .eq('group_id', ctx.s.group)
          .eq('user_id', ctx.ids.C),
        '초대 수락',
      );
      const rows = ok(await ctx.a.from('group_members').select('user_id').eq('group_id', ctx.s.group).eq('invite_status', 'JOINED'), '멤버 수');
      must(rows.length === 3, `JOINED가 3명이 아님: ${rows.length}`);
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
      if (ctx.caps.hasCol('groups', 'owner_id')) {
        ctx.note('B(만든 사람 아님)의 이름 변경 확인 생략 — 그룹장 없음 미반영 (5장: owner_id 칼럼이 아직 있음)');
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
    deps: [7],
    async run(ctx) {
      if (rpcOf(ctx.caps, 'save_permissions')) skip('save_permissions 입력 모양을 아직 안 맞춤');
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
      if (!rpcOf(ctx.caps, 'save_permissions')) ctx.note('설정을 켜면 조회도 켜짐(설정⊂조회 제약) 확인 생략 (6장 저장 함수 미구현)');
    },
  },
  {
    n: 17,
    who: 'A',
    ch: '9',
    action: 'H05 새 일정 + 함께할 그룹 → 공동 약속',
    deps: [14],
    async run(ctx) {
      const id = randomUUID();
      ok(
        await ctx.a.from('appointments').insert({
          appointment_id: id,
          series_id: id,
          creator_id: ctx.ids.A,
          group_id: ctx.s.group,
          title: `${E2E_PREFIX}점심`,
          appointment_at: at('13:00'),
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
      ctx.note('[내 알람 만들기]의 내 기본값(출발지 · 수단 · 준비 시간) 채우기 확인 생략 (9장 함수 미구현 — 표를 직접 씀)');
      const part = ok(
        await ctx.b.from('appointment_participants').insert({ appointment_id: ctx.s.appt, user_id: ctx.ids.B, prepare_minutes: 60 }).select().single(),
        '참여 행',
      );
      const alarm = ok(
        await ctx.b.from('alarms').insert({ participant_id: part.participant_id, user_id: ctx.ids.B, alarm_type: 'WAKE', scheduled_at: at('06:30') }).select().single(),
        '내 알람',
      );
      ctx.s.alarmB = alarm.alarm_id;
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
    deps: [18],
    async run(ctx) {
      if (!rpcOf(ctx.caps, 'wake_ping')) skip('깨우기 함수가 아직 없음 (8장 미구현, rpc-map의 wake_ping)');
      skip('wake_ping 입력 모양을 아직 안 맞춤');
    },
  },
  {
    n: 21,
    who: 'B',
    ch: '8 · 7',
    action: 'H08 푸시 → [일어났어요] → 기상 확인 한 건',
    deps: [18],
    async run(ctx) {
      if (rpcOf(ctx.caps, 'wake_confirm')) skip('wake_confirm 입력 모양을 아직 안 맞춤');
      ok(
        await ctx.b.from('alarm_events').insert({ alarm_id: ctx.s.alarmB, user_id: ctx.ids.B, event_type: 'WAKE_CONFIRMED', event_at: at('08:08') }),
        '기상 확인',
      );
      const n = ok(await ctx.b.from('alarm_events').select('event_id').eq('alarm_id', ctx.s.alarmB).eq('event_type', 'WAKE_CONFIRMED'), '기상 확인 수');
      must(n.length === 1, `기상 확인이 한 건이 아님: ${n.length}`);
    },
  },
  {
    n: 22,
    who: 'A',
    ch: '7',
    action: 'G01 / G03 열기 → B 일어났어요 8:08',
    deps: [21],
    async run(ctx) {
      const rows = ok(await callRpc(ctx.a, ctx.fn.group_wake, { p_group_id: ctx.s.group, p_date: todayKst() }), '그룹 기상 상태');
      const b = rows.find((r) => r.user_id === ctx.ids.B);
      if (b?.wake_status === 'CONFIRMED') {
        must(new Date(b.wake_confirmed_at).getTime() === new Date(at('08:08')).getTime(), 'B 기상 확인 시각이 8:08(KST)이 아님');
        return;
      }
      // main은 그룹 동의만으로는 기상이 안 보임 (기상 조회 권한 행이 따로 필요) — 7장이 들어오면 FAIL로 바뀜
      if (!rpcOf(ctx.caps, 'wake_confirm')) skip('그룹 동의만으로는 B 기상이 안 보임 (7장 미반영: main은 기상 조회 권한 행이 필요함)');
      must(false, `B가 일어났어요로 안 보임: ${b ? b.wake_status : '행 없음'}`);
    },
  },
  {
    n: 23,
    who: 'C',
    ch: '8 · 11',
    action: '확인 없이 알람 시각 지남 → 미확인 알림 → 10분 뒤 깨워 볼까요?',
    deps: [19],
    async run(ctx) {
      if (!rpcOf(ctx.caps, 'unconfirmed_batch')) skip('미확인 알림 배치가 아직 없음 (8장 미구현)');
      skip('unconfirmed_batch 입력 모양을 아직 안 맞춤');
    },
  },
  {
    n: 24,
    who: 'B',
    ch: '7',
    action: 'G02 기상 숨기기(C에게)',
    deps: [14],
    async run(ctx) {
      if (!rpcOf(ctx.caps, 'wake_hide')) skip('멤버별 기상 숨기기가 아직 없음 (7장 미구현)');
      skip('wake_hide 입력 모양을 아직 안 맞춤');
    },
  },
  {
    n: 25,
    who: 'A',
    ch: '10',
    action: 'G04(B) 알람 +5분 골라 [보내기] → 제안 알림',
    deps: [16, 18],
    async run(ctx) {
      if (!rpcOf(ctx.caps, 'alarm_suggest')) skip('알람 바꾸기 제안이 아직 없음 (10장 미구현)');
      skip('alarm_suggest 입력 모양을 아직 안 맞춤');
    },
  },
  {
    n: 26,
    who: 'B',
    ch: '10',
    action: '제안 화면 [적용] → 알람 시각 바뀜, A에게 반영됨',
    deps: [25],
    async run(ctx) {
      if (!rpcOf(ctx.caps, 'alarm_suggest_apply')) skip('제안 적용이 아직 없음 (10장 미구현)');
      skip('alarm_suggest_apply 입력 모양을 아직 안 맞춤');
    },
  },
  {
    n: 27,
    who: 'A',
    ch: '9',
    action: '일정 시각 · 장소 변경 저장 → 참여자에게 공동 약속 변경 푸시, 재계산',
    deps: [17],
    async run(ctx) {
      const newAt = at('13:30');
      const r = ok(
        await ctx.a.from('appointments').update({ appointment_at: newAt, dest_name: '강남역 2번출구' }).eq('appointment_id', ctx.s.appt).select(),
        '약속 변경',
      );
      must(r.length === 1, '약속이 안 바뀜');
      const seen = ok(await ctx.b.from('appointments').select('appointment_at, dest_name').eq('appointment_id', ctx.s.appt), 'B가 본 약속');
      must(new Date(seen[0]?.appointment_at).getTime() === new Date(newAt).getTime() && seen[0].dest_name === '강남역 2번출구', 'B 화면 약속이 안 바뀜');
      ctx.note('참여자 알람 재계산 · "공동 약속 변경" 푸시 확인 생략 (9장 서버 함수 미구현)');
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
      ctx.note('"알림 없음" 확인 생략 (11장 푸시 기록 표 미구현)');
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
      ok(await ctx.a.from('friends').insert({ requester_id: ctx.ids.A, addressee_id: ctx.ids.C }), 'A의 새 요청(준비)');
      ok(await callRpc(ctx.c, ctx.fn.block_user, { p_user_id: ctx.ids.A }), '차단');
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
      const rows = ok(await callRpc(ctx.a, ctx.fn.find_profile, { p_handle: ctx.handles.C }), '아이디 검색');
      must(rows.length === 0, '차단당했는데 C가 검색됨');
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
      const part = ok(await ctx.c.from('appointment_participants').insert({ appointment_id: ctx.s.appt, user_id: ctx.ids.C, prepare_minutes: 60 }).select().single(), 'C 참여 행(준비)');
      const alarm = ok(await ctx.c.from('alarms').insert({ participant_id: part.participant_id, user_id: ctx.ids.C, alarm_type: 'WAKE', scheduled_at: at('06:40') }).select().single(), 'C 알람(준비)');
      ok(await ctx.c.from('alarm_events').insert({ alarm_id: alarm.alarm_id, user_id: ctx.ids.C, event_type: 'WAKE_CONFIRMED', event_at: at('08:10') }), 'C 기상 확인(준비)');
      const rows = ok(await callRpc(ctx.a, ctx.fn.group_wake, { p_group_id: ctx.s.group, p_date: todayKst() }), '그룹 기상 상태');
      const c = rows.find((r) => r.user_id === ctx.ids.C);
      must(!c || (!c.wake_confirmed_at && !c.rang_at && !c.dismissed_at), 'C의 기상 정보가 A에게 보임');
    },
  },
  {
    n: 33,
    who: 'C',
    ch: '4',
    action: '설정 차단 목록 [풀기] → 다시 친구는 새 요청부터',
    deps: [30],
    async run(ctx) {
      ok(await callRpc(ctx.c, ctx.fn.unblock_user, { p_user_id: ctx.ids.A }), '차단 풀기');
      const f = ok(await ctx.admin.from('friends').select('friend_id').in('requester_id', [ctx.ids.A, ctx.ids.C]).in('addressee_id', [ctx.ids.A, ctx.ids.C]), '친구 행');
      must(f.length === 0, '차단을 풀었는데 옛 친구 관계가 되살아남');
      const found = ok(await callRpc(ctx.a, ctx.fn.find_profile, { p_handle: ctx.handles.C }), '풀린 뒤 A의 검색');
      must(found.length === 1, '차단을 풀었는데 A가 C를 다시 못 찾음');
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
      ctx.note('"알림 없음" 확인 생략 (11장 푸시 기록 표 미구현)');
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
      ctx.note('나가기 확인창의 "공동 약속 알람 n개" 개수와 알람 정리 확인 생략 (9장 나감 트리거 미구현)');
    },
  },
  {
    n: 36,
    who: 'A',
    ch: '12',
    action: '설정 [계정 삭제] 확인 두 번 → 마지막 멤버라 그룹 · 공동 약속 삭제',
    deps: [34, 35],
    async run(ctx) {
      if (!rpcOf(ctx.caps, 'prepare_account_delete')) skip('계정 삭제 준비 함수가 아직 없음 (12장 미구현)');
      skip('시드 계정(demo-me)을 실제로 지울 수는 없어 임시 계정으로 하는 본문은 아직 없음');
    },
  },
  {
    n: 37,
    who: 'A',
    ch: '12',
    action: '삭제 후 B가 검색 → A 아이디 찾을 수 없어요, 친구 목록에서 사라짐',
    deps: [36],
    async run() {
      skip('36단계가 안 돼서 못 함');
    },
  },
];
