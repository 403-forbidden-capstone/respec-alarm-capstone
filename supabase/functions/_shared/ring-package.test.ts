// 예약 꾸러미의 알림 문구 — 준비("출발까지 N분") · 출발("지금 나가면 … 도착 · 여유") · 기상(voiceText). 서버와 앱이 같은 함수를 씀
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRingPackages, departureNotice, prepareNotice, wakeVoiceText, type AppointmentNotice, type PackageSource, type RingPackage } from './ring-package.ts';

const TZ = 'Asia/Seoul';
// 2025년 5월 22일 한국 시각 minutes분
const kst = (minutes: number) => new Date(Date.UTC(2025, 4, 22) + (minutes - 9 * 60) * 60_000);

const row = (alarm_type: PackageSource['alarm_type'], minutes: number, over: Partial<PackageSource> = {}): PackageSource => ({
  alarm_id: `a-${alarm_type}`,
  alarm_type,
  scheduled_at: kst(minutes).toISOString(),
  intensity: 'NORMAL',
  sound_key: null,
  snooze_limit: 3,
  is_enabled: true,
  ...over,
});
// 10시 약속 · 이동 50 · 여유 10 · 준비 60 · 준비 전 활동 30 → 기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 9:50
const CHAIN = [row('WAKE', 480), row('PREPARE', 510), row('DEPARTURE', 540), row('ARRIVE', 590)];
const APPOINTMENT: AppointmentNotice = { appointmentAt: kst(600), travelMinutes: 50, timeZone: TZ };
const build = (alarms: readonly PackageSource[], appointment: AppointmentNotice = APPOINTMENT, title = '전공 수업') =>
  buildRingPackages({ alarms, title, subtitle: '오전 10:00 · 광개토관', departAt: kst(540), appointment });
const byType = (pkgs: RingPackage[]) => Object.fromEntries(pkgs.map((p) => [p.type, p]));

test('준비 · 출발 · 기상 문구가 약속 알람 꾸러미에 실림, 도착은 그대로', () => {
  const pkgs = byType(build(CHAIN));
  assert.equal(pkgs.PREPARE.notice, '오전 9:00 출발까지 30분');
  assert.equal(pkgs.DEPARTURE.notice, '지금 나가면 오전 9:50 도착 · 여유 10분');
  assert.equal(pkgs.WAKE.voiceText, '좋은 아침이에요. 오늘 첫 일정은 오전 10시 전공 수업이에요. 오전 9시에 나가면 돼요.');
  assert.equal(pkgs.WAKE.notice, undefined); // 기상 화면 줄(일어날 시간이에요)은 알람 코어의 기본 그대로
  assert.deepEqual([pkgs.ARRIVE.notice, pkgs.ARRIVE.voiceText], [undefined, undefined]);
  assert.deepEqual([pkgs.PREPARE.voiceText, pkgs.DEPARTURE.voiceText], [undefined, undefined]);
});

test('appointment를 안 넘기면(일정 없는 알람 · 루틴) 문구 칸이 아예 없음', () => {
  const pkgs = buildRingPackages({ alarms: CHAIN, title: '알람', subtitle: '오전 10:00' });
  assert.equal(pkgs.length, 4);
  for (const p of pkgs) assert.deepEqual(Object.keys(p).filter((k) => k === 'notice' || k === 'voiceText'), []);
});

test('출발 문구의 도착은 출발 알람 시각 + 이동분 (직접 고른 출발이면 약속 − 여유로 세지 않음)', () => {
  const at = (minutes: number) => byType(build([row('PREPARE', 500), row('DEPARTURE', minutes)])).DEPARTURE.notice;
  assert.equal(at(530), '지금 나가면 오전 9:40 도착 · 여유 20분'); // 9:00보다 10분 일찍 직접 고름
  assert.equal(at(550), '지금 나가면 오전 10:00 도착 · 여유 없음');
  assert.equal(at(560), '지금 나가면 오전 10:10 도착 · 10분 늦어요');
  assert.equal(at(480), '지금 나가면 오전 8:50 도착 · 여유 1시간 10분'); // 60분 넘으면 시간 단위
  assert.equal(at(420), '지금 나가면 오전 7:50 도착 · 여유 2시간 10분');
});

