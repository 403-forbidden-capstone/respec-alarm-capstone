// 푸시 종류 표 — 종류별 문구 · 채널 · 이동 경로 (친구 논리설계 11장 종류 표, 11-08)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHANNEL_IDS, CLIENT_KINDS, composeCopy, GROUP_KINDS, PATHS, SERVER_ONLY_KINDS, type PushKind } from './push-copy.ts';

const ALL: readonly PushKind[] = [...CLIENT_KINDS, ...SERVER_ONLY_KINDS];

test('종류 표: 앱이 부를 수 있는 6종 + 서버 배치만 보내는 미확인 셋(본인 WAKE_MISSED · 친구 WAKE_NUDGE · 후속 WAKE_NUDGE_UP), 그룹 종류는 둘', () => {
  assert.deepEqual([...CLIENT_KINDS].sort(), ['ALARM_CHANGED', 'FRIEND_ACCEPTED', 'FRIEND_REQUEST', 'GROUP_APPT_CHANGED', 'GROUP_MEMBER_JOINED', 'WAKE_PING']);
  assert.deepEqual([...SERVER_ONLY_KINDS], ['WAKE_MISSED', 'WAKE_NUDGE', 'WAKE_NUDGE_UP']);
  assert.deepEqual([...GROUP_KINDS].sort(), ['GROUP_APPT_CHANGED', 'GROUP_MEMBER_JOINED']);
});

test('채널: 5갈래(깨우기 / 알람 바뀜 / 요청 / 그룹 / 미확인), 모두 _v1, 요청 둘 · 그룹 둘 · 친구 미확인 둘은 같은 채널, 알람 코어 채널과 안 겹침', () => {
  assert.equal(new Set(ALL.map((k) => CHANNEL_IDS[k])).size, 5);
  assert.ok(ALL.every((k) => /^[a-z_]+_v1$/.test(CHANNEL_IDS[k])));
  assert.equal(CHANNEL_IDS.FRIEND_REQUEST, CHANNEL_IDS.FRIEND_ACCEPTED);
  assert.equal(CHANNEL_IDS.GROUP_MEMBER_JOINED, CHANNEL_IDS.GROUP_APPT_CHANGED);
  assert.equal(CHANNEL_IDS.WAKE_NUDGE, CHANNEL_IDS.WAKE_PING); // 친구가 보낸 성격이라 깨우기와 같은 채널(친구 채널)
  assert.equal(CHANNEL_IDS.WAKE_NUDGE_UP, CHANNEL_IDS.WAKE_PING);
  assert.ok(ALL.every((k) => CHANNEL_IDS[k] !== 'detect_v1'));
});

test('누르면 갈 화면 경로가 종류마다 있음 (받는 사람 id와 함께 알림 데이터에 실림)', () => {
  assert.ok(ALL.every((k) => /^\/[a-z-]+/.test(PATHS[k])));
  assert.equal(PATHS.WAKE_PING, '/wake');
  assert.equal(PATHS.WAKE_MISSED, '/wake');
  assert.equal(PATHS.WAKE_NUDGE, '/group'); // 친구 미확인 · 후속은 그 사람의 기상 확인(G03)
  assert.equal(PATHS.WAKE_NUDGE_UP, '/group');
});

test('문구는 종류별 고정: 깨우기 · 알람 바뀜은 보낸 사람 이름, 요청 · 수락 · 미확인은 고정 문구', () => {
  assert.deepEqual(composeCopy('WAKE_PING', { senderName: '수연' }), { title: '깨우기', body: '수연님이 깨워요' });
  assert.deepEqual(composeCopy('FRIEND_REQUEST', { senderName: '수연' }), { title: '친구 요청', body: '새 친구 요청이 도착했어요' });
  assert.deepEqual(composeCopy('FRIEND_ACCEPTED', { senderName: '수연' }), { title: '친구 요청', body: '친구 요청이 수락됐어요' });
  assert.deepEqual(composeCopy('WAKE_MISSED', {}), { title: '기상 확인', body: '기상 확인이 안 됐어요' });
  // 이름이 비어 있으면 '친구'
  assert.equal(composeCopy('WAKE_PING', {}).body, '친구님이 깨워요');
});

