// 알람 조정 제안 실전 시험 (로컬 Supabase) — 진짜 Postgres · API(RLS) · 서버 함수(Deno)로 전체 흐름을 한 번 돌림
//   데모 준성(demo-junseong)으로 로그인 → 시험 일정 "E2E 제안 수업"(지난 3일 + 내일)과 아침 기록을 넣고 → suggestion-generate(서비스 키) →
//   사용자 토큰으로 suggestion-apply 적용 · 되돌리기 · 무시 → 알람 · 당김 분 · 제안 상태 확인 → 시험 데이터 지움
//   supabase/tests/e2e-suggest.mjs(CI, PGlite)가 못 보는 것: 서버 함수 실행 환경 · API 권한 · 로그인 토큰 검사 · verify_jwt 설정
// 필요: Docker + npx supabase start(서버 함수 포함) + supabase/seed 데모 계정(npm run seed:demo -- --yes). 127.0.0.1이 아니면 멈춤(../friend-e2e/env.mjs)
// 실행: cd tools/suggest-e2e && npm ci && E2E_SEED_ENV=<supabase/seed/.env 경로> node run.mjs
import { createClient } from '@supabase/supabase-js';

import { loadEnv } from '../friend-e2e/env.mjs';

const TITLE = 'E2E 제안 수업';
const EMAIL = 'demo-junseong@example.com'; // 친구 e2e(A · B · C)와 겹치지 않는 데모 계정
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };

// 한국 날짜 offset일 뒤 hh:mm (지금 기준)
const kstDay = (offset) => new Date(Date.now() + 9 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10);
const at = (offset, hh, mm) => new Date(`${kstDay(offset)}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`).toISOString();
const hm = (iso) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(11, 16);
const must = (res, what) => {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
};

