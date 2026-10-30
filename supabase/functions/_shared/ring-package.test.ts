// 예약 꾸러미의 알림 문구 — 준비("출발까지 N분") · 출발("지금 나가면 … 도착 · 여유") · 기상(voiceText). 서버와 앱이 같은 함수를 씀
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { axesOf, buildRingPackages, departureNotice, prepareNotice, wakeVoiceText, type AppointmentNotice, type PackageSource, type RingPackage } from './ring-package.ts';

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

test('문구를 못 만들어도(이상한 시각) 꾸러미는 그대로 만들어지고, 무엇이 실패했는지 한 줄 남김', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const pkgs = byType(build(CHAIN, { ...APPOINTMENT, appointmentAt: new Date(Number.NaN) }));
    assert.equal(Object.keys(pkgs).length, 4);
    assert.deepEqual([pkgs.DEPARTURE.notice, pkgs.WAKE.voiceText], [undefined, undefined]);
    assert.equal(pkgs.PREPARE.notice, '오전 9:00 출발까지 30분'); // 약속 시각과 상관없는 문구는 남음
    // 던진 문구(시각 서식 실패 = 기상 음성 문장)만 한 줄 — 알람 종류 · id · 오류만, 제목 · 장소 같은 사용자 글자는 없음.
    // 출발 문구는 값을 못 읽으면 던지지 않고 빠지므로 경고 없음
    const lines = warn.mock.calls.map((call) => String(call.arguments[0]));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[ring-package\] WAKE 문구를 못 만들어/);
    assert.match(lines[0], /알람 a-WAKE\)/);
    assert.match(lines[0], /RangeError/);
    assert.doesNotMatch(lines[0], /전공 수업|광개토관/);
  } finally {
    warn.mock.restore();
  }
});

test('문구가 잘 만들어지면 경고를 남기지 않음', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    build(CHAIN);
    assert.equal(warn.mock.calls.length, 0);
  } finally {
    warn.mock.restore();
  }
});

test('기상 음성 문장의 이에요 · 예요: 제목 끝이 숫자면 읽는 소리, 닫는 괄호면 괄호 앞 글자, 영문 · 기타는 받침 없음', () => {
  const sentence = (title: string) => wakeVoiceText({ title, appointmentAt: kst(600), timeZone: TZ }).split('오전 10시 ')[1].replace(/\.$/, '');
  // 숫자: 0 영 · 1 일 · 3 삼 · 6 육 · 7 칠 · 8 팔은 받침 있음, 2 · 4 · 5 · 9는 없음
  assert.equal(sentence('영어 1'), '영어 1이에요');
  assert.equal(sentence('캡스톤 2'), '캡스톤 2예요');
  for (const [digit, batchim] of Object.entries({ 0: true, 1: true, 2: false, 3: true, 4: false, 5: false, 6: true, 7: true, 8: true, 9: false })) {
    assert.equal(sentence(`실습 ${digit}`), `실습 ${digit}${batchim ? '이에요' : '예요'}`);
  }
  assert.equal(sentence('실습 10'), '실습 10이에요'); // 십 · 끝자리 0은 늘 받침
  // 닫는 괄호: 괄호 안은 빼고 그 앞 글자로
  assert.equal(sentence('자료구조(월)'), '자료구조(월)예요');
  assert.equal(sentence('전공 수업(월)'), '전공 수업(월)이에요');
  assert.equal(sentence('영어 (3)'), '영어 (3)예요'); // 괄호 앞은 "영어"
  assert.equal(sentence('영어 2 (3)'), '영어 2 (3)예요'); // 괄호 앞 글자는 2
  assert.equal(sentence('영어 1 (월)'), '영어 1 (월)이에요');
  assert.equal(sentence('자료구조[월]'), '자료구조[월]예요');
  assert.equal(sentence('자료구조（월）'), '자료구조（월）예요');
  assert.equal(sentence('자료구조 (A반(월))'), '자료구조 (A반(월))예요'); // 겹친 괄호도 통째로 뺌
  assert.equal(sentence('자료구조(월)(화)'), '자료구조(월)(화)예요'); // 괄호가 이어져도 앞 글자로
  assert.equal(sentence('밥(월)(화)'), '밥(월)(화)이에요'); // 앞 글자 밥은 받침
  // 영문 · 기타는 지금처럼 받침 없음
  assert.equal(sentence('Capstone'), 'Capstone예요');
  assert.equal(sentence('팀 회의!'), '팀 회의!예요');
  // 괄호만 있거나 짝이 안 맞으면 있는 그대로
  assert.equal(sentence('(월)'), '(월)예요');
  assert.equal(sentence('밥)'), '밥)예요');
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

test('축별 선택을 끄면(axesEnabled false) 저장된 소리 · 진동 · 말소리를 무시하고 강도를 따름 — 켜면 저장된 값이 그대로 살아 있음 (D1 A flag, 헤드 확정 10/30)', () => {
  const stored = { sound_key: 'theme_urgent', vibration: 'NONE', voice_tone: 'DIRECT', intensity: 'NORMAL' } as const;
  assert.deepEqual(axesOf(stored, true), { soundKey: 'theme_urgent', vibration: 'NONE', voiceTone: 'DIRECT' });
  assert.deepEqual(axesOf(stored, false), { soundKey: 'theme_default', vibration: 'SHORT_REPEAT', voiceTone: null });
  assert.deepEqual(axesOf({ ...stored, intensity: 'STRONG' }, false), { soundKey: 'theme_urgent', vibration: 'STRONG_CONTINUOUS', voiceTone: null });
});
