// alarm-commit이 쓸 내용 정하기 + 예약 꾸러미 + 취소 목록
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildEditLogRows, diffAlarms } from './commit-core.ts';
import { computePlan, type AlarmRow, type Plan, type PlanDraft, type PlanInputs, type ProfileRow } from './plan-core.ts';
import { buildRingPackages, canceledAlarmIds, subtitleFor } from './ring-package.ts';
import type { ResolvedTravel } from './route.ts';

const kst = (day: number, minutes: number) => new Date(Date.UTC(2025, 4, day) + (minutes - 9 * 60) * 60_000);
const hm = (iso: string) => {
  const d = new Date(iso);
  const m = (d.getUTCHours() * 60 + d.getUTCMinutes() + 9 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const profile: ProfileRow = { timezone: 'Asia/Seoul', default_buffer_minutes: 10, default_transport: 'TRANSIT', home_name: null, home_lat: null, home_lng: null };
const travel: ResolvedTravel = {
  chosen: { minutes: 50, source: 'API', needsConfirmation: false, note: '' },
  auto: { minutes: 50, source: 'API', needsConfirmation: false, note: '' },
  warnings: [],
};
const NOW = kst(22, 400); // 6:40

const plan = (draft: Partial<PlanDraft> = {}, over: Partial<PlanInputs> = {}): Plan =>
  computePlan(
    {
      now: NOW,
      draft: { at: kst(22, 600), destination: { name: '세종대학교' }, prepareMinutes: 60, beforePrepareMinutes: 30, ...draft },
      profile,
      existingAlarms: [],
      stats: { sampleCount: 0, p80: null },
      lateCount4w: 1,
      sameDayWake: false,
      ...over,
    },
    travel,
  );
const row = (type: AlarmRow['alarm_type'], minutes: number, over: Partial<AlarmRow> = {}): AlarmRow => ({
  alarm_id: `id-${type}`, participant_id: 'pt', user_id: 'u', alarm_type: type, scheduled_at: kst(22, minutes).toISOString(),
  intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_default', is_enabled: true, snooze_limit: 3,
  time_source: 'AUTO', intensity_source: 'AUTO', recurrence_rule: null, ...over,
});

test('새 약속: 4개 알람을 만듦 (기상 · 준비 · 출발 · 도착 목표), 모두 자동 출처', () => {
  const diff = diffAlarms(plan(), [], { now: NOW, replaceExisting: true });
  assert.deepEqual(diff.insert.map((a) => `${a.alarm_type} ${hm(a.scheduled_at)} ${a.is_enabled} ${a.time_source}/${a.intensity_source}`), [
    'WAKE 08:00 true AUTO/AUTO',
    'PREPARE 08:30 true AUTO/AUTO',
    'DEPARTURE 09:00 true AUTO/AUTO',
    'ARRIVE 09:50 true AUTO/AUTO',
  ]);
  assert.deepEqual(diff.update, []);
  assert.deepEqual(diff.remove, []);
  assert.deepEqual([diff.insert[0].intensity, diff.insert[0].voice_tone, diff.insert[0].sound_key], ['NORMAL', 'NEUTRAL', 'theme_default']);
});

test('직접 고른 시각 · 강도는 MANUAL 출처로 (따라온 준비는 AUTO)', () => {
  const p = plan({ manualTimes: { WAKE: kst(22, 450) }, levels: { vibration: 2 } });
  const diff = diffAlarms(p, [], { now: NOW, replaceExisting: true });
  const by = Object.fromEntries(diff.insert.map((a) => [a.alarm_type, a]));
  assert.equal(by.WAKE.time_source, 'MANUAL');
  assert.equal(by.PREPARE.time_source, 'AUTO');
  assert.equal(hm(by.PREPARE.scheduled_at), '08:00');
  assert.ok(diff.insert.every((a) => a.intensity_source === 'MANUAL' && a.intensity === 'STRONG'));
});

test('알람 없는 일정(kinds [])은 아무것도 만들지 않고 있던 알람은 지움', () => {
  const none = diffAlarms(plan({ kinds: [] }), [], { now: NOW, replaceExisting: true });
  assert.deepEqual(none, { insert: [], update: [], remove: [] });
  const had = diffAlarms(plan({ kinds: [] }), [row('WAKE', 480), row('ARRIVE', 590)], { now: NOW, replaceExisting: true });
  assert.deepEqual(had.remove.sort(), ['id-ARRIVE', 'id-WAKE']);
});

test('같은 종류는 고치고(update) 없어진 종류만 지움, replace_existing false면 안 지움', () => {
  const existing = [row('WAKE', 470), row('PREPARE', 500), row('DEPARTURE', 540), row('ARRIVE', 590)];
  const p = plan({ kinds: ['WAKE'] }, { existingAlarms: existing });
  const diff = diffAlarms(p, existing, { now: NOW, replaceExisting: true });
  assert.deepEqual(diff.update.map((u) => [u.alarm_id, hm(u.patch.scheduled_at)]), [['id-WAKE', '08:00'], ['id-ARRIVE', '09:50']]);
  assert.deepEqual(diff.remove.sort(), ['id-DEPARTURE', 'id-PREPARE']);
  assert.deepEqual(diffAlarms(p, existing, { now: NOW, replaceExisting: false }).remove, []);
});

test('지난 알림은 꺼서 저장, 사용자가 끈 알람은 꺼진 채로, 지나서 꺼졌던 알람은 새 시각으로 다시 켬', () => {
  // 지금 7:58 → 기상 8:00은 지난 알림 (8.2.1)
  const passed = diffAlarms(plan({}, { now: kst(22, 478) }), [], { now: kst(22, 478), replaceExisting: true });
  assert.deepEqual(passed.insert.map((a) => a.is_enabled), [false, true, true, true]);

  const existing = [row('WAKE', 480, { is_enabled: false }), row('DEPARTURE', 540, { is_enabled: false })];
  const p = plan({}, { existingAlarms: existing });
  const diff = diffAlarms(p, existing, { now: NOW, replaceExisting: true });
  const byType = Object.fromEntries(diff.update.map((u) => [u.patch.alarm_type, u.patch.is_enabled]));
  assert.equal(byType.WAKE, false); // 옛 시각 8:00이 아직 안 지남 → 사용자가 끈 것
  assert.equal(byType.DEPARTURE, false);

  // 옛 시각이 이미 지난 알람은 지나서 꺼진 것으로 봄 → 새 시각으로 켬
  const stale = [row('WAKE', 480, { is_enabled: false }), row('DEPARTURE', 490, { is_enabled: false })]; // 출발의 옛 시각 8:10 — 지금 8:20이면 이미 지남
  const later = diffAlarms(plan({}, { existingAlarms: stale, now: kst(22, 500) }), stale, { now: kst(22, 500), replaceExisting: true });
  const wake = later.update.find((u) => u.patch.alarm_type === 'WAKE');
  assert.equal(wake?.patch.is_enabled, false); // 새 기상 8:00도 이미 지났으므로 꺼짐
  assert.equal(later.update.find((u) => u.patch.alarm_type === 'DEPARTURE')?.patch.is_enabled, true);
});

test('요청의 enabled가 먼저 (H03 종류별 켜기 · 끄기)', () => {
  const existing = [row('WAKE', 480, { is_enabled: false }), row('PREPARE', 510), row('DEPARTURE', 540), row('ARRIVE', 590)];
  const p = plan({}, { existingAlarms: existing });
  const diff = diffAlarms(p, existing, { now: NOW, enabled: { WAKE: true, PREPARE: false }, replaceExisting: true });
  const byType = Object.fromEntries(diff.update.map((u) => [u.patch.alarm_type, u.patch.is_enabled]));
  assert.deepEqual(byType, { WAKE: true, PREPARE: false, DEPARTURE: true, ARRIVE: true });
});

test('검증을 통과 못 한 계획은 쓰지 않음', () => {
  assert.throws(() => diffAlarms(plan({}, { now: kst(22, 545) }), [], { now: kst(22, 545), replaceExisting: true }));
});

test('예약 꾸러미: 켜진 알람만, 알람 코어 RingPackage 칸 이름, 시각순', () => {
  const alarms = [
    { alarm_id: 'a2', alarm_type: 'DEPARTURE' as const, scheduled_at: kst(22, 540).toISOString(), intensity: 'NORMAL' as const, sound_key: 'theme_default', snooze_limit: 3, is_enabled: true },
    { alarm_id: 'a1', alarm_type: 'WAKE' as const, scheduled_at: kst(22, 480).toISOString(), intensity: 'STRONG' as const, sound_key: 'theme_urgent', snooze_limit: 3, is_enabled: true },
    { alarm_id: 'a3', alarm_type: 'PREPARE' as const, scheduled_at: kst(22, 510).toISOString(), intensity: 'NORMAL' as const, sound_key: null, snooze_limit: 3, is_enabled: false },
  ];
  const pkgs = buildRingPackages({ alarms, title: '팀 주간회의', subtitle: '오전 10:00 · 세종대학교', departAt: kst(22, 540) });
  assert.deepEqual(pkgs, [
    { alarmId: 'a1', type: 'WAKE', atMillis: kst(22, 480).getTime(), title: '팀 주간회의', subtitle: '오전 10:00 · 세종대학교', intensity: 'STRONG', snoozeLimit: 3, soundKey: 'theme_urgent', departAt: kst(22, 540).getTime() },
    { alarmId: 'a2', type: 'DEPARTURE', atMillis: kst(22, 540).getTime(), title: '팀 주간회의', subtitle: '오전 10:00 · 세종대학교', intensity: 'NORMAL', snoozeLimit: 3, soundKey: 'theme_default', departAt: kst(22, 540).getTime() },
  ]);
});

test('취소할 예약: 지워졌거나 꺼진 알람 (canceled_alarm_ids)', () => {
  const before = [{ alarm_id: 'a' }, { alarm_id: 'b' }, { alarm_id: 'c' }];
  const after = [{ alarm_id: 'a', is_enabled: true }, { alarm_id: 'b', is_enabled: false }, { alarm_id: 'n', is_enabled: true }];
  assert.deepEqual(canceledAlarmIds({ before, after }), ['b', 'c']);
  assert.deepEqual(canceledAlarmIds({ before: [], after }), []);
});

test('꾸러미 부제: 오전 10:00 · 장소', () => {
  assert.equal(subtitleFor(kst(22, 600), '세종대학교', 'Asia/Seoul'), '오전 10:00 · 세종대학교');
  assert.equal(subtitleFor(kst(22, 600), null, 'Asia/Seoul'), '오전 10:00');
});

test('고친 값 기록: 알람 종류로 가리킨 줄에 저장된 알람 id를 붙임, 되돌림은 edited_value null', () => {
  const rows = buildEditLogRows('u', 'ap', [{ alarm_id: 'w', alarm_type: 'WAKE' }], [
    { screen: 'H05', field: 'scheduled_at', alarmType: 'WAKE', autoValue: 'a', editedValue: 'b' },
    { screen: 'H03', field: 'buffer_minutes', autoValue: 10, editedValue: 20 },
    { screen: 'H03', field: 'scheduled_at', alarmType: 'PREPARE', autoValue: 'c', editedValue: null },
  ]);
  assert.deepEqual(rows[0], { user_id: 'u', appointment_id: 'ap', alarm_id: 'w', screen: 'H05', field: 'scheduled_at', alarm_type: 'WAKE', auto_value: 'a', edited_value: 'b' });
  assert.equal(rows[1].alarm_id, null);
  assert.equal(rows[1].alarm_type, null);
  assert.equal(rows[2].alarm_id, null); // 그 종류의 알람이 없으면 비움
  assert.equal(rows[2].edited_value, null);
});
