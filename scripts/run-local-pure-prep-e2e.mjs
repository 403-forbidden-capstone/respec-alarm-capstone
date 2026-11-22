#!/usr/bin/env node
// Run ONLY on the developer's own machine after `npx supabase start`.
// This script is deliberately hard-bound to loopback: NEVER writes to a
// connected cloud Supabase project, never reads mobile/.env cloud secrets.
// It creates isolated test data in the *local* Supabase database, verifies
// persisted values over HTTP with real Auth + RLS, then starts the web app.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobile = resolve(root, 'mobile');

function fail(message) { throw new Error(message); }
function assert(ok, message) { if (!ok) fail(message); }
function fromStatusEnv(output) {
  return Object.fromEntries(output.split(/\r?\n/).map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) return null;
    const v = match[2].trim();
    return [match[1], (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v];
  }).filter(Boolean));
}
function localStatus() {
  let output;
  try {
    output = execFileSync('npx', ['supabase', 'status', '-o', 'env'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch {
    fail('로컬 Supabase 상태를 읽지 못했습니다. 프로젝트 루트에서 npx supabase start를 먼저 실행하세요.');
  }
  const cfg = fromStatusEnv(output);
  const api = cfg.API_URL;
  if (!api) fail('supabase status -o env에 API_URL이 없습니다.');
  const parsed = new URL(api);
  // No override. No arbitrary remote URL. Only this project's default local stack.
  assert(parsed.protocol === 'http:' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
    parsed.port === '54321' && (parsed.pathname === '/' || parsed.pathname === ''),
    '안전 검사 실패: API_URL이 로컬 127.0.0.1:54321이 아닙니다. 실행을 중단합니다.');
  const publishable = cfg.PUBLISHABLE_KEY || cfg.ANON_KEY;
  const adminKey = cfg.SERVICE_ROLE_KEY || cfg.SECRET_KEY;
  assert(publishable && adminKey,
    '로컬 publishable/service-role 키를 CLI 상태 출력에서 찾지 못했습니다.');
  return { api: parsed.origin, publishable, adminKey };
}
function apiClient({ api, publishable, adminKey }) {
  async function send(path, { role = 'public', token, method = 'GET', body, prefer } = {}) {
    assert(path.startsWith('/'), '경로는 로컬 API 상대 경로여야 합니다.');
    const key = role === 'admin' ? adminKey : publishable;
    const result = await fetch(api + path, {
      method,
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + (token || key),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(prefer ? { Prefer: prefer } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await result.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; }
    catch { data = { message: text.slice(0, 200) }; }
    return { ok: result.ok, status: result.status, data };
  }
  async function required(path, options, label) {
    const res = await send(path, options);
    if (!res.ok) fail(label + ': HTTP ' + res.status +
      ' (' + String(res.data?.code || res.data?.error_code || 'unknown') + ': ' +
      String(res.data?.message || res.data?.msg || res.data?.error || '').slice(0, 180) + ')');
    return res.data;
  }
  return { send, required };
}
const columnCheck = (c, table, columns) =>
  c.required('/rest/v1/' + table + '?select=' + encodeURIComponent(columns) + '&limit=1',
    { role: 'admin' }, table + ' 새 컬럼 확인');

function getKstAppointment() {
  // Two days later at exactly 10:00 KST; never accidentally create past alarms.
  const later = new Date(Date.now() + 2 * 86_400_000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(later);
  const get = (t) => parts.find((part) => part.type === t).value;
  return new Date(get('year') + '-' + get('month') + '-' + get('day') + 'T01:00:00.000Z');
}

async function main() {
  const cfg = localStatus();
  const c = apiClient(cfg);
  console.log('[1/7] 로컬 127.0.0.1:54321 전용 연결 확인');
  await columnCheck(c, 'profiles', 'default_prepare_minutes,default_outing_prep_minutes');
  await columnCheck(c, 'appointment_participants', 'prepare_value_source,outing_prep_minutes,outing_prep_source,outing_prep_model');
  console.log('[2/7] 순수 준비시간 신규 컬럼 확인 (마이그레이션 적용됨)');

  // A fresh LOCAL-ONLY account. Password is generated per run and never committed.
  const email = 'local-pure-prep-' + randomBytes(4).toString('hex') + '@example.com';
  const password = 'Local!' + randomBytes(12).toString('base64url') + 'aA1';
  const created = await c.required('/auth/v1/admin/users', {
    role: 'admin', method: 'POST', body: {
      email, password, email_confirm: true,
      user_metadata: { local_pure_prep_fixture: true, full_name: '로컬 준비시간 시험' },
    },
  }, '로컬 테스트 계정 생성');
  const userId = created?.id || created?.user?.id;
  assert(/^[0-9a-f-]{36}$/i.test(userId || ''), '로컬 Auth에서 사용자 ID를 반환하지 않았습니다.');

  const login = await c.required('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email, password },
  }, '로컬 테스트 계정 인증');
  const token = login?.access_token;
  assert(token, '로컬 Auth access token을 받지 못했습니다.');
  console.log('[3/7] 새 테스트 계정 생성 및 실제 Auth 로그인 성공');

  const base = '/rest/v1/profiles?user_id=eq.' + encodeURIComponent(userId);
  // This fixture is synthetic, not a real person's consent. Onboarding is
  // marked complete only to let the dev web page open immediately.
  await c.required(base, {
    role: 'admin', method: 'PATCH', prefer: 'return=representation',
    body: {
      nickname: '로컬 준비시간 시험',
      onboarded_at: new Date().toISOString(),
      privacy_agreed_at: new Date().toISOString(),
      privacy_version: 3,
    },
  }, '테스트 전용 계정 초기 상태 설정');
  const beforeRows = await c.required(base +
    '&select=user_id,default_prepare_minutes,default_outing_prep_minutes', {
      token,
    }, '저장 전 프로필 읽기');
  assert(Array.isArray(beforeRows) && beforeRows.length === 1, '로그인 사용자 프로필 조회/RLS가 맞지 않습니다.');
  const originalLegacy = beforeRows[0].default_prepare_minutes;
  assert(beforeRows[0].default_outing_prep_minutes === null,
    '새 로컬 계정의 순수 준비시간이 NULL이 아닙니다. 기존 값과 혼합할 수 없으므로 중단합니다.');

  const savedRows = await c.required(base + '&select=default_prepare_minutes,default_outing_prep_minutes', {
    token, method: 'PATCH', prefer: 'return=representation',
    body: { default_outing_prep_minutes: 35 },
  }, '로그인 사용자 준비시간 35분 저장');
  assert(savedRows?.length === 1 &&
    savedRows[0].default_outing_prep_minutes === 35 &&
    savedRows[0].default_prepare_minutes === originalLegacy,
    '순수 준비시간 저장 값 또는 기존 기상→출발 값이 달라졌습니다.');
  const reread = await c.required(base + '&select=default_prepare_minutes,default_outing_prep_minutes', {
    token,
  }, '별도 요청에서 준비시간 재조회');
  assert(reread?.length === 1 && reread[0].default_outing_prep_minutes === 35 &&
    reread[0].default_prepare_minutes === originalLegacy,
    '프로필 재조회 불일치');
  console.log('[4/7] Auth/RLS로 순수 준비시간 35분 저장·재조회, 기존 기상→출발 값 보존');

  const invalid = await c.send(base, {
    token, method: 'PATCH', body: { default_outing_prep_minutes: 241 },
  });
  assert(!invalid.ok && invalid.data?.code === '23514',
    '241분 범위 밖 값이 DB CHECK 제약으로 거절되지 않았습니다.');
  console.log('[5/7] 잘못된 순수 준비시간 241분 거절 (CHECK constraint)');

  // This portion tests database persistence with a BACKEND-LIKE service-role
  // fixture. It does NOT simulate a successful alarm-commit Edge invocation.
  const appointment = getKstAppointment();
  const title = '[LOCAL-PURE-PREP-E2E] 개인 일정';
  const apRows = await c.required('/rest/v1/appointments?select=appointment_id', {
    role: 'admin', method: 'POST', prefer: 'return=representation',
    body: {
      creator_id: userId, title, appointment_at: appointment.toISOString(),
      dest_name: '로컬 가상 목적지',
    },
  }, '테스트 일정 DB 생성');
  const appointmentId = apRows?.[0]?.appointment_id;
  assert(appointmentId, '테스트 일정 ID를 받지 못했습니다.');

  const ptRows = await c.required('/rest/v1/appointment_participants?select=participant_id', {
    role: 'admin', method: 'POST', prefer: 'return=representation',
    body: {
      appointment_id: appointmentId,
      user_id: userId,
      origin_name: '로컬 테스트 출발지',
      transport_type: 'TRANSIT',
      est_travel_minutes: 30,
      travel_source: 'MANUAL',
      prepare_minutes: originalLegacy,
      buffer_minutes: 10,
      prepare_value_source: 'LEGACY',
      outing_prep_minutes: 35,
      outing_prep_source: 'PROFILE',
    },
  }, '테스트 일정 참여조건 DB 생성');
  const participantId = ptRows?.[0]?.participant_id;
  assert(participantId, '테스트 참여 ID를 받지 못했습니다.');

  const minute = (n) => new Date(appointment.getTime() - n * 60_000).toISOString();
  const alarmRows = [
    { alarm_type: 'WAKE', scheduled_at: minute(95) },
    { alarm_type: 'PREPARE', scheduled_at: minute(75) },
    { alarm_type: 'DEPARTURE', scheduled_at: minute(40) },
  ].map((a) => ({
    ...a, user_id: userId, participant_id: participantId, is_enabled: true,
  }));
  await c.required('/rest/v1/alarms', {
    role: 'admin', method: 'POST', body: alarmRows,
    prefer: 'return=minimal',
  }, '로컬 테스트 알람 3개 DB 생성');

  const ownPt = await c.required('/rest/v1/appointment_participants?participant_id=eq.' +
    encodeURIComponent(participantId) +
    '&select=prepare_minutes,prepare_value_source,outing_prep_minutes,outing_prep_source', {
      token,
    }, '로그인 계정 참여조건 재조회');
  assert(ownPt?.length === 1 &&
    ownPt[0].prepare_minutes === originalLegacy &&
    ownPt[0].prepare_value_source === 'LEGACY' &&
    ownPt[0].outing_prep_minutes === 35 &&
    ownPt[0].outing_prep_source === 'PROFILE',
    '참여조건의 기존 값/순수 준비값/출처 재조회가 불일치합니다.');

  const ownAlarms = await c.required('/rest/v1/alarms?participant_id=eq.' +
    encodeURIComponent(participantId) + '&select=alarm_type,scheduled_at', {
      token,
    }, '로그인 계정 알람 재조회');
  assert(Array.isArray(ownAlarms) && ownAlarms.length === 3, '알람 3개를 본인 계정으로 재조회하지 못했습니다.');
  for (const a of alarmRows) {
    assert(ownAlarms.some((r) => r.alarm_type === a.alarm_type &&
      Date.parse(r.scheduled_at) === Date.parse(a.scheduled_at)),
      a.alarm_type + ' 알람의 DB 시각이 일치하지 않습니다.');
  }
  console.log('[6/7] 로컬 일정·참여조건·기상/준비/출발 알람 DB 저장 및 Auth/RLS 재조회 성공');

  console.log('\n========== 로컬 웹 로그인 전용 계정 ==========');
  console.log('이메일: ' + email);
  console.log('비밀번호: ' + password);
  console.log('DB: http://127.0.0.1:54323');
  console.log('테스트 화면: http://localhost:8081/dev/pure-prep?mode=real');
  console.log('테스트는 로컬 데이터만 변경했습니다. 운영 Supabase는 변경하지 않았습니다.');
  console.log('Edge alarm-commit, 반복 회차, Android 실제 울림은 아직 검증하지 않았습니다.');
  console.log('=============================================\n');

  // Critical: child process env overrides any mobile/.env cloud configuration.
  // Only a PUBLIC browser key is passed to Expo; never pass the service JWT.
  const env = {
    ...process.env,
    EXPO_PUBLIC_SUPABASE_URL: cfg.api,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: cfg.publishable,
    EXPO_PUBLIC_API_BASE_URL: '',
    EXPO_PUBLIC_DEMO_PASSWORD: '',
  };
  console.log('[7/7] 로컬 DB를 바라보도록 Expo 웹 실행 (Ctrl+C로 종료)');
  const child = spawn('npm', ['run', 'web'], {
    cwd: mobile, env, stdio: 'inherit',
  });
  child.on('error', (e) => { console.error('Expo 실행 오류:', e.message); process.exitCode = 1; });
  child.on('exit', (code) => { if (code) process.exitCode = code; });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

main().catch((error) => {
  // Never print API secrets, session tokens, or passwords in error paths.
  console.error('로컬 통합 시험 실패:', error?.message || String(error));
  process.exitCode = 1;
});
