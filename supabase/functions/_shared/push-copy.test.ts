// 푸시 종류 표 — 종류별 문구 · 채널 · 이동 경로 (친구 논리설계 11장 종류 표, 11-08)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHANNEL_IDS, CLIENT_KINDS, composeCopy, GROUP_KINDS, PATHS, SERVER_ONLY_KINDS, type PushKind } from './push-copy.ts';

const ALL: readonly PushKind[] = [...CLIENT_KINDS, ...SERVER_ONLY_KINDS];

test('종류 표: 앱이 부를 수 있는 6종 + 서버 배치만 보내는 미확인(WAKE_MISSED), 그룹 종류는 둘', () => {
  assert.deepEqual([...CLIENT_KINDS].sort(), ['ALARM_CHANGED', 'FRIEND_ACCEPTED', 'FRIEND_REQUEST', 'GROUP_APPT_CHANGED', 'GROUP_MEMBER_JOINED', 'WAKE_PING']);
  assert.deepEqual([...SERVER_ONLY_KINDS], ['WAKE_MISSED']);
  assert.deepEqual([...GROUP_KINDS].sort(), ['GROUP_APPT_CHANGED', 'GROUP_MEMBER_JOINED']);
});

test('채널: 5갈래(깨우기 / 알람 바뀜 / 요청 / 그룹 / 미확인), 모두 _v1, 요청 둘 · 그룹 둘은 같은 채널, 알람 코어 채널과 안 겹침', () => {
  assert.equal(new Set(ALL.map((k) => CHANNEL_IDS[k])).size, 5);
  assert.ok(ALL.every((k) => /^[a-z_]+_v1$/.test(CHANNEL_IDS[k])));
  assert.equal(CHANNEL_IDS.FRIEND_REQUEST, CHANNEL_IDS.FRIEND_ACCEPTED);
  assert.equal(CHANNEL_IDS.GROUP_MEMBER_JOINED, CHANNEL_IDS.GROUP_APPT_CHANGED);
  assert.ok(ALL.every((k) => CHANNEL_IDS[k] !== 'detect_v1'));
});

test('누르면 갈 화면 경로가 종류마다 있음 (받는 사람 id와 함께 알림 데이터에 실림)', () => {
  assert.ok(ALL.every((k) => /^\/[a-z-]+/.test(PATHS[k])));
  assert.equal(PATHS.WAKE_PING, '/wake');
  assert.equal(PATHS.WAKE_MISSED, '/wake');
});

test('문구는 종류별 고정: 깨우기 · 알람 바뀜은 보낸 사람 이름, 요청 · 수락 · 미확인은 고정 문구', () => {
  assert.deepEqual(composeCopy('WAKE_PING', { senderName: '수연' }), { title: '깨우기', body: '수연님이 깨워요' });
  assert.deepEqual(composeCopy('FRIEND_REQUEST', { senderName: '수연' }), { title: '친구 요청', body: '새 친구 요청이 도착했어요' });
  assert.deepEqual(composeCopy('FRIEND_ACCEPTED', { senderName: '수연' }), { title: '친구 요청', body: '친구 요청이 수락됐어요' });
  assert.deepEqual(composeCopy('WAKE_MISSED', {}), { title: '기상 확인', body: '기상 확인이 안 됐어요' });
  // 이름이 비어 있으면 '친구'
  assert.equal(composeCopy('WAKE_PING', {}).body, '친구님이 깨워요');
});

test('알람 바뀜: 이름 + 이전 → 새 시각을 받는 사람 시간대의 HH:mm으로, 시각이 없으면 이름만', () => {
  const body = (ctx: Parameters<typeof composeCopy>[1]) => composeCopy('ALARM_CHANGED', ctx).body;
  assert.equal(composeCopy('ALARM_CHANGED', { senderName: '수연' }).title, '알람이 바뀌었어요');
  assert.equal(body({ senderName: '수연', previousAt: '2026-11-08T22:00:00Z', newAt: '2026-11-08T22:10:00Z', timeZone: 'Asia/Seoul' }), '수연님이 알람을 바꿨어요 · 07:00 → 07:10');
  assert.equal(body({ senderName: '수연', previousAt: '2026-11-08T22:00:00Z', newAt: '2026-11-08T22:10:00Z', timeZone: 'America/New_York' }), '수연님이 알람을 바꿨어요 · 17:00 → 17:10');
  assert.equal(body({ senderName: '수연', previousAt: '2026-11-08T22:00:00Z', newAt: '2026-11-08T22:10:00Z' }), '수연님이 알람을 바꿨어요 · 07:00 → 07:10'); // 시간대 기본 Asia/Seoul
  assert.equal(body({ senderName: '수연' }), '수연님이 알람을 바꿨어요');
  assert.equal(body({ senderName: '수연', newAt: '2026-11-08T22:10:00Z' }), '수연님이 알람을 바꿨어요'); // 한쪽만 있으면 시각은 뺌
  assert.equal(body({ senderName: '수연', previousAt: 'nonsense', newAt: '2026-11-08T22:10:00Z' }), '수연님이 알람을 바꿨어요'); // 시각이 이상해도 문구는 만들어짐
});

test('그룹 알림은 그룹 · 약속만 — 사람 이름이 문구에 안 들어감', () => {
  assert.deepEqual(composeCopy('GROUP_MEMBER_JOINED', { senderName: '수연', groupName: '캡스톤팀' }), { title: '캡스톤팀', body: '새 멤버가 들어왔어요' });
  assert.deepEqual(composeCopy('GROUP_APPT_CHANGED', { senderName: '수연', groupName: '캡스톤팀', appointmentTitle: '팀 회의' }), { title: '캡스톤팀', body: '‘팀 회의’ 약속이 바뀌었어요' });
  assert.ok(!JSON.stringify(composeCopy('GROUP_MEMBER_JOINED', { senderName: '수연', groupName: '캡스톤팀' })).includes('수연'));
  assert.deepEqual(composeCopy('GROUP_APPT_CHANGED', {}), { title: '그룹', body: '약속이 바뀌었어요' });
});

test('이름이 길면 잘라서 제목 100자 · 본문 200자를 넘지 않음 (Expo 한도 안)', () => {
  const long = '가'.repeat(300);
  const group = composeCopy('GROUP_APPT_CHANGED', { groupName: long, appointmentTitle: long });
  assert.ok(group.title.length <= 100 && group.body.length <= 200 && group.title.endsWith('…') && group.body.endsWith('약속이 바뀌었어요'));
  const wake = composeCopy('WAKE_PING', { senderName: long });
  assert.ok(wake.body.length <= 200);
});