const results = [];
const step = (name, ok, detail = '') => {
  results.push([ok ? 'PASS' : 'FAIL', name, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

async function cleanup(admin, userId) {
  const appts = must(await admin.from('appointments').select('appointment_id').eq('creator_id', userId).eq('title', TITLE), '시험 일정 읽기');
  if (!appts.length) return;
  const parts = must(await admin.from('appointment_participants').select('participant_id').in('appointment_id', appts.map((a) => a.appointment_id)), '참여 조건 읽기');
  const alarms = parts.length ? must(await admin.from('alarms').select('alarm_id').in('participant_id', parts.map((p) => p.participant_id)), '알람 읽기') : [];
  if (alarms.length) must(await admin.from('alarm_suggestions').delete().in('target_alarm_id', alarms.map((a) => a.alarm_id)), '시험 제안 지우기');
  must(await admin.from('appointments').delete().in('appointment_id', appts.map((a) => a.appointment_id)), '시험 일정 지우기');
}

async function main() {
  const env = loadEnv();
  const admin = createClient(env.url, env.serviceKey, NO_SESSION);
  const user = createClient(env.url, env.anonKey, NO_SESSION);
  const login = await user.auth.signInWithPassword({ email: EMAIL, password: env.password });
  if (login.error) throw new Error(`${EMAIL} 로그인 실패 — 시드가 들어가 있나요? (cd supabase/seed && npm run seed:demo -- --yes): ${login.error.message}`);
  const userId = login.data.user.id;
  await cleanup(admin, userId); // 지난 실행이 남긴 것

  try {
    // 매일 9시 수업 — 지난 3일(어제 · 그제 · 3일 전) + 내일. 계획: 기상 7:25 · 준비 7:45 · 출발 8:25
    const days = [-3, -2, -1, 1];
    const occ = {};
    let series = null;
    for (const d of days) {
      const a = must(await admin.from('appointments').insert({
        creator_id: userId, title: TITLE, appointment_at: at(d, 9, 0), dest_name: '세종대학교',
        recurrence_rule: series ? null : 'FREQ=DAILY', series_id: series, occurrence_on: series ? kstDay(d) : null,
      }).select('appointment_id, series_id').single(), `일정 ${kstDay(d)}`);
      series ??= a.series_id;
      const p = must(await admin.from('appointment_participants').insert({
        appointment_id: a.appointment_id, user_id: userId, prepare_minutes: 60, buffer_minutes: 5, est_travel_minutes: 30,
      }).select('participant_id').single(), `참여 조건 ${kstDay(d)}`);
      const ids = {};
      for (const [type, hh, mm] of [['WAKE', 7, 25], ['PREPARE', 7, 45], ['DEPARTURE', 8, 25]]) {
        ids[type] = must(await admin.from('alarms').insert({ participant_id: p.participant_id, user_id: userId, alarm_type: type, scheduled_at: at(d, hh, mm) }).select('alarm_id').single(), `알람 ${type}`).alarm_id;
      }
      occ[d] = { participant: p.participant_id, alarm: ids };
    }
    // 아침 기록: 준비 알람 7:45에 끄고 출발 8:35 · 8:39 · 8:37 (+10 · +14 · +12) — 앱처럼 사용자 권한으로(RLS)
    for (const [d, leave] of [[-3, [8, 35]], [-2, [8, 39]], [-1, [8, 37]]]) {
      must(await user.from('appointment_participants').update({ prepare_started_at: at(d, 7, 45), prepare_started_source: 'PREPARE_ALARM', departed_at: at(d, ...leave) }).eq('participant_id', occ[d].participant), `기록 ${kstDay(d)}`);
    }
    const prepOf = async (d) => hm(must(await admin.from('alarms').select('scheduled_at').eq('alarm_id', occ[d].alarm.PREPARE).single(), '준비 알람').scheduled_at);
    const advOf = async (d) => must(await admin.from('appointment_participants').select('prepare_advance_minutes').eq('participant_id', occ[d].participant).single(), '당김 분').prepare_advance_minutes;

    // ① 저녁 배치 — 서버 함수를 서비스 키로 (pg_cron이 부르는 것과 같은 길)
    const gen = await fetch(`${env.url}/functions/v1/suggestion-generate`, { method: 'POST', headers: { Authorization: `Bearer ${env.serviceKey}`, apikey: env.serviceKey, 'Content-Type': 'application/json' }, body: '{}' });
    const genBody = await gen.json().catch(() => ({}));
    const sugs = must(await user.from('alarm_suggestions').select('suggestion_id, status, suggested_value, evidence').eq('target_alarm_id', occ[1].alarm.PREPARE), '제안 읽기(사용자 권한)');
    step('① suggestion-generate(서비스 키) → 내일 준비 알람에 "10분 당김" 제안, 근거 +10 · +14 · +12 — 사용자 권한으로 보임',
      gen.ok && sugs.length === 1 && sugs[0].suggested_value === '10' && JSON.stringify(sugs[0].evidence) === '[10,14,12]',
      `HTTP ${gen.status} ${JSON.stringify(genBody)} · ${JSON.stringify(sugs)}`);
    if (!sugs.length) throw new Error('제안이 없어 뒤 단계를 못 함');
    const id = sugs[0].suggestion_id;

    // ② 사용자 토큰으로 적용 (앱 S01 "제안 적용하기")
    const apply = await user.functions.invoke('suggestion-apply', { body: { suggestion_id: id, action: 'APPLY' } });
    step('② suggestion-apply 적용(사용자 토큰) → 내일 준비 알람 7:45 → 7:35, 당김 분 10, 폰 꾸러미 1개',
      !apply.error && (await prepOf(1)) === '07:35' && (await advOf(1)) === 10 && apply.data?.ring_packages?.length === 1,
      JSON.stringify({ error: apply.error?.message, prep: await prepOf(1), adv: await advOf(1), pkgs: apply.data?.ring_packages?.length }));

    // ③ 되돌리기 · ④ 무시
    const revert = await user.functions.invoke('suggestion-apply', { body: { suggestion_id: id, action: 'REVERT' } });
    step('③ 되돌리기 → 준비 알람 7:45, 당김 분 0, 제안 PENDING', !revert.error && (await prepOf(1)) === '07:45' && (await advOf(1)) === 0 && revert.data?.status === 'PENDING',
      JSON.stringify({ error: revert.error?.message, prep: await prepOf(1), status: revert.data?.status }));
    const ignore = await user.functions.invoke('suggestion-apply', { body: { suggestion_id: id, action: 'IGNORE' } });
    step('④ 무시 → 제안 IGNORED, 알람 그대로', !ignore.error && ignore.data?.status === 'IGNORED' && (await prepOf(1)) === '07:45', JSON.stringify({ error: ignore.error?.message, status: ignore.data?.status }));

    // ⑤ 토큰 없이는 못 부름 (verify_jwt · 배치 길 막힘)
    const anonApply = await fetch(`${env.url}/functions/v1/suggestion-apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suggestion_id: id, action: 'APPLY' }) });
    const anonGen = await fetch(`${env.url}/functions/v1/suggestion-generate`, { method: 'POST', headers: { Authorization: `Bearer ${env.anonKey}`, apikey: env.anonKey }, body: '{}' });
    step('⑤ 토큰 없이 적용 · 공개 키로 배치는 거절 (401 · 403)', [401, 403].includes(anonApply.status) && anonGen.status === 403, `apply ${anonApply.status} · generate ${anonGen.status}`);
  } finally {
    await cleanup(admin, userId);
  }
  const fails = results.filter((r) => r[0] !== 'PASS').length;
  console.log(`\n실전 시험 ${results.length - fails} / ${results.length} 통과 (시험 데이터는 지움)`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(`멈춤: ${e.message}`);
  process.exit(1);
});