test('준비 문구: 60분 이상이면 1시간 10분처럼, 출발과 같거나 뒤면 문구 없음', () => {
  assert.equal(prepareNotice({ prepareAt: kst(470), departAt: kst(540), timeZone: TZ }), '오전 9:00 출발까지 1시간 10분');
  assert.equal(prepareNotice({ prepareAt: kst(480), departAt: kst(540), timeZone: TZ }), '오전 9:00 출발까지 1시간');
  assert.equal(prepareNotice({ prepareAt: kst(540), departAt: kst(540), timeZone: TZ }), undefined);
  assert.equal(prepareNotice({ prepareAt: kst(545), departAt: kst(540), timeZone: TZ }), undefined);
});

test('출발 알람이 꺼져 있으면 준비 문구 · 기상의 나갈 시각 문장이 빠짐 (출발 알람이 없는 일정)', () => {
  const pkgs = byType(build([row('WAKE', 480), row('PREPARE', 510), row('DEPARTURE', 540, { is_enabled: false })]));
  assert.equal(pkgs.PREPARE.notice, undefined);
  assert.equal(pkgs.DEPARTURE, undefined);
  assert.equal(pkgs.WAKE.voiceText, '좋은 아침이에요. 오늘 첫 일정은 오전 10시 전공 수업이에요.');
});

test('이동 시간을 모르면 출발 문구만 빠짐', () => {
  for (const travelMinutes of [null, undefined, Number.NaN]) {
    const pkgs = byType(build(CHAIN, { ...APPOINTMENT, travelMinutes }));
    assert.equal(pkgs.DEPARTURE.notice, undefined);
    assert.equal(pkgs.PREPARE.notice, '오전 9:00 출발까지 30분');
  }
});

test('기상 음성 문장: 받침에 따라 이에요 · 예요, 분이 있으면 풀어 읽음', () => {
  assert.equal(wakeVoiceText({ title: '팀 주간회의', appointmentAt: kst(600), departAt: kst(520), timeZone: TZ }), '좋은 아침이에요. 오늘 첫 일정은 오전 10시 팀 주간회의예요. 오전 8시 40분에 나가면 돼요.');
  assert.equal(wakeVoiceText({ title: '전공 수업', appointmentAt: kst(870), departAt: kst(810), timeZone: TZ }), '좋은 아침이에요. 오늘 첫 일정은 오후 2시 30분 전공 수업이에요. 오후 1시 30분에 나가면 돼요.');
  assert.equal(wakeVoiceText({ title: '  ', appointmentAt: kst(600), timeZone: TZ }), '좋은 아침이에요. 오늘 첫 일정은 오전 10시 일정이에요.');
});

test('문구를 못 만들어도(이상한 시각) 꾸러미는 그대로 만들어짐', () => {
  const pkgs = byType(build(CHAIN, { ...APPOINTMENT, appointmentAt: new Date(Number.NaN) }));
  assert.equal(Object.keys(pkgs).length, 4);
  assert.deepEqual([pkgs.DEPARTURE.notice, pkgs.WAKE.voiceText], [undefined, undefined]);
  assert.equal(pkgs.PREPARE.notice, '오전 9:00 출발까지 30분'); // 약속 시각과 상관없는 문구는 남음
});

test('문구가 붙어도 제목 · 부제 · 출발 시각 칸은 그대로이고, 들어온 순서와 상관없이 같은 꾸러미 (시각순)', () => {
  const [wake, prepare, departure, arrive] = build(CHAIN);
  assert.deepEqual(
    [wake, prepare, departure, arrive].map((p) => [p.type, p.title, p.subtitle, p.departAt]),
    ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'].map((type) => [type, '전공 수업', '오전 10:00 · 광개토관', kst(540).getTime()]),
  );
  assert.deepEqual(build([...CHAIN].reverse()), build(CHAIN)); // 들어온 순서와 상관없이 시각순
});

test('출발 문구 단독', () => {
  assert.equal(departureNotice({ departAt: kst(540), appointmentAt: kst(600), travelMinutes: 50, timeZone: TZ }), '지금 나가면 오전 9:50 도착 · 여유 10분');
});
