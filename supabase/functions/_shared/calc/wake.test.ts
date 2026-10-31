// "그날 첫 일정" 판정 — 약속 시각이 앞선 약속의 켜진 기상만 셈 (알람이 울리는 시각이 아님)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasEarlierWake, type SameDayWake } from './wake.ts';

// 2025년 5월 22일 한국 시각 minutes분
const kst = (minutes: number) => new Date(Date.UTC(2025, 4, 22) + (minutes - 9 * 60) * 60_000);
const wakeOf = (appointmentMinutes: number, over: Partial<SameDayWake> = {}): SameDayWake => ({ appointmentAt: kst(appointmentMinutes), ...over });

test('10시 약속(기상 8:00)이 있는 날 8:30 새 약속 → 앞선 약속이 없으니 기상 있음 (그날 첫 일정)', () => {
  assert.equal(hasEarlierWake(kst(510), [wakeOf(600)]), false);
});

test('8시 약속이 이미 있는 날 10:00 새 약속 → 앞선 약속의 기상이 있으니 기상 없음', () => {
  assert.equal(hasEarlierWake(kst(600), [wakeOf(480)]), true);
});

test('같은 시각 약속 둘 → 서로 앞선 게 아니라 둘 다 기상을 가짐', () => {
  assert.equal(hasEarlierWake(kst(600), [wakeOf(600)]), false);
  // 한 분이라도 앞서면 앞선 것
  assert.equal(hasEarlierWake(kst(600), [wakeOf(599)]), true);
  assert.equal(hasEarlierWake(kst(600), [wakeOf(601)]), false);
});

test('앞선 약속이 둘 이상이거나 뒤의 약속이 섞여 있어도: 앞선 것이 하나라도 있으면 기상 없음', () => {
  assert.equal(hasEarlierWake(kst(720), [wakeOf(900), wakeOf(480), wakeOf(600)]), true);
  assert.equal(hasEarlierWake(kst(720), [wakeOf(900), wakeOf(1080)]), false);
});

test('꺼 둔 기상은 안 셈, isEnabled를 안 주면 켜짐', () => {
  assert.equal(hasEarlierWake(kst(600), [wakeOf(480, { isEnabled: false })]), false);
  assert.equal(hasEarlierWake(kst(600), [wakeOf(480, { isEnabled: false }), wakeOf(540, { isEnabled: true })]), true);
  assert.equal(hasEarlierWake(kst(600), [wakeOf(480)]), true);
});

test('이 약속 자신의 기상은 안 셈 (기존 약속을 다시 계산할 때)', () => {
  const own = wakeOf(480, { appointmentId: 'ap1' });
  assert.equal(hasEarlierWake(kst(600), [own], 'ap1'), false);
  assert.equal(hasEarlierWake(kst(600), [own], 'ap2'), true);
  assert.equal(hasEarlierWake(kst(600), [own]), true); // 새 약속이면 id가 없음
  // id가 없는 항목이 id 없는 호출과 같은 것으로 취급돼 빠지면 안 됨
  assert.equal(hasEarlierWake(kst(600), [wakeOf(480)], undefined), true);
});

test('같은 날 다른 약속이 없으면 기상 있음', () => {
  assert.equal(hasEarlierWake(kst(600), []), false);
});

// ---- 저녁 기상 (#320) ----
import { isEveningWake } from './wake.ts';

test('기상 시각이 11:59면 저녁 아님, 12:00 정각부터 저녁 (내 시간대 기준)', () => {
  assert.equal(isEveningWake(kst(11 * 60 + 59), 'Asia/Seoul'), false);
  assert.equal(isEveningWake(kst(12 * 60), 'Asia/Seoul'), true);
  assert.equal(isEveningWake(kst(23 * 60 + 30), 'Asia/Seoul'), true);
  assert.equal(isEveningWake(kst(0), 'Asia/Seoul'), false);
});

test('시간대: 서울 12:00 = UTC 03:00 경계. 시간대가 없거나 틀리면 서울', () => {
  assert.equal(isEveningWake(new Date('2025-05-22T02:59:00Z'), 'Asia/Seoul'), false);
  assert.equal(isEveningWake(new Date('2025-05-22T03:00:00Z'), 'Asia/Seoul'), true);
  assert.equal(isEveningWake(new Date('2025-05-22T03:00:00Z')), true);
  assert.equal(isEveningWake(new Date('2025-05-22T03:00:00Z'), 'No/Such_Zone'), true);
  // 같은 순간도 다른 시간대면 낮이 다름: UTC 03:00은 뉴욕에서 전날 밤 23:00 → 저녁, UTC 15:00은 뉴욕 11:00 → 아님
  assert.equal(isEveningWake(new Date('2025-05-22T03:00:00Z'), 'America/New_York'), true);
  assert.equal(isEveningWake(new Date('2025-05-22T15:00:00Z'), 'America/New_York'), false);
});

test('약속 날짜보다 전날인 기상(새벽 약속의 전날 밤 기상)은 저녁 기상이 아님', () => {
  const appointmentAt = kst(60); // 1:00
  const wakeAt = new Date(kst(60).getTime() - 110 * 60_000); // 전날 23:10
  assert.equal(isEveningWake(wakeAt, 'Asia/Seoul'), true);
  assert.equal(isEveningWake(wakeAt, 'Asia/Seoul', appointmentAt), false);
});
