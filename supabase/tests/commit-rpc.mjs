// 알람 저장 DB 함수(public.alarm_commit_apply · 마이그레이션 20261115120000, 정할 일 0-10) — 한 트랜잭션 + 요청 키
//   사람은 이 파일 전용 계정. db-check 맨 끝에서 돎
export default async function testCommitRpc({ q, as, su, svc, check, expectErr }) {
  const U1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  const U2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
  const id = (n) => `c0de0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const COLS = 'alarm_id, participant_id, user_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, vibration, is_enabled, snooze_limit, time_source, intensity_source, recurrence_rule';
  for (const [uid, email] of [[U1, 'commit-rpc-1@example.com'], [U2, 'commit-rpc-2@example.com']]) {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email) values ($1, $2)`, [uid, email]);
    await su();
  }

  const FN = 'public.alarm_commit_apply($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::uuid[], $11::jsonb, $12::jsonb)';
  const j = (v) => (v == null ? null : JSON.stringify(v));
  // 서버가 부르는 것처럼 service_role로
  const apply = async (a) => {
    await svc();
    try {
      const [r] = await q(`select ${FN} as r`, [
        a.user ?? U1, a.key ?? null, a.hash ?? null, a.mode ?? 'APPOINTMENT', j(a.appointment), j(a.ref), j(a.participant),
        j(a.updates ?? []), j(a.inserts ?? []), a.removes ?? [], j(a.logs ?? []), j(a.before ?? []),
      ]);
      return r.r;
    } finally { await su(); }
  };
  const counts = async () => (await q(`select
      (select count(*)::int from public.appointments where creator_id in ($1, $2)) as ap,
      (select count(*)::int from public.appointment_participants where user_id in ($1, $2)) as pt,
      (select count(*)::int from public.alarms where user_id in ($1, $2)) as al,
      (select count(*)::int from public.user_edit_logs where user_id in ($1, $2)) as lg,
      (select count(*)::int from private.request_keys where user_id in ($1, $2)) as kk`, [U1, U2]))[0];
  const clean = async () => {
    await su();
    await q(`delete from public.appointments where creator_id in ($1, $2)`, [U1, U2]);
    await q(`delete from public.alarms where user_id in ($1, $2)`, [U1, U2]);
    await q(`delete from public.user_edit_logs where user_id in ($1, $2)`, [U1, U2]);
    await q(`delete from private.request_keys where user_id in ($1, $2)`, [U1, U2]);
  };
  const apRow = (n, extra = {}) => ({ appointment_id: id(n), title: '새 약속', appointment_at: '2026-11-20T01:00:00+00:00', dest_name: '학교', dest_lat: 37.5, dest_lng: 127.0, importance: 'NORMAL', recurrence_rule: null, ...extra });
  const alRow = (n, type, at, extra = {}) => ({ alarm_id: id(n), alarm_type: type, scheduled_at: at, intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'calm', vibration: null, is_enabled: true, time_source: 'AUTO', intensity_source: 'AUTO', last_calculated_at: '2026-11-15T00:00:00+00:00', ...extra });
  const ptFields = { origin_name: '집', origin_lat: 37.4, origin_lng: 127.1, transport_type: 'TRANSIT', est_travel_minutes: 30, travel_source: 'API', prepare_minutes: 60, buffer_minutes: 10 };
  const log = (alarmId, apId, extra = {}) => ({ appointment_id: apId, alarm_id: alarmId, screen: 'H03', field: 'scheduled_at', alarm_type: 'WAKE', auto_value: 'a', edited_value: 'b', ...extra });
  const fnSig = 'public.alarm_commit_apply(uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, uuid[], jsonb, jsonb)';
  const seedExisting = async (ap, pt, alarms, owner = U1) => {
    await svc();
    await q(`insert into public.appointments (appointment_id, creator_id, title, appointment_at, dest_name) values ($1, $2, '기존', '2026-11-21T01:00:00Z', '회사')`, [id(ap), owner]);
    await q(`insert into public.appointment_participants (participant_id, appointment_id, user_id, est_travel_minutes) values ($1, $2, $3, 20)`, [id(pt), id(ap), owner]);
    for (const [n, t, at] of alarms) {
      await q(`insert into public.alarms (alarm_id, participant_id, user_id, alarm_type, scheduled_at, sound_key) values ($1, $2, $3, $4, $5, 'old')`, [id(n), id(pt), owner, t, at]);
    }
    await su();
  };
  const refOf = (ap) => ({ appointment_id: id(ap), title: '기존', appointment_at: '2026-11-21T01:00:00+00:00' });

  await check('저장 함수: 새 약속 — 약속 · 참여 조건 · 알람 3개가 한 번에 들어가고, 넘긴 id 그대로 · after는 만든 순서 · 고친 값 기록도 들어가고 · 키 줄에 결과가 남음', async () => {
    const r = await apply({
      key: 'key-happy-0001', hash: 'h1', appointment: apRow(1), participant: { participant_id: id(2), is_new: true, fields: ptFields },
      inserts: [alRow(3, 'WAKE', '2026-11-20T00:00:00+00:00'), alRow(4, 'PREPARE', '2026-11-20T00:10:00+00:00'), alRow(5, 'DEPARTURE', '2026-11-20T00:30:00+00:00')],
      logs: [log(id(3), id(1))],
    });
    await su();
    const c = await counts();
    const [pt] = await q(`select appointment_id, user_id, est_travel_minutes from public.appointment_participants where participant_id = $1`, [id(2)]);
    const [key] = await q(`select result->>'replayed' as rep, result->'after'->0->>'alarm_id' as first from private.request_keys where user_id = $1 and key = 'key-happy-0001'`, [U1]);
    const [ap] = await q(`select creator_id from public.appointments where appointment_id = $1`, [id(1)]);
    const out = r.replayed === false && r.appointment.appointment_id === id(1) && r.appointment.title === '새 약속' && r.participant_id === id(2)
      && JSON.stringify(r.after.map((a) => a.alarm_id)) === JSON.stringify([id(3), id(4), id(5)]) && r.after[0].user_id === U1 && r.after[0].participant_id === id(2)
      && r.after[0].snooze_limit === 3 && Array.isArray(r.before) && r.before.length === 0
      && c.ap === 1 && c.pt === 1 && c.al === 3 && c.lg === 1 && c.kk === 1
      && pt.appointment_id === id(1) && pt.user_id === U1 && pt.est_travel_minutes === 30 && ap.creator_id === U1
      && key.rep === 'false' && key.first === id(3);
    await clean();
    return out ? true : { r, c, pt, key };
  });

  await check('저장 함수: 알람 시각 JSON 모양이 PostgREST 직접 select(json_agg · 2026-11-20T00:00:00+00:00 꼴, 마이크로초가 있으면 .123456)와 글자까지 같음', async () => {
    await q(`set timezone to 'UTC'`);   // Supabase 세션 시간대 (PGlite는 기계 시간대를 따라가서 맞춰 둠)
    const r = await apply({ appointment: apRow(1), participant: { participant_id: id(2), is_new: true, fields: ptFields },
      inserts: [alRow(3, 'WAKE', '2026-11-20T00:00:00.123456+00:00'), alRow(4, 'PREPARE', '2026-11-20T00:10:00+00:00')] });
    await su();
    // PostgREST는 행을 json_agg로 내보냄 — 같은 칸을 같은 순서로 직접 select해 JSON 글자를 비교
    const [direct] = await q(`select json_agg(t order by alarm_id) as rows from (select ${COLS} from public.alarms where participant_id = $1) t`, [id(2)]);
    // 칸 순서는 jsonb가 짧은 이름부터로 바꿈(JSON 객체라 클라이언트는 상관없음) — 칸 이름 정렬 뒤 글자까지 비교
    const norm = (rows) => JSON.stringify([...rows].sort((a, b) => (a.alarm_id < b.alarm_id ? -1 : 1)).map((o) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)))));
    const same = norm(r.after) === norm(direct.rows);
    // 시간대가 달라도(+09:00) 같은 to_json 규칙이라 두 길이 서로 같음
    await q(`set timezone to 'Asia/Seoul'`);
    const [seoul] = await q(`select json_agg(t order by alarm_id) as rows from (select ${COLS} from public.alarms where participant_id = $1) t`, [id(2)]);
    await q(`reset timezone`);
    await clean();
    return same && seoul.rows[0].scheduled_at.endsWith('+09:00') && r.after[0].scheduled_at === '2026-11-20T00:00:00.123456+00:00' && r.after[1].scheduled_at === '2026-11-20T00:10:00+00:00'
      ? true : { same, after: r.after.map((a) => a.scheduled_at), direct: direct.rows.map((a) => a.scheduled_at) };
  });

  await check('저장 함수: 기존 약속에 참여 조건 고치기 · 알람 고치기 + 만들기 + 지우기 — after = 고친 것 ‖ 만든 것 ‖ 남은 것(원래 순서), 지운 것은 빠짐, 약속은 안 바뀜', async () => {
    await seedExisting(10, 11, [[12, 'WAKE', '2026-11-21T00:00:00Z'], [13, 'PREPARE', '2026-11-21T00:10:00Z'], [14, 'DEPARTURE', '2026-11-21T00:30:00Z']]);
    const before = (await q(`select json_agg(t order by scheduled_at) as r from (select ${COLS} from public.alarms where participant_id = $1) t`, [id(11)]))[0].r;
    // WAKE 고침 · PREPARE 지움 · DEPARTURE 남김 · ARRIVE 새로 만듦 (고치기 → 만들기 → 지우기 순이라 지우는 종류와 같은 종류를 새로 만들면 종류별 유일 인덱스에 걸림 — 서버 diff는 그렇게 안 보냄)
    const r = await apply({
      ref: refOf(10),
      participant: { participant_id: id(11), is_new: false, fields: { ...ptFields, est_travel_minutes: 45 } },
      updates: [{ alarm_id: id(12), patch: alRow(12, 'WAKE', '2026-11-21T00:05:00+00:00', { sound_key: 'new' }) }],
      removes: [id(13)],
      inserts: [alRow(16, 'ARRIVE', '2026-11-21T01:00:00+00:00', { sound_key: 'fresh' })],
      before,
    });
    await su();
    const [pt] = await q(`select est_travel_minutes, origin_name from public.appointment_participants where participant_id = $1`, [id(11)]);
    const left = (await q(`select alarm_id from public.alarms where participant_id = $1`, [id(11)])).map((x) => x.alarm_id);
    const [w] = await q(`select sound_key, scheduled_at = '2026-11-21T00:05:00Z' as moved from public.alarms where alarm_id = $1`, [id(12)]);
    const c = await counts();
    await clean();
    return r.appointment.title === '기존' && r.participant_id === id(11)
      && JSON.stringify(r.after.map((a) => a.alarm_id)) === JSON.stringify([id(12), id(16), id(14)])
      && r.after[0].sound_key === 'new' && r.after[1].sound_key === 'fresh' && r.before.length === 3
      && pt.est_travel_minutes === 45 && pt.origin_name === '집' && w.sound_key === 'new' && w.moved
      && JSON.stringify([...left].sort()) === JSON.stringify([id(12), id(14), id(16)].sort()) && c.ap === 1 && c.kk === 0   // 약속은 미리 넣어 둔 1개 그대로
      ? true : { after: r.after, pt, left, w, c };
  });

  await check('저장 함수: 일정 없는 알람(STANDALONE) — 새로 넣기는 participant · routine이 null(보낸 값이 있어도), 고치기는 응답에 새 값, 고친 값 기록(appointment_id null)도 들어감', async () => {
    const ins = await apply({ mode: 'STANDALONE', inserts: [alRow(20, 'WAKE', '2026-11-22T22:00:00+00:00', { participant_id: id(99), routine_id: id(98) })], logs: [log(id(20), null)] });
    await su();
    const [row] = await q(`select participant_id, routine_id, user_id from public.alarms where alarm_id = $1`, [id(20)]);
    const upd = await apply({ mode: 'STANDALONE', updates: [{ alarm_id: id(20), patch: alRow(20, 'WAKE', '2026-11-22T23:00:00+00:00', { recurrence_rule: 'FREQ=DAILY' }) }], before: ins.after });
    await su();
    const [row2] = await q(`select recurrence_rule, scheduled_at = '2026-11-22T23:00:00Z' as moved from public.alarms where alarm_id = $1`, [id(20)]);
    const c = await counts();
    await clean();
    return ins.appointment === null && ins.participant_id === null && ins.after.length === 1 && row.participant_id === null && row.routine_id === null && row.user_id === U1
      && upd.after.length === 1 && upd.after[0].recurrence_rule === 'FREQ=DAILY' && row2.recurrence_rule === 'FREQ=DAILY' && row2.moved && c.al === 1 && c.lg === 1
      ? true : { ins, row, upd, row2, c };
  });

  await check('저장 함수: 원자성 — 고친 값 기록이 제약(screen)에 걸려 실패하면 새 약속 · 참여 조건 · 알람 고치기 · 만들기 · 지우기 · 키 줄이 하나도 안 남음 (새 약속 길 · 기존 약속 길 둘 다)', async () => {
    await seedExisting(30, 31, [[32, 'WAKE', '2026-11-21T00:00:00Z'], [33, 'PREPARE', '2026-11-21T00:10:00Z']]);
    const before = await counts();
    const bad = await expectErr(() => apply({
      key: 'key-atomic-0001', hash: 'hx', appointment: apRow(34), participant: { participant_id: id(35), is_new: true, fields: ptFields },
      inserts: [alRow(36, 'WAKE', '2026-11-20T00:00:00+00:00')], logs: [log(id(36), id(34), { screen: 'BAD' })],
    }), /user_edit_logs_screen_check/);
    const bad2 = await expectErr(() => apply({
      key: 'key-atomic-0002', hash: 'hy', ref: refOf(30),
      participant: { participant_id: id(31), is_new: false, fields: { ...ptFields, est_travel_minutes: 99 } },
      updates: [{ alarm_id: id(32), patch: alRow(32, 'WAKE', '2026-11-21T00:55:00+00:00', { sound_key: 'changed' }) }],
      removes: [id(33)], inserts: [alRow(37, 'DEPARTURE', '2026-11-21T00:30:00+00:00')],
      logs: [log(id(32), id(30), { screen: 'BAD' })],
    }), /user_edit_logs_screen_check/);
    await su();
    const after = await counts();
    const [pt] = await q(`select est_travel_minutes from public.appointment_participants where participant_id = $1`, [id(31)]);
    const als = await q(`select alarm_id, sound_key from public.alarms where participant_id = $1 order by alarm_type`, [id(31)]);
    const ok = bad === true && bad2 === true && JSON.stringify(before) === JSON.stringify(after) && pt.est_travel_minutes === 20
      && als.length === 2 && als.every((a) => a.sound_key === 'old');
    await clean();
    return ok ? true : { bad, bad2, before, after, pt, als };
  });

  await check('저장 함수: 같은 키 · 같은 해시로 다시 부르면 첫 결과 그대로 + replayed: true, 행은 하나도 안 늘고 · 같은 키에 다른 해시면 IDEMPOTENCY_KEY_REUSED(P0001)이고 아무것도 안 바뀜 · 다른 사용자의 같은 키는 따로 · 키 없으면 키 줄을 안 만듦', async () => {
    const args = { key: 'key-replay-0001', hash: 'same', appointment: apRow(40), participant: { participant_id: id(41), is_new: true, fields: ptFields }, inserts: [alRow(42, 'WAKE', '2026-11-20T00:00:00+00:00')], logs: [log(id(42), id(40))] };
    const first = await apply(args);
    await su();
    const c1 = await counts();
    const again = await apply(args);
    await su();
    const c2 = await counts();
    let reused;
    try { await apply({ ...args, hash: 'different', appointment: apRow(43) }); reused = '오류가 나야 하는데 성공함'; } catch (e) { reused = e.code === 'P0001' && /IDEMPOTENCY_KEY_REUSED/.test(e.message) ? true : '다른 오류: ' + e.code + ' ' + e.message; }
    await su();
    const c3 = await counts();
    const other = await apply({ user: U2, key: 'key-replay-0001', hash: 'same', appointment: apRow(44), participant: { participant_id: id(45), is_new: true, fields: ptFields }, inserts: [alRow(46, 'WAKE', '2026-11-20T00:00:00+00:00')] });
    await su();
    const noKey = await apply({ appointment: apRow(47), participant: { participant_id: id(48), is_new: true, fields: ptFields } });
    await su();
    const c4 = await counts();
    const strip = ({ replayed, ...rest }) => rest;
    await clean();
    return first.replayed === false && again.replayed === true && JSON.stringify(strip(first)) === JSON.stringify(strip(again))
      && JSON.stringify(c1) === JSON.stringify(c2) && reused === true && JSON.stringify(c1) === JSON.stringify(c3)
      && other.replayed === false && noKey.replayed === false && c4.ap === 3 && c4.kk === 2
      ? true : { first, again, c1, c2, c3, c4, reused };
  });

  await check('저장 함수: 요청 키가 있는데 해시가 없으면 거부 · 키가 8자 미만이면 거부 · mode가 틀리면 거부 (모두 아무것도 안 남음)', async () => {
    const noHash = await expectErr(() => apply({ key: 'key-nohash-0001', appointment: apRow(50), participant: { participant_id: id(51), is_new: true, fields: ptFields } }), /request_hash/);
    const shortKey = await expectErr(() => apply({ key: 'short', hash: 'h', appointment: apRow(52), participant: { participant_id: id(53), is_new: true, fields: ptFields } }), /request_keys_key_check/);
    const badMode = await expectErr(() => apply({ mode: 'NOPE' }), /mode가 아님/);
    const c = await counts();
    await clean();
    return noHash === true && shortKey === true && badMode === true && c.ap === 0 && c.kk === 0 ? true : { noHash, shortKey, badMode, c };
  });

  await check('저장 함수: 남의 알람 · 남의 참여 조건을 고치려 하면 0행이라 P0002 — 같이 만든 것까지 전부 취소되고 남의 알람은 그대로 · 남의 알람 지우기는 아무 일도 안 함(본인 것만)', async () => {
    await seedExisting(60, 61, [[62, 'WAKE', '2026-11-21T00:00:00Z']], U2);
    const code = async (fn) => { try { await fn(); return 'none'; } catch (e) { return e.code; } };
    const alarmCode = await code(() => apply({
      appointment: apRow(63), participant: { participant_id: id(64), is_new: true, fields: ptFields },
      updates: [{ alarm_id: id(62), patch: alRow(62, 'WAKE', '2026-11-21T00:55:00+00:00', { sound_key: 'hacked' }) }],
    }));
    const partCode = await code(() => apply({ ref: refOf(60), participant: { participant_id: id(61), is_new: false, fields: ptFields } }));
    // 남의 알람 id를 지우기에 실어도 본인 것만 지워짐 (U1의 새 참여 조건만 만들어지고 남의 알람은 그대로)
    await apply({ ref: refOf(60), participant: { participant_id: id(65), is_new: true, fields: ptFields }, removes: [id(62)] });
    await su();
    const [theirs] = await q(`select sound_key from public.alarms where alarm_id = $1`, [id(62)]);
    const [mine] = await q(`select count(*)::int as n from public.appointments where appointment_id = $1`, [id(63)]);
    await clean();
    return alarmCode === 'P0002' && partCode === 'P0002' && theirs?.sound_key === 'old' && mine.n === 0 ? true : { alarmCode, partCode, theirs, mine };
  });

  await check('저장 함수: 권한 — anon · authenticated는 실행 못 하고(권한 없음), service_role만 실행 · 요청 키 표는 앱 역할이 못 읽음 · 도우미 · purge 함수는 아무도 직접 실행 못 함', async () => {
    const [p] = await q(`select has_function_privilege('anon', '${fnSig}', 'execute') as a, has_function_privilege('authenticated', '${fnSig}', 'execute') as u,
                                has_function_privilege('service_role', '${fnSig}', 'execute') as s,
                                has_function_privilege('service_role', 'private.commit_insert_row(text, jsonb, text)', 'execute') as h1,
                                has_function_privilege('service_role', 'private.commit_update_row(text, text, uuid, uuid, jsonb, text)', 'execute') as h2,
                                has_function_privilege('service_role', 'private.purge_request_keys()', 'execute') as h3,
                                has_table_privilege('authenticated', 'private.request_keys', 'select') as t1, has_table_privilege('service_role', 'private.request_keys', 'select') as t2`);
    const args = [U1, null, null, 'STANDALONE', null, null, null, '[]', '[]', [], '[]', '[]'];
    await as(U1);
    const authed = await expectErr(() => q(`select ${FN}`, args), /permission denied/);
    await as(null, 'anon');
    const anon = await expectErr(() => q(`select ${FN}`, args), /permission denied/);
    await as(U1);
    const tbl = await expectErr(() => q(`select * from private.request_keys`), /permission denied/);
    await svc();
    const svcOk = await q(`select ${FN} as r`, args);
    return p.a === false && p.u === false && p.s === true && !p.h1 && !p.h2 && !p.h3 && !p.t1 && !p.t2
      && authed === true && anon === true && tbl === true && svcOk[0].r.replayed === false && svcOk[0].r.after.length === 0
      ? true : { p, authed, anon, tbl, svcOk };
  });

  await check('저장 함수: 7일 지난 요청 키만 purge가 지움 (다시 돌려도 오류 없음) · pg_cron request-keys-purge는 매일 18:30 UTC', async () => {
    await su();
    await q(`insert into private.request_keys (user_id, fn, key, request_hash, result, created_at) values
             ($1, 'alarm-commit', 'key-old-00001', 'h', '{}', now() - interval '8 days'), ($1, 'alarm-commit', 'key-new-00001', 'h', '{}', now() - interval '6 days')`, [U1]);
    const [r] = await q(`select private.purge_request_keys() as n`);
    const left = (await q(`select key from private.request_keys where user_id = $1`, [U1])).map((x) => x.key);
    const [again] = await q(`select private.purge_request_keys() as n`);
    const [job] = await q(`select schedule, command from cron.job where jobname = 'request-keys-purge'`);
    await clean();
    return r.n >= 1 && JSON.stringify(left) === JSON.stringify(['key-new-00001']) && again.n === 0 && job.schedule === '30 18 * * *' && /purge_request_keys/.test(job.command)
      ? true : { r, left, again, job };
  });
}
