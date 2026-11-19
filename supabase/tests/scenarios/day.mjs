// 서버 쪽 시나리오 시험 — 4명 그룹이 하루를 지나는 동안 (전날 밤 약속 → 알람 · 미루기 · 해제 · 확인 · 판정 · 놓침 → 준비 · 출발 · 도착 → 다음 날)
//   장별 시험(friend/chNN)은 규칙 하나씩만 봄. 여기는 사람 여럿 · 시간 순서 · 설정 변화가 섞인 하루에서 시각마다
//     ① 각 사람이 보는 그룹 화면 값(get_group_wake 본문 private.group_wake_rows: 단계 · 출발 · 도착 시각 · trip_visible)
//     ② 새로 고침 신호(realtime.send 기록, 채널 group:<id>:wake)
//     ③ 서버가 고르는 푸시 대상(놓침 본인 · '깨워 볼까요?' · '일어났어요' 후속 · 깨우기 판정)
//   이 맞는지 봄. 정답지 = capstone/docs/분담_1104/원인분석_1119/ 시나리오 계획 3절 · 사건 부수효과 점검 (S번호 · G번호)
// 규칙
//   · 시각은 '오늘(한국 시간)' 기준(T)으로 잡음 — 고정 날짜를 쓰지 않아 날짜가 바뀌어도 안 깨짐. 공개 함수는 now()를 쓰므로 시각을 옮기는 시험은
//     p_now를 받는 본문(private.group_wake_rows · find_missed_wake_alarms · claim_wake_nudges · plan_wake_ping)으로 하고, 공개 함수는 한 번 같은 값인지만 대조(S-API)
//   · 기록은 앱이 쓰는 길 그대로: 앱 직접 쓰기 = as(uid)로 RLS를 거침, 앱이 꺼진 폰 = 기기 길(alarm-events-device)이 받는 조합만(deviceEventAllowed) 서비스 키로,
//     알림 5분 배치 wake-check = find_missed_wake_alarms → MISSED 기록 → claim_wake_nudges (_shared/wake.ts와 같은 순서, 푸시 전송만 뺌)
//   · 알려진 빈틈(G)과 새로 나온 것(NEW-n)은 knownGap으로 '원하는 동작'을 적어 둠 — 지금은 안 맞아 GAP · NEW로 따로 찍히고 db-check는 안 깸. 고치면 '한계가 풀림'으로 바뀜
// 사람은 이 파일 전용 계정. db-check 맨 끝에서 돎
export default async function scenarioDay({ q, as, su, svc, check, knownGap, classifyGap }) {
  const { deviceEventAllowed } = await import('../../functions/_shared/device-events.ts');

  // knownGap 구분 자체 시험 — 확인이 거짓이면 GAP · NEW, 예외면 FAIL(한계로 안 숨김), 참이면 '풀림'
  await check('GAP-도우미 · knownGap은 확인이 거짓이면 GAP/NEW, 값이 true면 풀림(PASS), 예외(SQL 오류 등)는 FAIL로 구분함', async () => {
    const got = [
      (await classifyGap('G0', 't', async () => ({ x: 1 })))[0],
      (await classifyGap('NEW-0', 't', async () => false))[0],
      (await classifyGap('G0', 't', async () => true))[0],
      (await classifyGap('G0', 't', async () => { await q('select * from public.no_such_table_scn'); }))[0],
      (await classifyGap('G0', 't', async () => { throw new Error('시드 실패'); }))[0],
    ];
    return JSON.stringify(got) === JSON.stringify(['GAP', 'NEW', 'PASS', 'FAIL', 'FAIL']) ? true : got;
  });

  // ---------------------------------------------------------------------
  // 시각 — 오늘(한국 시간) 기준
  // ---------------------------------------------------------------------
  const KST = 9 * 3600_000;
  const TODAY = new Date(Date.now() + KST).toISOString().slice(0, 10);
  const dayPlus = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  const T = (hhmm, off = 0) => `${dayPlus(off)}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}+09:00`;
  const hm = (v) => (v == null ? null : new Date(new Date(v).getTime() + KST).toISOString().slice(11, 16));
  const iso = (v) => (v == null ? null : new Date(v).toISOString());
  const eq = (got, want) => (JSON.stringify(got) === JSON.stringify(want) ? true : { got, want });

  // ---------------------------------------------------------------------
  // 사람 · 그룹 · 약속 · 알람 — 시드는 관리자 권한(앱은 알람을 서버 함수로만 만듦), 이후 기록은 앱 길
  // ---------------------------------------------------------------------
  let seq = 0;
  const id = (n) => `5c3a0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const join_ = async (nickname) => {
    const n = ++seq;
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `scn-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `scn_user_${n}`]);
    return id(n);
  };
  const app = async (uid, fn) => { await as(uid); try { return await fn(); } finally { await su(); } };   // 앱(로그인 토큰) 길 — RLS 그대로
  const call = (uid, sql, params = []) => app(uid, async () => (await q(`select ${sql} as r`, params))[0].r);

  const LET = ['A', 'B', 'C', 'D'];
  // 공유 설정이 서로 다른 4명: A = 기상 + 출발 · 도착, B = 기상만, C = 끔(기상 공유 안 함), D = 기상 + 출발 · 도착 켰지만 B에게는 숨김
  const SHARE = { A: [true, true], B: [true, false], C: [false, false], D: [true, true] };
  const WAKE_AT = { A: '07:00', B: '07:10', C: '07:20', D: '07:30' };

  // 약속 하나 + 사람별 참여 조건 · 알람 4종(기상 · 준비 · 출발 · 도착). 시각은 절대값(T)
  async function addAppt(W, { at = T('10:00'), wake, prep = T('08:50'), dep = T('09:20'), users = LET, creator = 'A', title = '시나리오 약속' } = {}) {
    const wakeAt = wake ?? Object.fromEntries(LET.map((k) => [k, T(WAKE_AT[k])]));
    const [ap] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, $3, $4::timestamptz, '학교') returning appointment_id`, [W.U[creator], W.g, title, at]);
    const out = { ap: ap.appointment_id, at, P: {}, AL: {} };
    for (const k of users) {
      const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id, buffer_minutes, est_travel_minutes) values ($1, $2, 10, 30) returning participant_id`, [out.ap, W.U[k]]);
      out.P[k] = pt.participant_id;
      out.AL[k] = {};
      for (const [type, when] of [['WAKE', wakeAt[k]], ['PREPARE', prep], ['DEPARTURE', dep], ['ARRIVE', at]]) {
        out.AL[k][type] = (await q(`insert into public.alarms (user_id, participant_id, alarm_type, scheduled_at) values ($1, $2, $3, $4::timestamptz) returning alarm_id`, [W.U[k], pt.participant_id, type, when]))[0].alarm_id;
      }
    }
    return out;
  }

  // 새 세계 — 4명 · 그룹 · 약속 하나(10:00). hide = D가 B에게 기상을 숨김
  async function world({ hide = true, ...opts } = {}) {
    const W = { U: {}, who: {}, hide };
    for (const k of LET) { W.U[k] = await join_(`시나리오${k}`); W.who[W.U[k]] = k; }
    await as(W.U.A);
    W.g = (await q(`insert into public.groups (group_name, owner_id) values ('하루그룹', $1) returning group_id`, [W.U.A]))[0].group_id;
    await su();
    for (const k of ['B', 'C', 'D']) {
      await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at, wake_share_opt_in, trip_share_opt_in) values ($1, $2, 'JOINED', now(), $3, $4)`, [W.g, W.U[k], ...SHARE[k]]);
    }
    await q(`update public.group_members set wake_share_opt_in = true, trip_share_opt_in = true where group_id = $1 and user_id = $2`, [W.g, W.U.A]);
    if (hide) await call(W.U.D, 'public.set_wake_hidden($1, $2)', [W.U.B, true]);
    W.main = await addAppt(W, opts);
    W.P = W.main.P;
    W.AL = W.main.AL;
    return W;
  }

  // ---------------------------------------------------------------------
  // 기록 쓰기 — 앱 길 · 기기 길
  // ---------------------------------------------------------------------
  const rid = () => crypto.randomUUID();
  // 앱이 로그인 토큰으로 쓰는 alarm_events (RLS 통과). 같은 번호면 무시(앱 upsert ignoreDuplicates)
  const evApp = (W, k, alarmId, type, at, src = null, o = {}) => app(W.U[k], () => q(
    `insert into public.alarm_events (alarm_id, user_id, event_type, event_at, input_source, snooze_minutes, client_event_id, sequence_no)
     values ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8) on conflict (client_event_id) do nothing returning event_id`,
    [alarmId, W.U[k], type, at, src, o.snooze ?? null, o.id ?? rid(), o.seq ?? 1]));
  // 앱이 꺼진 폰 — alarm-events-device가 받는 조합만, 그 사람 알람일 때만(지워진 알람 · 남의 알람은 서버가 건너뜀)
  const evDev = async (W, k, alarmId, type, at, src = 'BUTTON', cid = rid()) => {
    await su();
    const [a] = await q(`select alarm_type from public.alarms where alarm_id = $1 and user_id = $2`, [alarmId, W.U[k]]);
    if (!a) return { stored: 0, skipped: true };
    if (!deviceEventAllowed(type, src, a.alarm_type)) throw new Error(`기기 길이 안 받는 조합: ${type} · ${src} · ${a.alarm_type}`);
    await svc();
    try {
      const rows = await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at, input_source, client_event_id, sequence_no)
                            values ($1, $2, $3, $4::timestamptz, $5, $6, 1) on conflict (client_event_id) do nothing returning event_id`, [alarmId, W.U[k], type, at, src, cid]);
      return { stored: rows.length, skipped: false };
    } finally { await su(); }
  };
  // 앱이 내 참여 행에 쓰는 출발 · 도착 (위치 감지 · 정정 · 되돌리기)
  const setPt = (W, k, pid, set, params = []) => app(W.U[k], () => q(`update public.appointment_participants set ${set} where participant_id = $1 and user_id = $2 returning departed_at, arrived_at`, [pid, W.U[k], ...params]));
  const pt = async (pid) => { await su(); return (await q(`select departed_at, departed_source, arrived_at, arrived_source, is_late, late_minutes, prepare_started_at from public.appointment_participants where participant_id = $1`, [pid]))[0] ?? null; };
  // 알람 전에 깨어 있던 사람들 — 다른 사람 시험에 끼지 않게 06:30에 [먼저 깼어요]로 확정
  const calm = async (W, ks) => { for (const k of ks) await evApp(W, k, W.AL[k].WAKE, 'WAKE_CONFIRMED', T('06:30'), 'BUTTON'); };

  // ---------------------------------------------------------------------
  // 보기 — 시각마다 각 사람이 보는 그룹 화면 한 칸 = 단계 + 출발 · 도착 시각 + T(trip_visible)
  // ---------------------------------------------------------------------
  const rowsOf = async (W, viewer, at, date = null) => { await su(); return q(`select * from private.group_wake_rows($1, $2, $3::date, $4::timestamptz)`, [W.U[viewer], W.g, date, at]); };
  const cell = (r) => (!r ? '-' : [r.wake_status, r.departed_at && `d${hm(r.departed_at)}`, r.arrived_at && `a${hm(r.arrived_at)}`, r.trip_visible && 'T'].filter(Boolean).join(' '));
  const view = async (W, viewer, at, date = null) => {
    const rows = await rowsOf(W, viewer, at, date);
    return Object.fromEntries(Object.keys(W.U).map((k) => [k, cell(rows.find((r) => r.user_id === W.U[k]))]));
  };
  // 이 세계의 기본 보임 규칙: 나는 늘 보임, C는 기상 공유 끔이라 남에게 안 보임, D는 B에게 숨김
  const visible = (W, v, k) => v === k || (k !== 'C' && !(W.hide && k === 'D' && v === 'B'));
  // states = { A: '칸' | ['내가 볼 때', '남이 볼 때'], ... } — 보임 규칙을 씌워 네 사람 시점을 한꺼번에 대조
  const seeAll = async (W, at, states, date = null) => {
    const bad = {};
    for (const v of LET) {
      const got = await view(W, v, at, date);
      for (const k of LET) {
        const s = states[k];
        const want = !visible(W, v, k) ? '-' : Array.isArray(s) ? (v === k ? s[0] : s[1]) : s;
        if (got[k] !== want) (bad[`${v}가 보는 ${k}`] ??= { got: got[k], want });
      }
    }
    return Object.keys(bad).length ? bad : true;
  };

  // ---------------------------------------------------------------------
  // 신호 · 푸시 대상
  // ---------------------------------------------------------------------
  const sigN = async (W) => { await su(); return (await q(`select count(*)::int as n from realtime.messages where topic = $1`, [`group:${W.g}:wake`]))[0].n; };
  const sigDates = async (W) => { await su(); return (await q(`select distinct payload->>'date' as d from realtime.messages where topic = $1`, [`group:${W.g}:wake`])).map((r) => r.d); };
  const letters = (W, ids) => ids.map((u) => W.who[u]);

  // wake-check 5분 배치 한 번 — _shared/wake.ts와 같은 순서(MISSED 기록 → 친구 알림 대상 정하기), 푸시 전송만 뺌. 다른 세계의 사람은 건드리지 않음
  //   self = 이번에 새로 MISSED가 기록돼 '기상 확인이 안 됐어요'를 받는 본인, nudge = '깨워 볼까요?' 받는 사람>안 일어난 사람, up = 후속 '일어났어요'
  const wakeCheck = async (W, at) => {
    await svc();
    try {
      const mine = new Set(Object.values(W.U));
      const found = (await q(`select * from public.find_missed_wake_alarms($1::timestamptz, 24)`, [at])).filter((r) => mine.has(r.user_id));
      const self = [];
      for (const r of found) {
        const ins = await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at, sequence_no, client_event_id, input_source)
                             values ($1, $2, 'MISSED', $3::timestamptz, 1, $4, null) on conflict (client_event_id) do nothing returning event_id`, [r.alarm_id, r.user_id, r.missed_at, r.event_key]);
        if (ins.length) self.push(r.user_id);
      }
      const nudges = (await q(`select kind, recipient_id, sleeper_id from public.claim_wake_nudges($1::timestamptz)`, [at])).filter((r) => mine.has(r.sleeper_id));
      const pairs = (kind) => nudges.filter((r) => r.kind === kind).map((r) => `${W.who[r.recipient_id]}>${W.who[r.sleeper_id]}`).sort();
      return { self: letters(W, self).sort(), nudge: pairs('NUDGE'), up: pairs('UP') };
    } finally { await su(); }
  };
  // 깨우기 (notify의 plan_wake_ping) — from이 to를 깨움
  const ping = async (W, from, to, at) => {
    await svc();
    try { return (await q(`select public.plan_wake_ping($1, $2, true, $3::timestamptz, $4) as r`, [W.U[from], W.U[to], at, W.g]))[0].r; } finally { await su(); }
  };
  const pingS = async (W, from, to, at) => { const r = await ping(W, from, to, at); return r.status === 'OK' ? `OK ${r.count}` : r.status; };

  // 한 단계 — act를 하고, 신호 증가 수 · 네 사람이 보는 그룹 화면 · 덧붙인 확인을 대조
  const step = (name, W, { at, act, sig, see, then, date }) => check(name, async () => {
    const n0 = await sigN(W);
    const res = act ? await act() : undefined;
    await su();
    const out = {};
    const dn = (await sigN(W)) - n0;
    if (sig != null && dn !== sig) out.신호 = { got: dn, want: sig };
    if (see) { const bad = await seeAll(W, at, see, date); if (bad !== true) out.화면 = bad; }
    if (then) { const r = await then(res); if (r !== true) out.덧붙임 = r; }
    return Object.keys(out).length ? out : true;
  });

  // =====================================================================
  // S-MAIN — 하루 한 줄기 (S01 · S04 · S06 · S07 · S14 · S21 · S23 · 기상 → 출발 → 도착 → 다음 날)
  //   A = 기상 + 출발 · 도착 / B = 기상만 / C = 끔 / D = 기상 + 출발 · 도착이지만 B에게 숨김. 약속 10:00
  // =====================================================================
  {
    const W = await world();
    const S = (o) => ({ A: 'SCHEDULED T', B: 'SCHEDULED', C: 'SCHEDULED', D: 'SCHEDULED T', ...o });

    await step('MAIN 06:00 · 전날 밤 약속, 아침 전 — 모두 취침 중(SCHEDULED), 출발 · 도착 공유를 켠 A · D만 trip_visible(T), C는 본인에게만 보임, D는 B에게 안 보임', W, { at: T('06:00'), see: S({}), sig: 0 });
    await step('MAIN 07:00 · A 알람이 울림 — 모두에게 RINGING, 새로 고침 신호 1번(날짜 = 오늘)', W, {
      at: T('07:00:30'), act: () => evApp(W, 'A', W.AL.A.WAKE, 'TRIGGERED', T('07:00')), sig: 1, see: S({ A: 'RINGING T' }),
      then: async () => eq(await sigDates(W), [TODAY]),
    });
    await step('MAIN 07:03 · A가 5분 미루기(BUTTON) — 단계는 그대로 RINGING, 신호 1번', W, { at: T('07:04'), act: () => evApp(W, 'A', W.AL.A.WAKE, 'SNOOZED', T('07:03'), 'BUTTON', { snooze: 5 }), sig: 1, see: S({ A: 'RINGING T' }) });
    await step('MAIN 07:08~07:09 · 다시 울림 → A가 해제(BUTTON) — DISMISSED, 신호 2번(울림 · 해제)', W, {
      at: T('07:10'),
      act: async () => { await evApp(W, 'A', W.AL.A.WAKE, 'TRIGGERED', T('07:08'), null, { seq: 2 }); await evApp(W, 'A', W.AL.A.WAKE, 'DISMISSED', T('07:09'), 'BUTTON'); },
      sig: 2, see: S({ A: 'DISMISSED T' }),
    });
    await step('MAIN 07:10~07:12 · B가 울림 · 해제 · [일어났어요](BUTTON) — 모두에게 바로 CONFIRMED(20분 안 기다림), 신호 3번', W, {
      at: T('07:13'),
      act: async () => { await evApp(W, 'B', W.AL.B.WAKE, 'TRIGGERED', T('07:10')); await evApp(W, 'B', W.AL.B.WAKE, 'DISMISSED', T('07:11'), 'BUTTON'); await evApp(W, 'B', W.AL.B.WAKE, 'WAKE_CONFIRMED', T('07:12'), 'BUTTON'); },
      sig: 3, see: S({ A: 'DISMISSED T', B: 'CONFIRMED' }),
    });
    await step('MAIN 07:19 · A가 해제 10분 뒤 앱이 꺼진 채 자동 판정(USAGE, 기기 길) — 본인은 바로 CONFIRMED, 남에게는 20분 뒤(07:39)까지 DISMISSED, 신호 0번', W, {
      at: T('07:20'), act: () => evDev(W, 'A', W.AL.A.WAKE, 'WAKE_CONFIRMED', T('07:19'), 'USAGE'), sig: 0,
      see: S({ A: ['CONFIRMED T', 'DISMISSED T'], B: 'CONFIRMED' }),
    });
    await step('MAIN 07:20~07:22 · C(기상 공유 끔)가 울림 · 해제 · 확인 — C 본인에게만 CONFIRMED, 다른 사람 화면에는 줄이 없고 신호도 0번', W, {
      at: T('07:23'),
      act: async () => { await evApp(W, 'C', W.AL.C.WAKE, 'TRIGGERED', T('07:20')); await evApp(W, 'C', W.AL.C.WAKE, 'DISMISSED', T('07:21'), 'BUTTON'); await evApp(W, 'C', W.AL.C.WAKE, 'WAKE_CONFIRMED', T('07:22'), 'BUTTON'); },
      sig: 0, see: S({ A: ['CONFIRMED T', 'DISMISSED T'], B: 'CONFIRMED', C: 'CONFIRMED' }),
    });
    await step('MAIN 07:30~07:31 · D가 울림 → 해제하고 다시 잠 — A · C에게 DISMISSED(B는 숨김이라 줄 없음), 신호 2번', W, {
      at: T('07:35'),
      act: async () => { await evApp(W, 'D', W.AL.D.WAKE, 'TRIGGERED', T('07:30')); await evApp(W, 'D', W.AL.D.WAKE, 'DISMISSED', T('07:31'), 'BUTTON'); },
      sig: 2, see: S({ A: ['CONFIRMED T', 'DISMISSED T'], B: 'CONFIRMED', C: 'CONFIRMED', D: 'DISMISSED T' }),
    });
    await step('MAIN 07:39:01 · 20분이 지나 A의 자동 판정이 남에게도 CONFIRMED로 보임 — 그 순간에 오는 신호는 없음(G6은 아래 knownGap)', W, {
      at: T('07:39:01'), sig: 0, see: S({ B: 'CONFIRMED', C: 'CONFIRMED', A: 'CONFIRMED T', D: 'DISMISSED T' }),
    });
    await step('MAIN 07:59 · D 놓침 시각(알람 07:30 + 30분) 직전 — 아직 DISMISSED', W, { at: T('07:59'), see: S({ A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'DISMISSED T' }) });
    await step('MAIN 08:00 · 기록이 없어도 읽을 때 계산으로 D가 MISSED(본인 포함 모두)', W, { at: T('08:00'), see: S({ A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'MISSED T' }) });
    await step('MAIN 08:02 · wake-check — D에게만 본인 놓침 푸시, MISSED 기록 신호 1번, 친구 알림은 아직 없음(10분 뒤)', W, {
      at: T('08:02'), act: () => wakeCheck(W, T('08:02')), sig: 1, then: (r) => eq(r, { self: ['D'], nudge: [], up: [] }),
      see: S({ A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'MISSED T' }),
    });
    await step('MAIN 08:05 · wake-check를 또 돌려도 본인 푸시는 한 번뿐(같은 번호 충돌 무시), 신호도 안 늘어남', W, { at: T('08:05'), act: () => wakeCheck(W, T('08:05')), sig: 0, then: (r) => eq(r, { self: [], nudge: [], up: [] }) });
    await step('MAIN 08:09 · MISSED 10분 전 — 친구 알림 없음', W, { at: T('08:09'), act: () => wakeCheck(W, T('08:09')), then: (r) => eq(r, { self: [], nudge: [], up: [] }) });
    await step('MAIN 08:10 · MISSED 10분 뒤 — "깨워 볼까요?"는 D 기상이 보이는 A · C에게만(B는 D가 숨겨서 제외), 한 번뿐', W, {
      at: T('08:10'), act: async () => [await wakeCheck(W, T('08:10')), await wakeCheck(W, T('08:15'))],
      then: ([a, b]) => eq([a, b], [{ self: [], nudge: ['A>D', 'C>D'], up: [] }, { self: [], nudge: [], up: [] }]),
    });
    await step('MAIN 08:20 · D가 H08에서 [일어났어요](BUTTON) — 서버는 놓침 뒤에도 확인을 받아 CONFIRMED, 신호 1번', W, {
      at: T('08:21'), act: () => evApp(W, 'D', W.AL.D.WAKE, 'WAKE_CONFIRMED', T('08:20'), 'BUTTON'), sig: 1,
      see: S({ A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED T' }),
    });
    await step('MAIN 08:25 · wake-check — 늦게 확인했으니 "깨워 볼까요?"를 받았던 A · C에게 후속 "일어났어요" 한 번', W, {
      at: T('08:25'), act: async () => [await wakeCheck(W, T('08:25')), await wakeCheck(W, T('08:30'))],
      then: ([a, b]) => eq([a, b], [{ self: [], nudge: [], up: ['A>D', 'C>D'] }, { self: [], nudge: [], up: [] }]),
    });
    await step('MAIN 08:50 · A 준비 알람 해제(BUTTON) — 서버는 준비 시작만 적고(본인 값), 친구 화면 · 신호는 그대로(D59 준비는 본인만)', W, {
      at: T('08:51'), act: () => evApp(W, 'A', W.AL.A.PREPARE, 'DISMISSED', T('08:50'), 'BUTTON'), sig: 0,
      see: S({ A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED T' }),
      then: async () => { const p = await pt(W.P.A); return iso(p.prepare_started_at) === iso(T('08:50')) ? true : p; },
    });
    await step('MAIN 09:21 · A가 앱이 꺼진 채 [출발했어요](알림 버튼, 기기 길) — 서버가 바로 출발로 반영, 모두에게 d09:21, 신호 1번 · trip_appointment_at = 10:00', W, {
      at: T('09:22'), act: () => evDev(W, 'A', W.AL.A.DEPARTURE, 'ACKNOWLEDGED', T('09:21')), sig: 1,
      see: S({ A: 'CONFIRMED d09:21 T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED T' }),
      then: async () => eq(iso((await rowsOf(W, 'B', T('09:22'))).find((r) => r.user_id === W.U.A).trip_appointment_at), iso(T('10:00'))),
    });
    await step('MAIN 09:24~09:28 · B(출발 · 도착 공유 끔) · C(기상 공유 끔)도 [출발했어요] — 서버에는 기록되지만 화면은 CONFIRMED에서 멈추고 신호 0번(S21)', W, {
      at: T('09:29'),
      act: async () => { await evDev(W, 'B', W.AL.B.DEPARTURE, 'ACKNOWLEDGED', T('09:24')); await evDev(W, 'C', W.AL.C.DEPARTURE, 'ACKNOWLEDGED', T('09:28')); },
      sig: 0, see: S({ A: 'CONFIRMED d09:21 T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED T' }),
      then: async () => (await pt(W.P.B)).departed_at && (await pt(W.P.C)).departed_at ? true : '서버에 출발이 안 남음',
    });
    await step('MAIN 09:30 · D가 위치로 출발 감지(LOCATION, 앱이 참여 행에 씀) — A · C에게 d09:30, B는 D가 안 보임, 신호 1번', W, {
      at: T('09:31'), act: () => setPt(W, 'D', W.P.D, `departed_at = '${T('09:30')}', departed_source = 'LOCATION'`), sig: 1,
      see: S({ A: 'CONFIRMED d09:21 T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED d09:30 T' }),
    });
    await step('MAIN 09:55 · A [도착했어요](ARRIVAL_CONFIRMED, 기기 길) — d09:21 a09:55, 지각 아님, 신호 1번', W, {
      at: T('09:56'), act: () => evDev(W, 'A', W.AL.A.ARRIVE, 'ARRIVAL_CONFIRMED', T('09:55')), sig: 1,
      see: S({ A: 'CONFIRMED d09:21 a09:55 T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED d09:30 T' }),
      then: async () => { const p = await pt(W.P.A); return p.is_late === false && p.arrived_source === 'BUTTON' ? true : p; },
    });
    await step('MAIN 10:02~10:07 · B 도착(공유 끔 — 화면 그대로, 신호 0), D 위치 도착(지각 7분, 앱이 직접 씀) — D만 a10:07, 신호 1번', W, {
      at: T('10:08'),
      act: async () => { await evDev(W, 'B', W.AL.B.ARRIVE, 'ARRIVAL_CONFIRMED', T('10:02')); await setPt(W, 'D', W.P.D, `arrived_at = '${T('10:07')}', arrived_source = 'LOCATION', is_late = true, late_minutes = 7`); },
      sig: 1, see: S({ A: 'CONFIRMED d09:21 a09:55 T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED d09:30 a10:07 T' }),
    });
    await step('MAIN 11:00 · 하루 끝 — 최종 화면. 지각 여부 · 출처는 화면 값에 없음(시각만)', W, {
      at: T('11:00'), sig: 0, see: S({ A: 'CONFIRMED d09:21 a09:55 T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED d09:30 a10:07 T' }),
      then: async () => { const r = (await rowsOf(W, 'A', T('11:00')))[0]; return ['is_late', 'departed_source', 'late_minutes'].some((c) => c in r) ? '화면 값에 지각 · 출처가 있음' : true; },
    });
    await step('MAIN 다음 날 06:00 · 어제 화면(날짜 = 어제)은 어제 끝 상태 그대로, 날짜 없이 열면 그 그룹 약속이 없는 날이라 줄 없음', W, {
      at: T('06:00', 1), date: TODAY,
      see: S({ A: 'CONFIRMED d09:21 a09:55 T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED d09:30 a10:07 T' }),
      then: async () => { const n = {}; for (const v of LET) n[v] = (await rowsOf(W, v, T('06:00', 1))).length; return eq(n, { A: 0, B: 0, C: 0, D: 0 }); },
    });
    await step('MAIN 다음 날 약속(10:00)이 생기면 — 어제 확정 · 출발 · 도착이 안 새고 모두 처음 상태(SCHEDULED)로 시작', W, {
      at: T('06:00', 1),
      act: () => addAppt(W, { at: T('10:00', 1), wake: Object.fromEntries(LET.map((k) => [k, T(WAKE_AT[k], 1)])), prep: T('08:50', 1), dep: T('09:20', 1), title: '다음 날 약속' }),
      see: S({}),
    });
    await check('S-API · 공개 함수 get_group_wake · get_group_wake_status가 같은 시각의 본문(group_wake_rows)과 같은 줄을 돌려줌 — 단계 · 출발 · 도착 · trip_visible, 남의 줄은 울린 시각 · 미루기 · 해제 · 미확인 칸이 비어 있음', async () => {
      const bad = [];
      for (const v of LET) {
        await as(W.U[v]);
        const pub = await q(`select * from public.get_group_wake($1, $2::date)`, [W.g, TODAY]);
        const pubSt = await q(`select * from public.get_group_wake_status($1, $2::date)`, [W.g, TODAY]);
        await su();
        const priv = await q(`select * from private.group_wake_rows($1, $2, $3::date, now())`, [W.U[v], W.g, TODAY]);
        const sig = (r) => [r.user_id, r.wake_status, iso(r.departed_at), iso(r.arrived_at), r.trip_visible].join('|');
        if (JSON.stringify(pub.map(sig).sort()) !== JSON.stringify(priv.map(sig).sort())) bad.push({ v, why: 'get_group_wake가 본문과 다름' });
        if (JSON.stringify(pubSt.map(sig).sort()) !== JSON.stringify(priv.map(sig).sort())) bad.push({ v, why: 'get_group_wake_status가 본문과 다름' });
        const others = pubSt.filter((r) => !r.is_me);
        if (others.some((r) => r.rang_at != null || r.snooze_count !== 0 || r.dismissed_at != null || r.missed_at != null)) bad.push({ v, why: '남의 줄에 내 줄 전용 칸이 참' });
        if (!['rang_at', 'snooze_count', 'dismissed_at', 'missed_at'].every((c) => c in pubSt[0]) || ['rang_at', 'snooze_count', 'dismissed_at', 'missed_at'].some((c) => c in pub[0])) bad.push({ v, why: '칸 모양이 다름' });
      }
      return bad.length ? bad : true;
    });

    // ----- G6: 자동 판정 확정은 20분 뒤 남에게 공개되는데 그 시각에 새로 고침 신호가 없음
    //   +20분 시점에는 DB에 쓰는 일이 없어 신호를 시각별로 나눠 볼 수 없음(PGlite에는 시계 · 스케줄러가 없고 기록 시각은 시험 시계가 아님).
    //   그래서 가장 가까운 확인 = 그 시각에 신호를 낼 수 있는 장치(pg_cron 작업)가 있는가. 기록 직후 신호는 그 시점에 친구 화면이 안 바뀌어(DISMISSED로 숨김) 충분하지 않음
    await knownGap('G6', '자동 판정(USAGE) 기상이 친구에게 공개되는 +20분 시점에 새로 고침 신호가 나가야 함 — 지금은 기록 직후도, +20분에 신호를 낼 pg_cron 작업도 없어 친구가 화면을 다시 열어야 보임 (MAIN 07:19 구간)', async () => {
      const w = await world();
      await calm(w, ['B', 'C', 'D']);
      await evApp(w, 'A', w.AL.A.WAKE, 'TRIGGERED', T('07:00'));
      await evApp(w, 'A', w.AL.A.WAKE, 'DISMISSED', T('07:02'), 'BUTTON');
      const n0 = await sigN(w);
      await evDev(w, 'A', w.AL.A.WAKE, 'WAKE_CONFIRMED', T('07:12'), 'USAGE');
      const atRecord = (await sigN(w)) - n0;
      const jobs = await q(`select jobname from cron.job where command ilike '%wake%signal%' or command ilike '%realtime.send%' or jobname ilike '%wake%signal%'`);
      return jobs.length > 0 ? true : { '기록 직후 신호 수(친구 화면은 아직 안 바뀜)': atRecord, '+20분에 신호를 낼 cron 작업': 0 };
    });
  }

  // =====================================================================
  // S01 — 자동 판정(누워서 폰, 앱 꺼짐) 20분 공개 규칙 · 깨우기 응답 · 놓침과의 관계
  // =====================================================================
  {
    const W = await world();
    await calm(W, ['B', 'C', 'D']);
    const S = (a) => ({ A: a, B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED T' });
    await step('S01 · 07:12 앱이 꺼진 채 USAGE 확정 — 본인은 CONFIRMED, B가 보는 A는 DISMISSED, 깨우기는 "지금은 깨울 수 없어요"(OFF — 확인이 숨겨진 20분 동안 ALREADY_UP으로 드러나지 않게)', W, {
      at: T('07:13'),
      act: async () => {
        await evApp(W, 'A', W.AL.A.WAKE, 'TRIGGERED', T('07:00'));
        await evApp(W, 'A', W.AL.A.WAKE, 'DISMISSED', T('07:02'), 'BUTTON');
        await evDev(W, 'A', W.AL.A.WAKE, 'WAKE_CONFIRMED', T('07:12'), 'USAGE');
        return pingS(W, 'B', 'A', T('07:13'));
      },
      see: S(['CONFIRMED T', 'DISMISSED T']), then: (r) => eq(r, 'OFF'),
    });
    await step('S01 · 07:31:59 알람 + 30분이 지나도 확인이 대기 중이면 MISSED로 안 봄(DISMISSED), wake-check도 기록 · 푸시 없음', W, {
      at: T('07:31:59'), act: () => wakeCheck(W, T('07:31')), see: S(['CONFIRMED T', 'DISMISSED T']), then: (r) => eq(r, { self: [], nudge: [], up: [] }),
    });
    await step('S01 · 07:32:00 확정 20분 뒤 — 남에게도 CONFIRMED(확인 시각 = 07:12), 이제 깨우기는 ALREADY_UP', W, {
      at: T('07:32'), see: S('CONFIRMED T'),
      act: async () => pingS(W, 'B', 'A', T('07:33')),
      then: async (r) => { const t = (await rowsOf(W, 'B', T('07:32'))).find((x) => x.user_id === W.U.A); return eq([r, iso(t.wake_confirmed_at)], ['ALREADY_UP', iso(T('07:12'))]); },
    });

    // 변형: 저녁 직접 입력(MANUAL)은 그룹 화면 · 신호에 영향 없음
    const W2 = await world();
    await calm(W2, ['B', 'C', 'D']);
    await step('S01b · 해제 뒤 확인 없이 놓침(07:35 wake-check로 본인 푸시) → 밤 22:00 직접 입력(MANUAL) 확정 — 그룹 화면은 MISSED 그대로, 신호 없음, 하루 기록에는 22:00이 적힘', W2, {
      at: T('22:05'),
      act: async () => {
        await evApp(W2, 'A', W2.AL.A.WAKE, 'TRIGGERED', T('07:00'));
        await evApp(W2, 'A', W2.AL.A.WAKE, 'DISMISSED', T('07:02'), 'BUTTON');
        const r = await wakeCheck(W2, T('07:35'));
        const n0 = await sigN(W2);
        await evApp(W2, 'A', W2.AL.A.WAKE, 'WAKE_CONFIRMED', T('22:00'), 'MANUAL');
        return { r, 신호증가: (await sigN(W2)) - n0 };
      },
      see: { A: 'MISSED T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED T' },
      then: async ({ r, 신호증가 }) => {
        const [dr] = await q(`select wake_confirmed_at from public.daily_records where user_id = $1 and record_date = $2::date`, [W2.U.A, TODAY]);
        return eq([r.self, 신호증가, iso(dr?.wake_confirmed_at)], [['A'], 0, iso(T('22:00'))]);
      },
    });
  }

  // =====================================================================
  // S04 — 먼저 깼어요(알람 전 [일어났어요]) 가 친구에게 · 놓침 · 출발에 어떻게 닿는가
  // =====================================================================
  {
    const W = await world();
    await calm(W, ['B', 'C', 'D']);
    const S = (o) => ({ A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED T', ...o });
    await step('S04 · 06:40 알람(07:00) 전에 [먼저 깼어요](BUTTON) — 모두에게 바로 CONFIRMED, 신호 1번(그룹에는 바로 일어났어요, D61 · 7-20)', W, {
      at: T('06:41'), act: () => evApp(W, 'A', W.AL.A.WAKE, 'WAKE_CONFIRMED', T('06:40'), 'BUTTON'), sig: 1, see: S({}),
    });
    await step('S04 · 07:31 알람 시각에 울림 기록이 안 올라온 채 30분이 지나도 — 놓침 기록 · 본인 푸시 · 친구 알림 없음, 화면 CONFIRMED 유지', W, {
      at: T('07:31'), act: async () => [await wakeCheck(W, T('07:31')), await wakeCheck(W, T('07:45'))], sig: 0, see: S({}),
      then: ([a, b]) => eq([a, b], [{ self: [], nudge: [], up: [] }, { self: [], nudge: [], up: [] }]),
    });
    await step('S04b · 앱이 열려 07:00 울림 · 07:01 해제 기록이 뒤늦게 올라와도 — 여전히 CONFIRMED, 놓침 없음(확정이 그날 것으로 셈)', W, {
      at: T('08:00'),
      act: async () => { await evApp(W, 'A', W.AL.A.WAKE, 'TRIGGERED', T('07:00')); await evApp(W, 'A', W.AL.A.WAKE, 'DISMISSED', T('07:01'), 'BUTTON'); return wakeCheck(W, T('08:05')); },
      see: S({}), then: (r) => eq(r, { self: [], nudge: [], up: [] }),
    });
    await step('S04c · 먼저 깬 뒤에도 준비 · 출발은 평소대로 — 09:21 출발 알림 버튼이 서버에 d09:21로 반영', W, {
      at: T('09:22'), act: () => evDev(W, 'A', W.AL.A.DEPARTURE, 'ACKNOWLEDGED', T('09:21')), sig: 1, see: S({ A: 'CONFIRMED d09:21 T' }),
    });
  }

  // =====================================================================
  // S06 — 다시 잠(해제 · 사용 없음 · 무응답) → 놓침 30분 · 본인 푸시 · 친구 알림 대상(알림 끔 · 깨우기 받기 끔 · 약속 시작 뒤)
  // =====================================================================
  {
    const asleep = async (W) => {
      await calm(W, ['A', 'B', 'C']);
      await evApp(W, 'D', W.AL.D.WAKE, 'TRIGGERED', T('07:30'));
      await evApp(W, 'D', W.AL.D.WAKE, 'DISMISSED', T('07:31'), 'BUTTON');
    };
    const S = (d) => ({ A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: d });
    const W = await world();
    await asleep(W);
    await step('S06 · 07:59 해제만 하고 다시 잠 — 알람 + 30분 직전까지 DISMISSED, 08:00 정각에 MISSED(읽을 때 계산)', W, { at: T('07:59'), see: S('DISMISSED T') });
    await step('S06 · 08:00 MISSED', W, { at: T('08:00'), see: S('MISSED T') });
    await step('S06 · 08:02 wake-check — 본인(D)만 놓침 푸시, 다음 5분 배치에서는 다시 안 감', W, {
      at: T('08:02'), act: async () => [await wakeCheck(W, T('08:02')), await wakeCheck(W, T('08:07'))], sig: 1,
      then: ([a, b]) => eq([a, b], [{ self: ['D'], nudge: [], up: [] }, { self: [], nudge: [], up: [] }]),
    });
    await step('S06 · 08:09 → 08:10 친구 알림은 MISSED 10분 뒤부터, B는 D가 숨겨서 제외 (A · C만)', W, {
      at: T('08:10'), act: async () => [await wakeCheck(W, T('08:09')), await wakeCheck(W, T('08:10'))],
      then: ([a, b]) => eq([a, b], [{ self: [], nudge: [], up: [] }, { self: [], nudge: ['A>D', 'C>D'], up: [] }]),
    });

    const W2 = await world();
    await asleep(W2);
    await step('S06b · A가 이 그룹 알림 끄기(notifications_off) — 친구 알림 대상에서 A 빠짐(C만), 본인 놓침 푸시는 그대로', W2, {
      at: T('08:10'),
      act: async () => {
        await app(W2.U.A, () => q(`update public.group_members set notifications_off = true where group_id = $1 and user_id = $2`, [W2.g, W2.U.A]));
        return [await wakeCheck(W2, T('08:02')), await wakeCheck(W2, T('08:10'))];
      },
      then: ([a, b]) => eq([a, b], [{ self: ['D'], nudge: [], up: [] }, { self: [], nudge: ['C>D'], up: [] }]),
    });

    const W3 = await world();
    await asleep(W3);
    await step('S06c · D가 [깨우기 받기] 끄기 — 친구에게 "깨워 볼까요?"를 안 보냄(깨울 수 없는 사람을 깨우라고 안 함), 본인 푸시는 감', W3, {
      at: T('08:10'),
      act: async () => {
        await app(W3.U.D, () => q(`update public.profiles set wake_ping_enabled = false where user_id = $1`, [W3.U.D]));
        return [await wakeCheck(W3, T('08:02')), await wakeCheck(W3, T('08:10'))];
      },
      then: ([a, b]) => eq([a, b], [{ self: ['D'], nudge: [], up: [] }, { self: [], nudge: [], up: [] }]),
    });

    const W4 = await world();
    await asleep(W4);
    await step('S06d · 배치가 약속(10:00) 시작 뒤에야 도는 경우(10:30) — 친구 알림 안 보냄(이미 시작한 약속에 깨우라고 하지 않음)', W4, {
      at: T('10:30'), act: () => wakeCheck(W4, T('10:30')), then: (r) => eq(r.nudge, []),
    });
  }

  // =====================================================================
  // S07 — 끄지 않고 울림이 끝남(해제 기록이 없음) → 놓침 · 푸시 · 서버의 확인 길
  // =====================================================================
  {
    const W = await world();
    await calm(W, ['A', 'B', 'C']);
    const S = (d) => ({ A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: d });
    await step('S07 · 울림 기록(TRIGGERED)만 있고 해제는 없음 — 07:59까지 RINGING(친구 화면에도), 08:00부터 MISSED', W, {
      at: T('07:59'), act: () => evApp(W, 'D', W.AL.D.WAKE, 'TRIGGERED', T('07:30')), see: S('RINGING T'),
      then: async () => eq(await view(W, 'A', T('08:00')), { A: 'CONFIRMED T', B: 'CONFIRMED', C: '-', D: 'MISSED T' }),
    });
    await step('S07 · 08:02 wake-check → 놓침 푸시는 D에게, 08:10에 친구 알림 A · C', W, {
      at: T('08:10'), act: async () => [await wakeCheck(W, T('08:02')), await wakeCheck(W, T('08:10'))], sig: 1,
      then: ([a, b]) => eq([a, b], [{ self: ['D'], nudge: [], up: [] }, { self: [], nudge: ['A>D', 'C>D'], up: [] }]),
    });
    await step('S07 · 푸시를 눌러 연 H08에서 [일어났어요](BUTTON) — 해제 기록이 없어도 서버는 확인을 받음(앱 H08 막다른 화면 G1은 서버 밖), CONFIRMED + 후속 "일어났어요"', W, {
      at: T('08:31'), act: async () => { await evApp(W, 'D', W.AL.D.WAKE, 'WAKE_CONFIRMED', T('08:30'), 'BUTTON'); return wakeCheck(W, T('08:35')); }, sig: 1,
      see: S('CONFIRMED T'), then: (r) => eq(r, { self: [], nudge: [], up: ['A>D', 'C>D'] }),
    });

    const W2 = await world();
    await calm(W2, ['A', 'B', 'C']);
    await step('S07b · 앱이 꺼져 울림 기록이 하나도 못 올라온 채 — 친구 화면은 알람(07:30) + 30분(08:00)까지 SCHEDULED(7-마), 그 뒤 MISSED + 본인 푸시', W2, {
      at: T('07:45'), see: { A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'SCHEDULED T' },
      then: async () => eq([(await view(W2, 'A', T('07:59'))).D, (await view(W2, 'A', T('08:00'))).D, await wakeCheck(W2, T('08:01'))], ['SCHEDULED T', 'MISSED T', { self: ['D'], nudge: [], up: [] }]),
    });
  }

  // =====================================================================
  // S08 — 미루기가 놓침 계산을 미는가 (G12)
  // =====================================================================
  {
    const W = await world();
    await calm(W, ['B', 'C', 'D']);
    const S = (a) => ({ A: a, B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED T' });
    await step('S08 · 미루기 두 번(07:03 · 07:08:30, 각 5분)이 올라온 채 — 놓침 시각이 마지막 미루기 끝(07:13:30) + 30분 = 07:43:30으로 밀림. 07:43 RINGING, 07:44 MISSED', W, {
      at: T('07:43'),
      act: async () => {
        await evApp(W, 'A', W.AL.A.WAKE, 'TRIGGERED', T('07:00'));
        await evApp(W, 'A', W.AL.A.WAKE, 'SNOOZED', T('07:03'), 'BUTTON', { snooze: 5 });
        await evApp(W, 'A', W.AL.A.WAKE, 'TRIGGERED', T('07:08'), null, { seq: 2 });
        await evApp(W, 'A', W.AL.A.WAKE, 'SNOOZED', T('07:08:30'), 'BUTTON', { snooze: 5 });
        await evApp(W, 'A', W.AL.A.WAKE, 'TRIGGERED', T('07:13'), null, { seq: 3 });
        return wakeCheck(W, T('07:31'));
      },
      see: S('RINGING T'), then: (r) => eq(r, { self: [], nudge: [], up: [] }),
    });
    await step('S08 · 07:44 MISSED + wake-check가 그때 본인 푸시', W, {
      at: T('07:44'), act: () => wakeCheck(W, T('07:44')), see: S('MISSED T'), then: (r) => eq(r.self, ['A']),
    });

    // 앱을 안 열고 폰에서만 미룬 날 — SNOOZED가 서버에 없음
    const W2 = await world();
    await calm(W2, ['B', 'C', 'D']);
    await check('S08b · (현재 동작 기록) 앱을 안 열고 폰에서만 미룬 날 — 서버에는 미루기가 없어 07:30(알람 + 30분)에 MISSED로 기록되고 본인 놓침 푸시가 나감(폰은 07:43까지 미루는 중)', async () => {
      const r = await wakeCheck(W2, T('07:31'));
      return eq(r, { self: ['A'], nudge: [], up: [] });
    });
    await knownGap('G12', '앱을 안 열고 미룬 사람의 SNOOZED가 07:35에 늦게 올라오면 이미 적힌 MISSED가 풀려 07:36 그룹 화면이 MISSED가 아니어야 함(미루는 중) — 지금은 MISSED 기록이 남아 단계가 MISSED로 굳음', async () => {
      await evApp(W2, 'A', W2.AL.A.WAKE, 'SNOOZED', T('07:03'), 'BUTTON', { snooze: 5 });
      await evApp(W2, 'A', W2.AL.A.WAKE, 'SNOOZED', T('07:08:30'), 'BUTTON', { snooze: 5 });
      const v = await view(W2, 'B', T('07:36'));
      return v.A !== 'MISSED T' ? true : { 'B가 보는 A(07:36)': v.A, 'due 계산': '마지막 미루기 끝 07:13:30 + 30분 = 07:43:30' };
    });
  }

  // =====================================================================
  // S11 — 자정 넘김(23:50 알람 · 00:10 확인): 하루 기록 한 곳 (G14), 그룹 화면의 날
  // =====================================================================
  {
    const W = await world({ at: T('00:30', 1), wake: { A: T('23:50'), B: T('23:55'), C: T('23:55'), D: T('23:55') }, prep: T('23:58'), dep: T('00:10', 1) });
    await check('S11 · 23:50 알람 → 00:10 확인 — 서버는 확인을 "알람이 울린 날"(오늘)의 것으로 셈: 어제 화면(날짜 = 오늘)에서 00:11에 CONFIRMED(약속이 내일 새벽이라 trip은 없음)', async () => {
      await evApp(W, 'A', W.AL.A.WAKE, 'TRIGGERED', T('23:50'));
      await evApp(W, 'A', W.AL.A.WAKE, 'DISMISSED', T('23:51'), 'BUTTON');
      // 앱 realWake.writeDailyRecord: 확인한 시각의 한국 날짜(내일)로 daily_records를 먼저 쓰고 → 이벤트
      await app(W.U.A, () => q(`insert into public.daily_records (user_id, record_date, wake_confirmed_at, wake_reported_at, data_source) values ($1, $2::date, $3::timestamptz, $4::timestamptz, 'ALARM')`, [W.U.A, dayPlus(1), T('00:10', 1), T('23:51')]));
      await evApp(W, 'A', W.AL.A.WAKE, 'WAKE_CONFIRMED', T('00:10', 1), 'BUTTON');
      const v = await view(W, 'B', T('00:11', 1), TODAY);
      return v.A === 'CONFIRMED' ? true : v;
    });
    await knownGap('G14', '23:50 알람 · 00:10 확인이면 하루 기록(daily_records)이 한 곳(알람이 울린 날)에만 생겨야 함 — 지금은 서버 트리거(알람 기준일)와 앱 쓰기(확인한 시각의 한국 날짜)가 두 날에 한 줄씩 만듦', async () => {
      const [n] = await q(`select count(*)::int as n from public.daily_records where user_id = $1 and wake_confirmed_at is not null`, [W.U.A]);
      return n.n === 1 ? true : { 'daily_records 줄 수': n.n, 날짜: (await q(`select record_date::text as d from public.daily_records where user_id = $1 order by record_date`, [W.U.A])).map((r) => r.d) };
    });
    await knownGap('NEW-5', '새벽 약속(00:30) 전날 밤 알람의 확인 직후(00:11) 앱이 날짜 없이 그룹 화면을 열면 A가 CONFIRMED여야 함 — 지금은 날짜가 내일로 바뀌어 알람이 어제인 A · B가 NO_ALARM(알람 없음)으로 보임. 신호가 알려 주는 날짜(어제)로 다시 읽을 때만 맞음', async () => {
      const v = await view(W, 'B', T('00:11', 1));
      return v.A.startsWith('CONFIRMED') ? true : { 'B가 보는 A(날짜 없이 00:11)': v.A, 'B 자신': v.B };
    });
  }

  // =====================================================================
  // S13 — 깨우기 횟수(5분 1번 · 하루 3번) · 일어난 뒤 거절 · 보이지 않는 사람
  // =====================================================================
  {
    const W = await world();
    await calm(W, ['B', 'C', 'D']);
    await evApp(W, 'A', W.AL.A.WAKE, 'TRIGGERED', T('07:00'));
    await check('S13 · B → A 깨우기: 알람 전 NOT_RINGING → 07:05 OK 1 → 07:07 WAIT → 07:10 OK 2 → 07:15 OK 3 → 07:20 DAILY_LIMIT(하루 3번, 5분 대기보다 먼저 판정)', async () => {
      return eq([await pingS(W, 'B', 'A', T('06:50')), await pingS(W, 'B', 'A', T('07:05')), await pingS(W, 'B', 'A', T('07:07')), await pingS(W, 'B', 'A', T('07:10')), await pingS(W, 'B', 'A', T('07:15')), await pingS(W, 'B', 'A', T('07:20'))],
        ['NOT_RINGING', 'OK 1', 'WAIT', 'OK 2', 'OK 3', 'DAILY_LIMIT']);
    });
    await check('S13 · 받은 깨우기 한 줄(my_wake_pings) — A에게 B가 3번 깨운 기록이 최신순으로 옴, C의 깨우기와 섞이지 않음', async () => {
      await ping(W, 'D', 'A', T('07:06'));
      const r = await call(W.U.A, `(select jsonb_agg(jsonb_build_object('s', sender_id, 'at', sent_at) order by sent_at desc, sender_id) from public.my_wake_pings($1::date))`, [TODAY]);
      return eq(r.map((x) => W.who[x.s]), ['B', 'B', 'D', 'B']);   // 07:15 B · 07:10 B · 07:06 D · 07:05 B
    });
    await check('S13 · A가 일어나면(07:25 BUTTON) 깨우기는 ALREADY_UP으로 거절 — 하루 한도가 차 있어도 일어났다는 말이 먼저', async () => {
      await evApp(W, 'A', W.AL.A.WAKE, 'WAKE_CONFIRMED', T('07:25'), 'BUTTON');
      return eq(await pingS(W, 'B', 'A', T('07:30')), 'ALREADY_UP');
    });
    await check('S13 · 보이지 않는 사람은 FORBIDDEN(이유 구분 없음) — 기상 공유 끈 C · B에게 숨긴 D · 자기 자신', async () => {
      return eq([await pingS(W, 'A', 'C', T('07:40')), await pingS(W, 'B', 'D', T('07:40')), await pingS(W, 'B', 'B', T('07:40'))], ['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN']);
    });
  }

  // =====================================================================
  // S14 · S16 · S17 · S19 — 출발 · 도착 (앱 꺼진 채 버튼 · 위치 · 정정 · 도착 감지 놓침)
  // =====================================================================
  {
    const W = await world();
    await calm(W, ['A', 'B', 'C', 'D']);
    const S = (o) => ({ A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED T', ...o });
    const cid = rid();
    await step('S14 · 09:21 앱이 꺼진 채 [출발했어요] — 서버가 바로 반영 · 신호 1번 · 출발 출처 BUTTON, 같은 번호로 앱이 나중에 올려도(upsert) 한 줄 · 신호 그대로', W, {
      at: T('09:22'),
      act: async () => {
        const first = await evDev(W, 'A', W.AL.A.DEPARTURE, 'ACKNOWLEDGED', T('09:21'), 'BUTTON', cid);
        const n1 = await sigN(W);
        const again = await evApp(W, 'A', W.AL.A.DEPARTURE, 'ACKNOWLEDGED', T('09:21'), 'BUTTON', { id: cid });
        return { first, again: again.length, 늘어난신호: (await sigN(W)) - n1 };
      },
      sig: 1, see: S({ A: 'CONFIRMED d09:21 T' }),
      then: async ({ first, again, 늘어난신호 }) => { const p = await pt(W.P.A); return eq([first.stored, again, 늘어난신호, p.departed_source], [1, 0, 0, 'BUTTON']); },
    });

    // S16 이른 위치 출발 거절 — 약속 10:00 · 출발 알람 09:20 → 08:20(알람 − 60분)보다 이르면 조용히 무시
    const W2 = await world();
    await calm(W2, ['A', 'B', 'C', 'D']);
    const S2 = (o) => ({ A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED T', ...o });
    await step('S16 · 06:00 부팅 직후 엉뚱한 위치로 온 "출발" — 서버가 조용히 무시(오류 없음), 화면 · 신호 변화 없음', W2, {
      at: T('06:01'), act: () => setPt(W2, 'A', W2.P.A, `departed_at = '${T('06:00')}', departed_source = 'LOCATION'`), sig: 0, see: S2({}),
      then: async () => eq((await pt(W2.P.A)).departed_at, null),
    });
    await step('S16 · 08:19 (출발 알람 − 61분)은 무시, 08:20 (정확히 −60분)은 받음 — d08:20, 신호 1번', W2, {
      at: T('08:21'),
      act: async () => { await setPt(W2, 'A', W2.P.A, `departed_at = '${T('08:19')}', departed_source = 'LOCATION'`); const mid = (await pt(W2.P.A)).departed_at; await setPt(W2, 'A', W2.P.A, `departed_at = '${T('08:20')}', departed_source = 'LOCATION'`); return mid; },
      sig: 1, see: S2({ A: 'CONFIRMED d08:20 T' }), then: (mid) => eq(mid, null),
    });
    await step('S16 · 받은 뒤에 또 이른 위치 값(06:00)이 오면 앞 값(08:20) 유지, 신호 없음', W2, {
      at: T('08:22'), act: () => setPt(W2, 'A', W2.P.A, `departed_at = '${T('06:00')}', departed_source = 'LOCATION'`), sig: 0, see: S2({ A: 'CONFIRMED d08:20 T' }),
    });
    await step('S16 · 사람이 누른 [출발했어요](BUTTON)는 이른 시각이어도 받음(D, 06:10) — 막는 것은 위치 출발뿐', W2, {
      at: T('08:23'), act: () => setPt(W2, 'D', W2.P.D, `departed_at = '${T('06:10')}', departed_source = 'BUTTON'`), sig: 1, see: S2({ A: 'CONFIRMED d08:20 T', D: 'CONFIRMED d06:10 T' }),
    });

    // S17 감지 정정 → 다음 조회에서 사라짐 → 되돌리기
    const W3 = await world();
    await calm(W3, ['A', 'B', 'C', 'D']);
    const S3 = (o) => ({ A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED T', ...o });
    const depId = rid();
    await step('S17 · 출발(BUTTON 09:21)과 위치 도착(10:03)이 잡힌 뒤', W3, {
      at: T('10:04'),
      act: async () => { await evDev(W3, 'A', W3.AL.A.DEPARTURE, 'ACKNOWLEDGED', T('09:21'), 'BUTTON', depId); await setPt(W3, 'A', W3.P.A, `arrived_at = '${T('10:03')}', arrived_source = 'LOCATION', is_late = false, late_minutes = 0`); },
      sig: 2, see: S3({ A: 'CONFIRMED d09:21 a10:03 T' }),
    });
    await step('S17 · 도착 [아니에요](값 지움) — 다음 조회에서 도착이 사라지고 신호 1번(값이 지워질 때도 신호), 출발은 남음', W3, {
      at: T('10:05'), act: () => setPt(W3, 'A', W3.P.A, `arrived_at = null, arrived_source = null, is_late = false, late_minutes = 0`), sig: 1, see: S3({ A: 'CONFIRMED d09:21 T' }),
    });
    await step('S17 · 출발 [아니에요] — 사라지고 신호 1번. 폰이 같은 알림 버튼 기록(같은 번호)을 다시 올려도 출발이 되살아나지 않음(번호 충돌 무시 → 트리거 안 탐)', W3, {
      at: T('10:06'),
      act: async () => { await setPt(W3, 'A', W3.P.A, `departed_at = null, departed_source = null`); const again = await evDev(W3, 'A', W3.AL.A.DEPARTURE, 'ACKNOWLEDGED', T('09:21'), 'BUTTON', depId); return again.stored; },
      sig: 1, see: S3({}), then: (stored) => eq(stored, 0),
    });
    await step('S17 · 되돌리기(5초) — 같은 값을 다시 씀: d09:21 a10:03 복원, 신호 2번', W3, {
      at: T('10:07'),
      act: async () => { await setPt(W3, 'A', W3.P.A, `departed_at = '${T('09:21')}', departed_source = 'BUTTON'`); await setPt(W3, 'A', W3.P.A, `arrived_at = '${T('10:03')}', arrived_source = 'LOCATION'`); },
      sig: 2, see: S3({ A: 'CONFIRMED d09:21 a10:03 T' }),
    });

    // S19 도착 감지 놓침 — 서버는 이동 중 해제를 안 함, 약속 시각(trip_appointment_at)만 줌(앱이 + 60분을 셈)
    const W4 = await world();
    await calm(W4, ['A', 'B', 'C', 'D']);
    await check('S19 · 도착이 감지되지 않은 채 — 서버 값은 약속 + 60분(11:00)이 지난 11:30에도 출발만 있고 도착 없음(이동 중 뗌은 앱 몫), trip_appointment_at = 10:00을 내려줘 앱이 약속 + 60분을 셈', async () => {
      await setPt(W4, 'D', W4.P.D, `departed_at = '${T('09:30')}', departed_source = 'LOCATION'`);
      const rows = await rowsOf(W4, 'A', T('11:30'));
      const d = rows.find((r) => r.user_id === W4.U.D);
      return eq([cell(d), iso(d.trip_appointment_at)], ['CONFIRMED d09:30 T', iso(T('10:00'))]);
    });
  }

  // =====================================================================
  // S21 · S22 · S23 · S24 — 공유 설정 변화 · 숨기기 · 차단
  // =====================================================================
  {
    const W = await world();
    await calm(W, ['A', 'B', 'C', 'D']);
    await evDev(W, 'B', W.AL.B.DEPARTURE, 'ACKNOWLEDGED', T('09:24'));
    await evDev(W, 'B', W.AL.B.ARRIVE, 'ARRIVAL_CONFIRMED', T('09:58'));
    const S = (o) => ({ A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED T', ...o });
    await check('S21 · B(출발 · 도착 공유 끔)가 출발 · 도착을 눌러도 기록은 서버에 남고 모든 화면은 B를 CONFIRMED(기상 완료)에서 멈춰 보임, T(trip_visible) 없음', async () => {
      const p = await pt(W.P.B);
      const bad = await seeAll(W, T('10:00'), S({}));
      return bad === true && p.departed_at && p.arrived_at ? true : { bad, p };
    });
    const tog = (k, col, on) => app(W.U[k], () => q(`update public.group_members set ${col} = $3 where group_id = $1 and user_id = $2 returning wake_share_opt_in as w, trip_share_opt_in as t`, [W.g, W.U[k], on]));
    await step('S22 · 10:01 B가 출발 · 도착 공유 켬 — 다음 읽기부터 저장돼 있던 d09:24 a09:58이 T와 함께 보임', W, { at: T('10:01'), act: () => tog('B', 'trip_share_opt_in', true), see: S({ B: 'CONFIRMED d09:24 a09:58 T' }) });
    await step('S22 · 10:02 다시 끔 — 바로 CONFIRMED 하나로 돌아가고 T 사라짐', W, { at: T('10:02'), act: () => tog('B', 'trip_share_opt_in', false), see: S({}) });
    await step('S22 · 10:03 B가 기상 공유를 끔 — A · C · D 화면에서 B 줄이 사라짐(B는 자기 줄만), 출발 · 도착 공유도 서버가 같이 끔', W, {
      at: T('10:03'), act: async () => { await tog('B', 'trip_share_opt_in', true); return tog('B', 'wake_share_opt_in', false); },
      see: S({ B: ['CONFIRMED', '-'] }), then: async (r) => { const v = await view(W, 'A', T('10:03')); return eq([r[0].t, v.B], [false, '-']); },
    });
    await step('S22 · 10:04 기상 공유 꺼진 채 출발 · 도착 공유를 켜려 해도 꺼진 채 / 기상 공유를 다시 켜도 출발 · 도착은 꺼진 채(기본 끔) — B 줄은 돌아오되 T 없음', W, {
      at: T('10:04'),
      act: async () => { const a = await tog('B', 'trip_share_opt_in', true); const b = await tog('B', 'wake_share_opt_in', true); return [a[0].t, b[0].t]; },
      see: S({}), then: (r) => eq(r, [false, false]),
    });
    await knownGap('G8', '공유(기상 · 출발 · 도착)를 켜거나 끌 때 상대가 열어 둔 그룹 화면을 다시 읽게 하는 신호가 나가야 함 — 지금은 group_members 변경에 신호 트리거가 없어 0건', async () => {
      const w = await world();
      const n0 = await sigN(w);
      await app(w.U.B, () => q(`update public.group_members set trip_share_opt_in = true where group_id = $1 and user_id = $2`, [w.g, w.U.B]));
      await app(w.U.A, () => q(`update public.group_members set trip_share_opt_in = false where group_id = $1 and user_id = $2`, [w.g, w.U.A]));
      await app(w.U.A, () => q(`update public.group_members set wake_share_opt_in = false where group_id = $1 and user_id = $2`, [w.g, w.U.A]));
      const got = (await sigN(w)) - n0;
      return got >= 3 ? true : { '공유 켜기 · 끄기 3번 뒤 신호 수': got };
    });

    // S23 기상 숨기기
    const W2 = await world();
    await calm(W2, ['A', 'B', 'C', 'D']);
    await check('S23 · 기상 숨기기 — D가 B에게만 숨긴 상태: B 화면에서 D가 없고(공유 안 함), A · C 화면에는 D가 보임, D 본인 화면도 그대로, 깨우기는 B → D FORBIDDEN', async () => {
      const b = await view(W2, 'B', T('08:00')), a = await view(W2, 'A', T('08:00')), d = await view(W2, 'D', T('08:00'));
      return eq([b.D, a.D, d.D, d.B, await pingS(W2, 'B', 'D', T('08:00'))], ['-', 'CONFIRMED T', 'CONFIRMED T', 'CONFIRMED', 'FORBIDDEN']);
    });
    await check('S23 · 보이기로 되돌리면(set_wake_hidden false) 바로 B 화면에 D가 돌아옴, 한 번 더 숨겨도 행은 하나(OK)', async () => {
      await call(W2.U.D, 'public.set_wake_hidden($1, $2)', [W2.U.B, false]);
      const shown = (await view(W2, 'B', T('08:00'))).D;
      await call(W2.U.D, 'public.set_wake_hidden($1, $2)', [W2.U.B, true]);
      const r2 = await call(W2.U.D, 'public.set_wake_hidden($1, $2)', [W2.U.B, true]);
      const [n] = await q(`select count(*)::int as n from public.wake_hides where owner_id = $1 and hidden_from_id = $2`, [W2.U.D, W2.U.B]);
      return eq([shown, r2.status, n.n, (await view(W2, 'B', T('08:00'))).D], ['CONFIRMED T', 'OK', 1, '-']);
    });
    await knownGap('NEW-2', '기상 숨기기 · 보이기를 할 때 상대가 열어 둔 그룹 화면에 새로 고침 신호가 나가야 함(G8과 같은 계열) — 지금은 wake_hides 변경에 신호가 없어 B가 화면을 다시 열기 전까지 D가 그대로 보임', async () => {
      const w = await world({ hide: false });
      const n0 = await sigN(w);
      await call(w.U.D, 'public.set_wake_hidden($1, $2)', [w.U.B, true]);
      await call(w.U.D, 'public.set_wake_hidden($1, $2)', [w.U.B, false]);
      const got = (await sigN(w)) - n0;
      return got >= 2 ? true : { '숨기기 · 보이기 뒤 신호 수': got };
    });

    // S24 차단 — 지금 동작을 기록 (G17: 그룹 · 공동 약속에는 남음, 의도 확인 대기)
    const W3 = await world();
    await calm(W3, ['B', 'C', 'D']);
    await evApp(W3, 'A', W3.AL.A.WAKE, 'TRIGGERED', T('07:00'));
    await evApp(W3, 'A', W3.AL.A.WAKE, 'DISMISSED', T('07:01'), 'BUTTON');
    await check('S24 · (G17 현재 동작 기록) B가 A를 차단 — ① 서로의 기상 줄이 사라짐(B 화면에 A 없음, A 화면에 B 없음) ② C · D는 둘 다 그대로 봄 ③ 그룹 멤버십 · 공동 약속 참여는 그대로 남음(JOINED 4명 · 참여 행 4개) ④ 서로 깨우기 FORBIDDEN', async () => {
      await call(W3.U.B, 'public.block_user($1)', [W3.U.A]);
      const a = await view(W3, 'A', T('07:45')), b = await view(W3, 'B', T('07:45')), c = await view(W3, 'C', T('07:45')), d = await view(W3, 'D', T('07:45'));
      const [m] = await q(`select count(*)::int as n from public.group_members where group_id = $1 and invite_status = 'JOINED'`, [W3.g]);
      const [p] = await q(`select count(*)::int as n from public.appointment_participants where appointment_id = $1`, [W3.main.ap]);
      return eq([a.B, b.A, c.A, c.B, d.A, d.B, m.n, p.n, await pingS(W3, 'B', 'A', T('07:45')), await pingS(W3, 'A', 'B', T('07:45'))],
        ['-', '-', 'MISSED T', 'CONFIRMED', 'MISSED T', 'CONFIRMED', 4, 4, 'FORBIDDEN', 'FORBIDDEN']);
    });
    await check('S24 · 차단 쌍은 푸시 대상에서도 빠짐 — A가 놓치면(07:30) 친구 알림은 C · D에게만(B 제외), 공동 약속 변경 푸시는 B가 보이는 알림 대신 조용한 데이터 푸시(silent)로 감', async () => {
      const r = await wakeCheck(W3, T('07:31'));
      const n = await wakeCheck(W3, T('07:45'));
      await su();
      const plan = (await q(`select public.plan_group_push($1, $2, 'GROUP_APPT_CHANGED', $3) as r`, [W3.U.A, W3.g, W3.main.ap]))[0].r;
      return eq([r.self, n.nudge, plan.recipients.map((u) => W3.who[u]).sort(), plan.silent_recipients.map((u) => W3.who[u])], [['A'], ['C>A', 'D>A'], ['C', 'D'], ['B']]);
    });
    await check('S24 · 차단을 풀면 바로 서로 다시 보임', async () => {
      await call(W3.U.B, 'public.unblock_user($1)', [W3.U.A]);
      const a = await view(W3, 'A', T('07:50')), b = await view(W3, 'B', T('07:50'));
      return eq([a.B, b.A], ['CONFIRMED', 'MISSED T']);
    });
  }

  // =====================================================================
  // S25 · S26 · S29 — 관계 · 참여 변화: 그룹 나가기 · 내보내짐 · 약속에서 빠지기
  // =====================================================================
  {
    const leave = (W, k) => app(W.U[k], () => q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2 and invite_status = 'JOINED' returning 1`, [W.g, W.U[k]]));
    const counts = async (W, k) => {
      await su();
      const [a] = await q(`select count(*)::int as n from public.alarms where user_id = $1`, [W.U[k]]);
      const [p] = await q(`select count(*)::int as n from public.appointment_participants where user_id = $1`, [W.U[k]]);
      return [a.n, p.n];
    };
    // 나가는 B가 만든 15:00 약속(참여 B · C)이 하나 더 있는 세계
    const W = await world();
    await calm(W, ['A', 'B', 'C', 'D']);
    const second = await addAppt(W, { at: T('15:00'), wake: Object.fromEntries(LET.map((k) => [k, T('12:30')])), prep: T('13:50'), dep: T('14:20'), users: ['B', 'C'], creator: 'B', title: 'B가 만든 오후 약속' });
    await evDev(W, 'B', W.AL.B.DEPARTURE, 'ACKNOWLEDGED', T('09:24'));
    await step('S25 · B가 그룹을 나감(JOINED → LEFT) — 서버가 B의 오늘 이후 참여 · 알람을 바로 지움(알람 0 · 참여 0), A · C · D 화면에서 B 사라짐, B는 이 그룹 화면에 줄이 없음, B가 만든 약속은 만든 사람 칸만 비고 C 참여로 남음', W, {
      at: T('10:10'), act: async () => { const r = await leave(W, 'B'); return { r: r.length, b: await counts(W, 'B') }; },
      then: async ({ r, b }) => {
        const bv = await view(W, 'B', T('10:10')), av = await view(W, 'A', T('10:10'));
        const [ap2] = await q(`select creator_id from public.appointments where appointment_id = $1`, [second.ap]);
        const [pp] = await q(`select count(*)::int as n from public.appointment_participants where appointment_id = $1`, [second.ap]);
        return eq([r, b, av.B, bv.A, bv.B, ap2.creator_id, pp.n], [1, [0, 0], '-', '-', '-', null, 1]);
      },
    });
    const W5 = await world();
    await calm(W5, ['C', 'D']);
    await leave(W5, 'B');
    await step('S25 · 나간 B는 친구 알림 · 깨우기 대상에서 빠짐 — A가 해제 뒤 다시 자서 놓치면(07:31) 본인 푸시는 A, 친구 알림은 C · D에게만, B → A 깨우기는 FORBIDDEN(남은 사람 화면은 B 없이 계속)', W5, {
      at: T('07:45'),
      act: async () => { await evApp(W5, 'A', W5.AL.A.WAKE, 'TRIGGERED', T('07:00')); await evApp(W5, 'A', W5.AL.A.WAKE, 'DISMISSED', T('07:01'), 'BUTTON'); return [await wakeCheck(W5, T('07:31')), await wakeCheck(W5, T('07:45')), await pingS(W5, 'B', 'A', T('07:50'))]; },
      then: ([r, n, p]) => eq([r.self, n.nudge, p], [['A'], ['C>A', 'D>A'], 'FORBIDDEN']),
    });
    await knownGap('NEW-3', '그룹 나가기 · 내보내짐 때 남은 사람들이 열어 둔 그룹 화면에 새로 고침 신호가 나가야 함 — 지금은 group_members 변경에 신호가 없어 남은 사람 화면에 나간 사람이 다시 읽기 전까지 남음(G8과 같은 계열)', async () => {
      const w = await world();
      const n0 = await sigN(w);
      await leave(w, 'B');
      await app(w.U.A, () => q(`delete from public.group_members where group_id = $1 and user_id = $2`, [w.g, w.U.D]));
      const got = (await sigN(w)) - n0;
      return got >= 2 ? true : { '나가기 · 내보내기 뒤 신호 수': got };
    });

    // S26 내보내짐
    const W2 = await world();
    await calm(W2, ['A', 'B', 'C', 'D']);
    await step('S26 · A가 D를 내보냄(행 지움) — D의 참여 · 알람이 바로 지워지고, D 화면에는 이 그룹 줄이 없으며, 남은 A · C 화면에서 D가 사라짐(알림은 설계상 없음)', W2, {
      at: T('10:10'),
      act: async () => { const r = await app(W2.U.A, () => q(`delete from public.group_members where group_id = $1 and user_id = $2 returning 1`, [W2.g, W2.U.D])); return { r: r.length, d: await counts(W2, 'D') }; },
      then: async ({ r, d }) => { const dv = await view(W2, 'D', T('10:10')), av = await view(W2, 'A', T('10:10')), cv = await view(W2, 'C', T('10:10')); return eq([r, d, dv.A, dv.D, av.D, cv.D], [1, [0, 0], '-', '-', '-', '-']); },
    });

    // S29 내가 약속에서만 빠짐 (그룹은 남음)
    const W3 = await world();
    await calm(W3, ['A', 'B', 'C', 'D']);
    await evDev(W3, 'B', W3.AL.B.DEPARTURE, 'ACKNOWLEDGED', T('09:24'));
    await step('S29 · B가 공동 약속에서만 빠짐(내 참여 행 지움) — B의 알람이 같이 지워지고, 그룹에는 남아 B 줄이 NO_ALARM(알람 없음)으로 보임, 그 약속의 출발 기록은 사라져 trip_visible 없음', W3, {
      at: T('10:10'),
      act: async () => { const r = await app(W3.U.B, () => q(`delete from public.appointment_participants where participant_id = $1 and user_id = $2 returning 1`, [W3.P.B, W3.U.B])); return { r: r.length, b: await counts(W3, 'B') }; },
      then: async ({ r, b }) => { const av = await view(W3, 'A', T('10:10')); return eq([r, b, av.B], [1, [0, 0], 'NO_ALARM']); },
    });
    await knownGap('NEW-4', '약속에서 빠질 때(참여 행 삭제) 열어 둔 그룹 화면에 새로 고침 신호가 나가야 함 — 지금은 참여 행의 신호 트리거가 insert · update뿐이라 삭제는 0건(친구 화면은 다시 읽을 때 NO_ALARM으로 바뀜)', async () => {
      const w = await world();
      const n0 = await sigN(w);
      await app(w.U.B, () => q(`delete from public.appointment_participants where participant_id = $1`, [w.P.B]));
      const got = (await sigN(w)) - n0;
      return got >= 1 ? true : { '빠진 뒤 신호 수': got };
    });
  }

  // =====================================================================
  // S27 · S28 — 남이 공동 약속 시각을 바꾸거나 취소 (서버 쪽: 그룹 화면 · 푸시 대상 · 신호)
  //   서버 edit-run은 만든 사람이 약속 행을 고치고 참여자의 알람도 같이 옮김(X-APPT-03). 폰 알람 다시 맞추기(G2)는 이 시험 밖
  // =====================================================================
  {
    const W = await world();
    await calm(W, ['A', 'B', 'C', 'D']);
    const S = (o) => ({ A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED T', ...o });
    await evApp(W, 'D', W.AL.D.DEPARTURE, 'ACKNOWLEDGED', T('09:30'), 'BUTTON');
    await check('S27 · 푸시 대상 — A(만든 사람)가 시각을 바꾸면 알림은 B · C · D(참여자, 알림 켬)에게, C가 이 그룹 알림을 끄면 C는 보이는 알림 대신 조용한 데이터 푸시(silent, 알람은 다시 맞춰야 하므로)', async () => {
      await su();
      const before = (await q(`select public.plan_group_push($1, $2, 'GROUP_APPT_CHANGED', $3) as r`, [W.U.A, W.g, W.main.ap]))[0].r;
      await app(W.U.C, () => q(`update public.group_members set notifications_off = true where group_id = $1 and user_id = $2`, [W.g, W.U.C]));
      const after = (await q(`select public.plan_group_push($1, $2, 'GROUP_APPT_CHANGED', $3) as r`, [W.U.A, W.g, W.main.ap]))[0].r;
      const ids = (r) => [r.recipients.map((u) => W.who[u]).sort(), r.silent_recipients.map((u) => W.who[u])];
      return eq([ids(before), ids(after)], [[['B', 'C', 'D'], []], [['B', 'D'], ['C']]]);
    });
    await step('S27 · 10:00 → 11:00으로 변경(만든 사람 A가 약속 행 + 모든 참여자 알람을 1시간 뒤로) — 그룹 화면은 읽을 때 반영: 알람 시각 · trip_appointment_at이 11:00 기준으로, 기상 단계 · D의 출발은 그대로', W, {
      at: T('09:40'),
      act: async () => {
        await app(W.U.A, () => q(`update public.appointments set appointment_at = $2::timestamptz where appointment_id = $1`, [W.main.ap, T('11:00')]));
        await q(`update public.alarms set scheduled_at = scheduled_at + interval '1 hour' where participant_id in (select participant_id from public.appointment_participants where appointment_id = $1)`, [W.main.ap]);
      },
      see: S({ D: 'CONFIRMED d09:30 T' }),
      then: async () => {
        const rows = await rowsOf(W, 'B', T('09:40')); const a = rows.find((r) => r.user_id === W.U.A);
        return eq([iso(a.trip_appointment_at), iso(a.wake_alarm_at)], [iso(T('11:00')), iso(T('08:00'))]);
      },
    });
    await step('S27b · (현재 동작 기록) 하루 넘게 변경(11:00 → 내일 11:00, 알람도 +24시간) — 오늘 화면은 그 그룹 약속이 없는 날이라 줄 없음, 내일 화면은 모두 SCHEDULED이고 D가 오늘 남긴 출발(d09:30)이 옮긴 약속에 그대로 따라 붙음(출발 기록은 참여 행에 붙어 날짜별로 새로 열리지 않음)', W, {
      at: T('09:41'),
      act: async () => {
        await app(W.U.A, () => q(`update public.appointments set appointment_at = $2::timestamptz where appointment_id = $1`, [W.main.ap, T('11:00', 1)]));
        await q(`update public.alarms set scheduled_at = scheduled_at + interval '24 hours' where participant_id in (select participant_id from public.appointment_participants where appointment_id = $1)`, [W.main.ap]);
      },
      then: async () => {
        const today = await view(W, 'A', T('09:41'));
        const tomorrow = await seeAll(W, T('09:41'), { A: 'SCHEDULED T', B: 'SCHEDULED', C: 'SCHEDULED', D: 'SCHEDULED d09:30 T' }, dayPlus(1));
        return today.A === '-' && today.D === '-' && tomorrow === true ? true : { 오늘: today, 내일: tomorrow };
      },
    });
    await knownGap('NEW-1', '약속 시각 변경 · 취소를 할 때 그 그룹 화면을 열어 둔 사람들에게 새로 고침 신호가 나가야 함 — 지금은 appointments 변경 · 삭제에 신호가 없어(기상 알람 시각 줄 · 약속 시각 · 줄 전체가 다시 읽을 때만 바뀜) 0건', async () => {
      const w = await world();
      const n0 = await sigN(w);
      await app(w.U.A, () => q(`update public.appointments set appointment_at = $2::timestamptz where appointment_id = $1`, [w.main.ap, T('11:00')]));
      const afterChange = (await sigN(w)) - n0;
      await app(w.U.A, () => q(`delete from public.appointments where appointment_id = $1`, [w.main.ap]));
      const afterCancel = (await sigN(w)) - n0;
      return afterChange >= 1 && afterCancel >= 2 ? true : { '변경 뒤 신호': afterChange, '취소까지 누적 신호': afterCancel };
    });

    // S28 취소
    const W2 = await world();
    await calm(W2, ['A', 'B', 'C', 'D']);
    await check('S28 · 만든 사람이 아닌 B가 약속을 지우려 해도 0행(RLS) — 약속 · 모든 알람 그대로', async () => {
      const r = await app(W2.U.B, () => q(`delete from public.appointments where appointment_id = $1 returning 1`, [W2.main.ap]));
      const [n] = await q(`select count(*)::int as n from public.alarms where participant_id = $1`, [W2.P.B]);
      return eq([r.length, n.n], [0, 4]);
    });
    await check('S28 · 만든 A가 취소 — 푸시 대상은 지우기 전에 B · C · D로 정해지고, 지운 뒤 모든 참여자 알람이 서버에서 사라져 모두의 화면이 줄 없음, 놓침 · 친구 알림 대상도 없음(취소된 약속에 놓침 푸시가 안 감)', async () => {
      await su();
      const plan = (await q(`select public.plan_group_push($1, $2, 'GROUP_APPT_CHANGED', $3) as r`, [W2.U.A, W2.g, W2.main.ap]))[0].r;
      const del = await app(W2.U.A, () => q(`delete from public.appointments where appointment_id = $1 returning 1`, [W2.main.ap]));
      const rows = {}; for (const v of LET) rows[v] = (await rowsOf(W2, v, T('07:45'))).length;
      const [al] = await q(`select count(*)::int as n from public.alarms where user_id = any($1::uuid[])`, [Object.values(W2.U)]);
      const wc = await wakeCheck(W2, T('08:45'));
      return eq([plan.recipients.map((u) => W2.who[u]).sort(), del.length, rows, al.n, wc], [['B', 'C', 'D'], 1, { A: 0, B: 0, C: 0, D: 0 }, 0, { self: [], nudge: [], up: [] }]);
    });
    await check('S28 · (G5 서버 쪽) 취소된 약속의 [출발했어요] — 기기 길은 지워진 알람이라 건너뛰고(기록 0), 앱 직접 쓰기는 RLS가 막아 서버에 기록이 안 쌓임', async () => {
      const dev = await evDev(W2, 'B', W2.AL.B.DEPARTURE, 'ACKNOWLEDGED', T('09:24'));
      let appErr = null;
      try { await evApp(W2, 'B', W2.AL.B.DEPARTURE, 'ACKNOWLEDGED', T('09:24'), 'BUTTON'); } catch (e) { appErr = /row-level security/.test(e.message); }
      const [n] = await q(`select count(*)::int as n from public.alarm_events where user_id = $1 and event_type = 'ACKNOWLEDGED'`, [W2.U.B]);
      return eq([dev.skipped, appErr, n.n], [true, true, 0]);
    });
  }

  // =====================================================================
  // S30 — 공동 약속이 둘인 날(10:00 · 15:00): 기상은 그날 첫 알람 기준, 출발 · 도착은 기록이 가장 최근인 약속 기준
  // =====================================================================
  {
    const W = await world();
    await calm(W, ['A', 'B', 'C', 'D']);
    const second = await addAppt(W, { at: T('15:00'), wake: Object.fromEntries(LET.map((k) => [k, T('12:30')])), prep: T('13:50'), dep: T('14:20'), title: '오후 약속' });
    const S = (o) => ({ A: 'CONFIRMED T', B: 'CONFIRMED', C: 'CONFIRMED', D: 'CONFIRMED T', ...o });
    await step('S30 · 06:00 알람이 둘(07:00 · 12:30)이어도 기상은 그날 첫 알람(07:00)이 기준 — wake_alarm_at = 07:00', W, {
      at: T('06:00'), see: S({}), then: async () => { const a = (await rowsOf(W, 'B', T('06:00'))).find((r) => r.user_id === W.U.A); return eq(iso(a.wake_alarm_at), iso(T('07:00'))); },
    });
    await step('S30 · 12:30 오후 약속 기상 알람이 울려 해제돼도 단계는 CONFIRMED 유지(그날 확인 하나), 13:05 wake-check에 놓침 · 친구 알림 없음', W, {
      at: T('12:35'),
      act: async () => { for (const k of ['A', 'B']) { await evApp(W, k, second.AL[k].WAKE, 'TRIGGERED', T('12:30')); await evApp(W, k, second.AL[k].WAKE, 'DISMISSED', T('12:31'), 'BUTTON'); } return wakeCheck(W, T('13:05')); },
      see: S({}), then: (r) => eq(r, { self: [], nudge: [], up: [] }),
    });
    await step('S30 · 09:21 출발 → 09:55 도착(10:00 약속) — 11:00 화면은 그 약속의 d09:21 a09:55, trip_appointment_at = 10:00', W, {
      at: T('11:00'),
      act: async () => { await evDev(W, 'A', W.AL.A.DEPARTURE, 'ACKNOWLEDGED', T('09:21')); await evDev(W, 'A', W.AL.A.ARRIVE, 'ARRIVAL_CONFIRMED', T('09:55')); },
      see: S({ A: 'CONFIRMED d09:21 a09:55 T' }),
      then: async () => eq(iso((await rowsOf(W, 'B', T('11:00'))).find((r) => r.user_id === W.U.A).trip_appointment_at), iso(T('10:00'))),
    });
    await step('S30 · 14:10 오후 약속으로 출발 — 기록이 가장 최근인 15:00 약속으로 바뀌어 d14:10(도착 없음), trip_appointment_at = 15:00(앱이 이동 중을 약속 + 60분까지만 붙임)', W, {
      at: T('14:11'), act: () => evDev(W, 'A', second.AL.A.DEPARTURE, 'ACKNOWLEDGED', T('14:10')), see: S({ A: 'CONFIRMED d14:10 T' }),
      then: async () => eq(iso((await rowsOf(W, 'B', T('14:11'))).find((r) => r.user_id === W.U.A).trip_appointment_at), iso(T('15:00'))),
    });
    await step('S30 · 14:55 오후 약속 도착 — d14:10 a14:55', W, {
      at: T('14:56'), act: () => evDev(W, 'A', second.AL.A.ARRIVE, 'ARRIVAL_CONFIRMED', T('14:55')), see: S({ A: 'CONFIRMED d14:10 a14:55 T' }),
    });
  }
}