test('친구 미확인 · 후속: 안 일어난(일어난) 사람 이름만 문구에, 이름이 없으면 친구', () => {
  assert.deepEqual(composeCopy('WAKE_NUDGE', { subjectName: '지형', senderName: '수연' }), { title: '깨워 볼까요?', body: '지형님이 아직 안 일어났어요' });
  assert.deepEqual(composeCopy('WAKE_NUDGE_UP', { subjectName: '지형' }), { title: '일어났어요', body: '지형님이 일어났어요' });
  assert.equal(composeCopy('WAKE_NUDGE', {}).body, '친구님이 아직 안 일어났어요');
  assert.ok(composeCopy('WAKE_NUDGE', { subjectName: '가'.repeat(300) }).body.length <= 200);
});

const NOW = new Date('2026-11-08T12:00:00Z'); // 한국 11/8 21:00

test('10-37: 알람 제안 문구 — "○○님이 내일 기상 알람을 7:30 → 7:00으로 제안했어요" (이름 + 날짜 말 + 알람 종류 + 이전 → 새 시각, 받는 사람 시간대의 H:mm), 원래대로 보낸 건 원래 시각', () => {
  const body = (ctx: Parameters<typeof composeCopy>[1]) => composeCopy('ALARM_CHANGED', { now: NOW, ...ctx }).body;
  assert.equal(composeCopy('ALARM_CHANGED', { senderName: '수연' }).title, '알람 제안');
  assert.equal(body({ senderName: '수연', alarmType: 'WAKE', previousAt: '2026-11-08T22:30:00Z', newAt: '2026-11-08T22:00:00Z', timeZone: 'Asia/Seoul' }), '수연님이 내일 기상 알람을 7:30 → 7:00으로 제안했어요');
  assert.equal(body({ senderName: '수연', alarmType: 'WAKE', previousAt: '2026-11-08T22:00:00Z', newAt: '2026-11-08T22:30:00Z' }), '수연님이 내일 기상 알람을 7:00 → 7:30으로 제안했어요'); // 시간대 기본 Asia/Seoul, 원래대로
  assert.equal(body({ senderName: '수연', alarmType: 'WAKE', previousAt: '2026-11-08T23:00:00Z', newAt: '2026-11-08T22:55:00Z' }), '수연님이 내일 기상 알람을 8:00 → 7:55로 제안했어요');
  assert.equal(body({ senderName: '수연', alarmType: 'DEPARTURE', previousAt: '2026-11-09T05:00:00Z', newAt: '2026-11-09T05:05:00Z', timeZone: 'America/New_York' }), '수연님이 내일 출발 알람을 0:00 → 0:05로 제안했어요');
});

test('알람 제안 문구: 날짜 말(오늘 · 내일 · 모레 · 그 밖은 M월 D일, 받는 사람 시간대 기준), 알람 종류(기상 · 준비 · 출발 · 도착, 모르면 생략)', () => {
  const copy = (alarmType: string | undefined, at: string) => composeCopy('ALARM_CHANGED', { now: NOW, senderName: '수연', ...(alarmType ? { alarmType } : {}), previousAt: at, newAt: at.replace(/:00:00Z$/, ':05:00Z') }).body;
  assert.equal(copy('WAKE', '2026-11-08T13:00:00Z'), '수연님이 오늘 기상 알람을 22:00 → 22:05로 제안했어요'); // 한국 11/8 22:00
  assert.equal(copy('WAKE', '2026-11-08T22:00:00Z'), '수연님이 내일 기상 알람을 7:00 → 7:05로 제안했어요');
  assert.equal(copy('WAKE', '2026-11-09T22:00:00Z'), '수연님이 모레 기상 알람을 7:00 → 7:05로 제안했어요');
  assert.equal(copy('WAKE', '2026-11-12T22:00:00Z'), '수연님이 11월 13일 기상 알람을 7:00 → 7:05로 제안했어요');
  assert.equal(copy('PREPARE', '2026-11-08T22:00:00Z'), '수연님이 내일 준비 알람을 7:00 → 7:05로 제안했어요');
  assert.equal(copy('DEPARTURE', '2026-11-08T22:00:00Z'), '수연님이 내일 출발 알람을 7:00 → 7:05로 제안했어요');
  assert.equal(copy('ARRIVE', '2026-11-08T22:00:00Z'), '수연님이 내일 도착 알람을 7:00 → 7:05로 제안했어요');
  assert.equal(copy(undefined, '2026-11-08T22:00:00Z'), '수연님이 내일 알람을 7:00 → 7:05로 제안했어요');
  // 받는 사람 시간대 기준 날짜 (뉴욕은 UTC-5): 한국 11/9 07:00은 뉴욕 11/8 17:00 → 오늘
  assert.equal(composeCopy('ALARM_CHANGED', { now: NOW, senderName: '수연', alarmType: 'WAKE', previousAt: '2026-11-08T22:00:00Z', newAt: '2026-11-08T22:05:00Z', timeZone: 'America/New_York' }).body, '수연님이 오늘 기상 알람을 17:00 → 17:05로 제안했어요');
});

test('알람 제안 문구: 시각 뒤 조사 — 마지막 숫자를 읽었을 때 받침이 있으면(영 · 삼 · 육) 으로, 없으면 로', () => {
  const tail = (minute: string) => composeCopy('ALARM_CHANGED', { now: NOW, senderName: '수연', alarmType: 'WAKE', previousAt: '2026-11-08T22:30:00Z', newAt: `2026-11-08T22:${minute}:00Z` }).body;
  const expected: Record<string, string> = { '00': '으로', '01': '로', '02': '로', '03': '으로', '04': '로', '05': '로', '06': '으로', '07': '로', '08': '로', '09': '로', '10': '으로', '15': '로', '20': '으로', '55': '로' };
  for (const [minute, particle] of Object.entries(expected)) {
    assert.equal(tail(minute), `수연님이 내일 기상 알람을 7:30 → 7:${minute}${particle} 제안했어요`, minute);
  }
});

test('알람 제안 문구: 시각을 모르거나 이상하면 시각 없이 이름과 알람만, 이름이 비면 친구, 이름이 길면 잘림', () => {
  const body = (ctx: Parameters<typeof composeCopy>[1]) => composeCopy('ALARM_CHANGED', { now: NOW, ...ctx }).body;
  assert.equal(body({ senderName: '수연', alarmType: 'WAKE' }), '수연님이 기상 알람을 제안했어요');
  assert.equal(body({ senderName: '수연', alarmType: 'WAKE', newAt: '2026-11-08T22:10:00Z' }), '수연님이 내일 기상 알람을 제안했어요'); // 한쪽만 있으면 시각은 뺌
  assert.equal(body({ senderName: '수연', alarmType: 'WAKE', previousAt: 'nonsense', newAt: '2026-11-08T22:10:00Z' }), '수연님이 내일 기상 알람을 제안했어요');
  assert.equal(body({ alarmType: 'WAKE' }), '친구님이 기상 알람을 제안했어요');
  assert.ok(body({ senderName: '가'.repeat(300), alarmType: 'WAKE', previousAt: '2026-11-08T22:00:00Z', newAt: '2026-11-08T22:10:00Z' }).length <= 200);
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

test('이름 자르기는 40자 — 40자까지는 그대로, 41자부터 40자 뒤에 …', () => {
  const at40 = '나'.repeat(40);
  const at41 = '나'.repeat(41);
  assert.equal(composeCopy('GROUP_MEMBER_JOINED', { groupName: at40 }).title, at40);
  assert.equal(composeCopy('GROUP_MEMBER_JOINED', { groupName: at41 }).title, `${at40}…`);
  assert.equal(composeCopy('GROUP_APPT_CHANGED', { groupName: '팀', appointmentTitle: at41 }).body, `‘${at40}…’ 약속이 바뀌었어요`);
});

test('공동 약속 취소 알림 문구: 약속 제목이 있으면 ‘제목’ 약속이 취소됐어요, 없으면 약속이 취소됐어요 — 바뀜 문구와 구분 (9-20)', () => {
  assert.equal(composeCopy('GROUP_APPT_CHANGED', { groupName: '캡스톤팀', appointmentTitle: '팀 주간회의', change: 'CANCELED' }).body, '‘팀 주간회의’ 약속이 취소됐어요');
  assert.equal(composeCopy('GROUP_APPT_CHANGED', { groupName: '캡스톤팀', change: 'CANCELED' }).body, '약속이 취소됐어요');
  assert.equal(composeCopy('GROUP_APPT_CHANGED', { groupName: '캡스톤팀', appointmentTitle: '팀 주간회의', change: 'CHANGED' }).body, '‘팀 주간회의’ 약속이 바뀌었어요');
});
