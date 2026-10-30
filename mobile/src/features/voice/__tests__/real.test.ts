import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createAppointment, createStandaloneAlarm, estimateAppointment, getAppointment, listPlaces, previewAlarms, saveAlarmSettings } from '@/features/alarm/api';
import type { Estimate } from '@/features/alarm/types';
import { EdgeError, callEdge } from '@/lib/edge';

import { applyFix } from '../fixes';
import { getConversation, pickCardPlace, rejectCard, resetVoiceState, retry, saveCard, say, TURN_TIMEOUT_MS } from '../real';

// 실데이터 대화(real.ts)를 가짜 서버 함수(callEdge) + 가짜 L1 · L2 함수로 시험 — 서버 함수 voice-session · voice-turn은 별도 PR(배포 전엔 이 가짜 응답으로 확인)
jest.mock('@/lib/edge', () => ({ ...jest.requireActual<typeof import('@/lib/edge')>('@/lib/edge'), callEdge: jest.fn() }));
jest.mock('@/lib/user', () => ({ currentUserId: async () => 'user-1', requireUserId: async () => 'user-1' }));
jest.mock('@/features/alarm/api', () => ({
  createAppointment: jest.fn(),
  createStandaloneAlarm: jest.fn(),
  estimateAppointment: jest.fn(),
  getAppointment: jest.fn(),
  listPlaces: jest.fn(),
  previewAlarms: jest.fn(),
  saveAlarmSettings: jest.fn(),
}));
jest.mock('../fixes', () => ({ applyFix: jest.fn() }));

const edge = callEdge as unknown as jest.Mock<(name: string, body: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<unknown>>;
const mEstimate = estimateAppointment as unknown as jest.Mock<(d: Record<string, unknown>) => Promise<Estimate>>;
const mCreate = createAppointment as unknown as jest.Mock<(e: Estimate, source?: string) => Promise<unknown>>;
const mGet = getAppointment as unknown as jest.Mock<(id: string) => Promise<unknown>>;
const mPlaces = listPlaces as unknown as jest.Mock<(q?: string) => Promise<unknown[]>>;
const mPreview = previewAlarms as unknown as jest.Mock<(id: string, edits: Record<string, unknown>) => Promise<unknown>>;
const mSettings = saveAlarmSettings as unknown as jest.Mock<(id: string, draft: Record<string, unknown>) => Promise<unknown>>;
const mStandalone = createStandaloneAlarm as unknown as jest.Mock<(input: Record<string, unknown>) => Promise<unknown>>;
const mFix = applyFix as unknown as jest.Mock<(fix: Record<string, unknown>) => Promise<unknown>>;

// ---- 재료 ----
const at = (h: number, m: number) => new Date(2026, 9, 30, h, m);
const ring = (kind: 'WAKE' | 'PREPARE' | 'DEPARTURE' | 'ARRIVE', h: number, m: number) => ({ id: `al:${kind}`, kind, at: at(h, m), enabled: true });
const ringsOf = () => [ring('WAKE', 7, 40), ring('PREPARE', 8, 20), ring('DEPARTURE', 9, 0), ring('ARRIVE', 10, 0)];

function estimateOf(title = '캡스톤 발표'): Estimate {
  return { appointment: { id: 'n1', title, at: at(10, 0), place: '강남역', alarms: ringsOf(), level: 2, withWake: true, items: ['노트북'] } } as unknown as Estimate;
}

function savedOf(id = 'ap1') {
  return { id, title: '캡스톤 발표', at: at(10, 0), alarms: ringsOf(), level: 2 };
}

function detailOf(over: Record<string, unknown> = {}) {
  const axes = { sound: { level: 1, manual: false }, voice: { level: 1, manual: false }, vibration: { level: 1, manual: false } };
  return {
    ...savedOf(),
    withWake: true,
    level: 1,
    intensity: { axes },
    auto: { travelMinutes: 40, predictedPrepMinutes: 45 },
    edits: { bufferMinutes: 10, origin: '집', transport: 'TRANSIT', travelMinutes: null, prepareMinutes: null, times: {} },
    ...over,
  };
}

const draftOf = (over: Record<string, unknown> = {}) => ({
  title: '캡스톤 발표',
  date: '2026-10-30',
  time: '10:00',
  place: '강남역',
  importance: 'HIGH',
  transport: null,
  repeat: [],
  items: ['노트북', '충전기'],
  alarms: { WAKE: true, PREPARE: true, DEPARTURE: true },
  ...over,
});

const apptCard = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  kind: 'APPT_NEW',
  status: 'NEEDS_ESTIMATE',
  first_of_day: true,
  highlight: false,
  summary: '10/30(금) 10:00 캡스톤 발표 · 강남역',
  draft: draftOf(),
  edit: null,
  ...over,
});

const LIMITS = { turns_left: 20, sessions_left_today: 4, reached: null };
const session = (over: Record<string, unknown> = {}) => ({
  session_id: 's1',
  resumed: false,
  rev: 1,
  turn_seq: 0,
  messages: [{ role: 'ai', text: '오늘 오전 8시 12분에 일어났어요. 틀린 게 있으면 말해 주세요.', at: new Date(2026, 9, 29, 21, 0).toISOString() }],
  cards: [],
  limits: LIMITS,
  ...over,
});
const turn = (over: Record<string, unknown> = {}) => ({ rev: 2, turn_seq: 1, next: 'USER', reply: { text: '네, 알겠어요.' }, cards: [], fixes: [], limits: LIMITS, ...over });

// 서버 흉내 — 부른 순서대로 응답을 줌. 값이 Error면 던짐
let script: unknown[] = [];
const bodies = () => edge.mock.calls.map(([name, body]) => ({ name, body }));
const turnBodies = () => bodies().filter((c) => c.name === 'voice-turn').map((c) => c.body);

beforeEach(() => {
  jest.clearAllMocks();
  resetVoiceState();
  script = [];
  edge.mockImplementation(async () => {
    const next = script.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('서버 응답 대본이 모자람');
    return next;
  });
  mEstimate.mockImplementation(async () => estimateOf());
  mCreate.mockImplementation(async () => savedOf());
  mPlaces.mockImplementation(async () => [{ name: '강남역', lat: 37.4979, lng: 127.0276 }]);
  mGet.mockImplementation(async () => detailOf());
  mSettings.mockImplementation(async () => ({ turnedOff: false, turnedOn: false }));
  mFix.mockImplementation(async (fix) => ({ id: fix.id as string, ok: true, error: null }));
});

describe('① 세션 시작 · 첫 마디', () => {
  it('voice-session을 텍스트 · 이어하기로 부르고 첫 마디와 한도를 받음', async () => {
    script = [session()];
    const c = await getConversation();
    expect(bodies()[0]).toEqual({ name: 'voice-session', body: { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true } });
    expect(c.source).toBe('REAL');
    expect(c.messages.map((m) => m.who)).toEqual(['ai']);
    expect(c.messages[0].text).toContain('틀린 게 있으면');
    expect(c.next).toEqual({ who: 'me', text: '' });
    expect(c.limits).toEqual({ turnsLeft: 20, sessionsLeftToday: 4, reached: null });
    await getConversation(); // 다시 읽어도 서버를 또 부르지 않음 (대화 유지)
    expect(edge).toHaveBeenCalledTimes(1);
  });
});

describe('② 말 → 일반 답', () => {
  it('voice-turn에 session · rev · client_turn_id · 글을 보내고(25초) 답을 붙임', async () => {
    script = [session(), turn()];
    await getConversation();
    const c = await say('  응 맞아  ');
    const [name, body, options] = edge.mock.calls[1];
    expect(name).toBe('voice-turn');
    expect(body).toMatchObject({ session_id: 's1', rev: 1, text: '응 맞아' });
    expect(typeof body.client_turn_id).toBe('string');
    expect(options).toEqual({ timeoutMs: TURN_TIMEOUT_MS });
    expect(TURN_TIMEOUT_MS).toBe(25_000);
    expect(c.messages.map((m) => `${m.who}:${m.text}`)).toEqual([expect.stringContaining('ai:'), 'me:응 맞아', 'ai:네, 알겠어요.']);
    // 다음 말은 응답의 rev로
    script = [turn({ rev: 3 })];
    await say('하나 더');
    expect(turnBodies()[1]).toMatchObject({ rev: 2 });
  });

  it('빈 글은 보내지 않음', async () => {
    script = [session()];
    await getConversation();
    await say('   ');
    expect(edge).toHaveBeenCalledTimes(1);
  });
});

describe('③ 2단 턴 — 앱 일 → results → 마지막 답', () => {
  it('next가 APP_TASKS면 카드를 계산해 같은 client_turn_id · 응답의 rev로 results를 보냄', async () => {
    script = [
      session(),
      turn({ next: 'APP_TASKS', reply: null, cards: [apptCard()] }),
      turn({ rev: 3, reply: { text: '오전 7시 40분에 강하게 깨우는 알람으로 저장할까요?' }, cards: [apptCard({ status: 'READY' })] }),
    ];
    await getConversation();
    const c = await say('내일 10시 강남역에서 발표 있어');
    const [first, second] = turnBodies();
    expect(second).toMatchObject({ session_id: 's1', rev: 2, client_turn_id: first.client_turn_id });
    expect(second.text).toBeUndefined();
    expect(second.results).toEqual({
      cards: [
        {
          id: 'c1',
          status: 'READY',
          estimate: {
            alarms: [
              { kind: 'WAKE', at: at(7, 40).toISOString(), enabled: true },
              { kind: 'PREPARE', at: at(8, 20).toISOString(), enabled: true },
              { kind: 'DEPARTURE', at: at(9, 0).toISOString(), enabled: true },
            ],
            level: 2,
            with_wake: true,
          },
          error: null,
        },
      ],
      fixes: [],
    });
    // 장소 이름이 내가 쓴 곳에 똑같이 하나라 그 좌표로 계산
    expect(mPlaces).toHaveBeenCalledWith('강남역');
    expect(mEstimate).toHaveBeenCalledWith(expect.objectContaining({ place: '강남역', placeLat: 37.4979, placeLng: 127.0276, items: '노트북,충전기', importance: 'HIGH', transport: 'TRANSIT' }));
    expect(c.messages.at(-1)?.text).toContain('저장할까요');
    expect(c.cards[0]).toMatchObject({ id: 'c1', status: 'READY', title: '캡스톤 발표', place: '강남역', items: ['노트북', '충전기'] });
    expect(c.cards[0].alarms.map((a) => a.kind)).toEqual(['WAKE', 'PREPARE', 'DEPARTURE']);
  });

  it('정정(fixes)은 L2 함수로 반영하고 결과를 results에 실음', async () => {
    mFix.mockImplementation(async () => ({ id: 'x1', ok: false, error: '이미 확인한 기록' }));
    script = [
      session(),
      turn({ next: 'APP_TASKS', reply: null, fixes: [{ id: 'x1', fact: 'f2', kind: 'ARRIVE', participant_id: 'p-1', action: 'CORRECT', to: at(10, 20).toISOString() }] }),
      turn({ rev: 3, reply: { text: '그 기록은 그대로 뒀어요.' } }),
    ];
    await getConversation();
    await say('도착은 10시 20분이었어');
    expect(mFix).toHaveBeenCalledWith({ id: 'x1', kind: 'ARRIVE', participantId: 'p-1', action: 'CORRECT', to: at(10, 20) });
    expect(turnBodies()[1].results).toEqual({ cards: [], fixes: [{ id: 'x1', ok: false, error: '이미 확인한 기록' }] });
  });
});

describe('④ 카드 두 장 — 첫 일정 · 나머지', () => {
  it('카드마다 계산하고 대화 줄에 하나씩 놓음', async () => {
    mEstimate.mockImplementationOnce(async () => estimateOf('캡스톤 발표')).mockImplementationOnce(async () => estimateOf('스터디'));
    script = [
      session(),
      turn({
        next: 'APP_TASKS',
        reply: null,
        cards: [apptCard(), apptCard({ id: 'c2', first_of_day: false, summary: '10/30(금) 14:00 스터디 · 강남역', draft: draftOf({ title: '스터디', time: '14:00' }) })],
      }),
      turn({ rev: 3, cards: [apptCard({ status: 'READY' }), apptCard({ id: 'c2', first_of_day: false, status: 'READY', draft: draftOf({ title: '스터디', time: '14:00' }) })] }),
    ];
    await getConversation();
    const c = await say('내일 10시 발표, 2시 스터디');
    expect(mEstimate).toHaveBeenCalledTimes(2);
    expect((turnBodies()[1].results as { cards: { id: string }[] }).cards.map((x) => x.id)).toEqual(['c1', 'c2']);
    expect(c.cards.map((x) => [x.id, x.firstOfDay, x.status])).toEqual([
      ['c1', true, 'READY'],
      ['c2', false, 'READY'],
    ]);
    expect(c.messages.filter((m) => m.who === 'card').map((m) => m.cardId)).toEqual(['c1', 'c2']);
  });
});

describe('⑤ 장소 필요 → 장소 고르기 → 계산 → 준비', () => {
  it('내가 쓴 곳에 이름이 없으면 NEEDS_PLACE로 알리고, 고른 곳으로 계산해 READY', async () => {
    mPlaces.mockImplementation(async () => []);
    script = [
      session(),
      turn({ next: 'APP_TASKS', reply: null, cards: [apptCard()] }),
      turn({ rev: 3, reply: { text: '장소를 골라 주세요.' }, cards: [apptCard({ status: 'NEEDS_PLACE' })] }),
    ];
    await getConversation();
    let c = await say('내일 10시 강남역에서 발표');
    expect(mEstimate).not.toHaveBeenCalled();
    expect((turnBodies()[1].results as { cards: { status: string; error: string }[] }).cards[0]).toMatchObject({ status: 'NEEDS_PLACE', estimate: null });
    expect(c.cards[0].status).toBe('NEEDS_PLACE');
    expect(c.cards[0].error).toContain('강남역');

    script = [turn({ rev: 4, reply: { text: '저장할까요?' }, cards: [apptCard({ status: 'READY' })] })];
    await pickCardPlace('c1', { name: '강남역 2번 출구', lat: 37.5, lng: 127.03 });
    expect(mEstimate).toHaveBeenCalledWith(expect.objectContaining({ place: '강남역 2번 출구', placeLat: 37.5, placeLng: 127.03 }));
    const picked = turnBodies()[2];
    expect(picked).toMatchObject({ rev: 3 });
    expect(picked.client_turn_id).not.toBe(turnBodies()[0].client_turn_id); // 새 번호
    expect((picked.results as { cards: { status: string }[] }).cards[0].status).toBe('READY');
    c = await getConversation();
    expect(c.cards[0].status).toBe('READY');
    expect(c.messages.at(-1)?.text).toBe('저장할까요?');
  });

  it('좌표가 없는 장소를 고르면 막음', async () => {
    script = [session(), turn({ cards: [apptCard({ status: 'NEEDS_PLACE' })] })];
    await getConversation();
    await say('발표');
    await expect(pickCardPlace('c1', { name: '어딘가' })).rejects.toThrow('위치를 몰라요');
  });
});

describe('⑥ 카드 저장 → createAppointment → card_action', () => {
  async function ready(card = apptCard()) {
    script = [session(), turn({ next: 'APP_TASKS', reply: null, cards: [card] }), turn({ rev: 3, cards: [{ ...card, status: 'READY' }] })];
    await getConversation();
    await say('발표 있어');
  }

  it("계산한 Estimate를 '자기 전 대화'로 저장하고 SAVED + 알람 요약을 서버에 알림", async () => {
    await ready();
    script = [turn({ rev: 4, reply: { text: '저장했어요. 내일 오전 7시 40분에 강하게 깨울게요.' }, cards: [apptCard({ status: 'SAVED' })] })];
    const toast = await saveCard('c1');
    expect(mCreate).toHaveBeenCalledTimes(1);
    expect(mCreate.mock.calls[0][1]).toBe('자기 전 대화');
    expect(mCreate.mock.calls[0][0].appointment.items).toEqual(['노트북']); // 준비물은 Estimate에 담겨 카드와 같이 저장
    expect(toast).toBe('캡스톤 발표 알람을 맞췄어요');
    const body = turnBodies().at(-1)!;
    expect(body).toMatchObject({ session_id: 's1', rev: 3 });
    expect(body.card_action).toEqual({
      id: 'c1',
      action: 'SAVED',
      appointment_id: 'ap1',
      alarms: [
        { kind: 'WAKE', at: at(7, 40).toISOString(), enabled: true, level: 2 },
        { kind: 'PREPARE', at: at(8, 20).toISOString(), enabled: true, level: 2 },
        { kind: 'DEPARTURE', at: at(9, 0).toISOString(), enabled: true, level: 2 },
      ],
    });
    const c = await getConversation();
    expect(c.cards[0]).toMatchObject({ status: 'SAVED', appointmentId: 'ap1' });
    expect(c.messages.at(-1)?.text).toContain('저장했어요');
    await expect(saveCard('c1')).rejects.toThrow('이미 확인한 카드예요'); // 두 번 저장 막음
    expect(mCreate).toHaveBeenCalledTimes(1);
  });

  it('[저장 안 함]은 REJECTED로만 알리고 답이 없음', async () => {
    await ready();
    script = [turn({ rev: 4, reply: null, cards: [apptCard({ status: 'REJECTED' })] })];
    await rejectCard('c1');
    expect(turnBodies().at(-1)?.card_action).toEqual({ id: 'c1', action: 'REJECTED' });
    expect(mCreate).not.toHaveBeenCalled();
    const c = await getConversation();
    expect(c.cards[0].status).toBe('REJECTED');
    expect(c.messages.filter((m) => m.who === 'ai')).toHaveLength(2); // 첫 마디 + 앞 답, 새 답 없음
  });

  it('저장 뒤 서버 알림이 실패해도 저장은 그대로이고 [다시 시도]로 같은 알림을 다시 보냄', async () => {
    await ready();
    script = [new EdgeError('LLM_UNAVAILABLE')];
    await saveCard('c1');
    let c = await getConversation();
    expect(c.cards[0].status).toBe('SAVED');
    expect(c.unavailable?.code).toBe('LLM_UNAVAILABLE');
    const failed = turnBodies().at(-1)!;
    script = [turn({ rev: 4, reply: { text: '저장했어요.' } })];
    c = await retry();
    expect(turnBodies().at(-1)).toEqual(failed);
    expect(c.unavailable).toBeNull();
    expect(mCreate).toHaveBeenCalledTimes(1);
  });

  it('앱을 다시 열어 계산 결과가 없으면 저장 전에 다시 계산', async () => {
    script = [session({ cards: [apptCard({ status: 'READY' })] }), turn({ rev: 2 })];
    await getConversation();
    await saveCard('c1');
    expect(mEstimate).toHaveBeenCalledTimes(1);
    expect(mCreate).toHaveBeenCalledTimes(1);
  });
});

describe('⑦ 준비 +N · 강도 — 바뀐 때만 두 번째 저장', () => {
  async function saveWith(edit: Record<string, unknown> | null) {
    const card = apptCard({ edit });
    script = [session(), turn({ next: 'APP_TASKS', reply: null, cards: [card] }), turn({ rev: 3, cards: [{ ...card, status: 'READY' }] }), turn({ rev: 4 })];
    await getConversation();
    await say('발표');
    await saveCard('c1');
  }

  it('고칠 값이 없으면 saveAlarmSettings를 안 부름 (카카오 +1 없음)', async () => {
    await saveWith(null);
    expect(mSettings).not.toHaveBeenCalled();
    expect(mGet).not.toHaveBeenCalled();
  });

  it('준비 +15분이면 자동 준비 시간 + 15로 한 번 더 저장', async () => {
    await saveWith({ prepare_delta: 15 });
    expect(mSettings).toHaveBeenCalledTimes(1);
    expect(mSettings).toHaveBeenCalledWith('ap1', expect.objectContaining({ prepareMinutes: 60 }));
  });

  it('강도가 이미 그 값이면 안 부르고, 다르면 부름', async () => {
    await saveWith({ levels: { sound: 1, voice: 1, vibration: 1 } });
    expect(mSettings).not.toHaveBeenCalled();
    resetVoiceState();
    jest.clearAllMocks();
    mEstimate.mockImplementation(async () => estimateOf());
    mCreate.mockImplementation(async () => savedOf());
    mPlaces.mockImplementation(async () => [{ name: '강남역', lat: 1, lng: 2 }]);
    mGet.mockImplementation(async () => detailOf());
    await saveWith({ levels: { sound: 2, voice: 2, vibration: 2 } });
    expect(mSettings).toHaveBeenCalledWith('ap1', expect.objectContaining({ levels: { sound: 2, voice: 2, vibration: 2 } }));
  });

  it('준비 −10분(줄이기)이면 자동 준비 시간 − 10으로 한 번 더 저장', async () => {
    await saveWith({ prepare_delta: -10 });
    expect(mSettings).toHaveBeenCalledTimes(1);
    expect(mSettings).toHaveBeenCalledWith('ap1', expect.objectContaining({ prepareMinutes: 35 }));
  });

  it('준비 값이 이미 같으면 안 부름 (자동 − 10이 저장된 약속에 −10)', async () => {
    mGet.mockImplementation(async () => detailOf({ edits: { bufferMinutes: 10, origin: '집', transport: 'TRANSIT', travelMinutes: null, prepareMinutes: 35, times: {} } }));
    await saveWith({ prepare_delta: -10 });
    expect(mSettings).not.toHaveBeenCalled();
  });

  it('두 번째 저장이 실패해도 일정은 저장됨 — 그 사실을 알려 줌', async () => {
    mSettings.mockImplementation(async () => {
      throw new Error('boom');
    });
    await saveWith({ prepare_delta: 10 });
    expect(mCreate).toHaveBeenCalledTimes(1);
    expect((await getConversation()).cards[0].status).toBe('SAVED');
  });
});

describe('알람 바꾸기 · 알람 만들기 카드', () => {
  const editCard = (over: Record<string, unknown> = {}) => ({
    id: 'c2',
    kind: 'ALARM_EDIT',
    status: 'NEEDS_ESTIMATE',
    first_of_day: true,
    highlight: false,
    summary: '알람 변경: 내일만 준비시간 +15분 · 기상 07:55 → 07:40',
    draft: null,
    edit: { appointment_id: 'ap1', times: { WAKE: at(7, 40).toISOString() }, prepare_delta: 15 },
    ...over,
  });

  it('시각 · 준비가 바뀌면 previewAlarms로 보여 주고 [바꾸기]는 saveAlarmSettings', async () => {
    mPreview.mockImplementation(async () => ({ alarms: ringsOf() }));
    script = [
      session(),
      turn({ next: 'APP_TASKS', reply: null, cards: [editCard()] }),
      turn({ rev: 3, cards: [editCard({ status: 'READY' })] }),
      turn({ rev: 4, reply: { text: '바꿨어요.' } }),
    ];
    await getConversation();
    const c = await say('내일은 준비 15분 더, 7시 40분에 깨워줘');
    const edits = mPreview.mock.calls[0][1] as { prepareMinutes: number; times: Record<string, Date> };
    expect(mPreview.mock.calls[0][0]).toBe('ap1');
    expect(edits.prepareMinutes).toBe(60);
    expect(edits.times.WAKE).toEqual(at(7, 40));
    expect(c.cards[0].kind).toBe('ALARM_EDIT');
    expect(c.cards[0].alarms).toHaveLength(3);

    expect(await saveCard('c2')).toBe('알람을 바꿨어요');
    expect(mSettings).toHaveBeenCalledWith('ap1', expect.objectContaining({ prepareMinutes: 60, times: { WAKE: at(7, 40) } }));
    expect(mCreate).not.toHaveBeenCalled();
    expect(turnBodies().at(-1)?.card_action).toMatchObject({ id: 'c2', action: 'SAVED', appointment_id: 'ap1' });
  });

  describe('줄이기 · 원래대로 · 보통으로 (서버 turn-core 의미)', () => {
    const manualPrep = (prepareMinutes: number | null) => ({ bufferMinutes: 10, origin: '집', transport: 'TRANSIT', travelMinutes: null, prepareMinutes, times: {} });
    const axesOf = (manual: boolean, level = 2) => ({ sound: { level, manual }, voice: { level, manual }, vibration: { level, manual } });
    const withDetail = (over: Record<string, unknown>) => mGet.mockImplementation(async () => detailOf(over));

    async function runEdit(edit: Record<string, unknown>) {
      mPreview.mockImplementation(async () => ({ alarms: ringsOf() }));
      const card = editCard({ edit: { appointment_id: 'ap1', ...edit } });
      script = [
        session(),
        turn({ next: 'APP_TASKS', reply: null, cards: [card] }),
        turn({ rev: 3, cards: [{ ...card, status: 'READY' }] }),
        turn({ rev: 4 }),
      ];
      await getConversation();
      await say('알람 바꿔줘');
      await saveCard('c2');
    }

    it('prepare_delta −10 → 자동 − 10분으로 미리 보기 · 저장', async () => {
      await runEdit({ prepare_delta: -10 });
      expect((mPreview.mock.calls[0][1] as { prepareMinutes: number }).prepareMinutes).toBe(35);
      expect(mSettings).toHaveBeenCalledWith('ap1', expect.objectContaining({ prepareMinutes: 35 }));
    });

    it('prepare_delta 0 → 이미 직접 고른 준비 시간을 자동(null)으로 되돌림', async () => {
      withDetail({ edits: manualPrep(60) });
      await runEdit({ prepare_delta: 0 });
      expect((mPreview.mock.calls[0][1] as { prepareMinutes: number | null }).prepareMinutes).toBeNull();
      expect(mSettings).toHaveBeenCalledWith('ap1', expect.objectContaining({ prepareMinutes: null }));
    });

    it('prepare_delta 0이고 이미 자동이면 미리 보기를 안 부름 (바뀐 게 없음)', async () => {
      await runEdit({ prepare_delta: 0 });
      expect(mPreview).not.toHaveBeenCalled();
    });

    it('prepare_delta가 없거나 null이면 직접 고른 준비 시간을 그대로 둠', async () => {
      withDetail({ edits: manualPrep(60) });
      await runEdit({ prepare_delta: null, enabled: { PREPARE: false } });
      expect(mPreview).not.toHaveBeenCalled();
      expect(mSettings).toHaveBeenCalledWith('ap1', expect.objectContaining({ prepareMinutes: 60 }));
    });

    it('levels가 모두 null("보통으로") → 직접 고른 강도를 자동(null)으로', async () => {
      withDetail({ intensity: { auto: 0, axes: axesOf(true) } });
      await runEdit({ levels: { sound: null, voice: null, vibration: null } });
      expect(mSettings).toHaveBeenCalledWith('ap1', expect.objectContaining({ levels: { sound: null, voice: null, vibration: null } }));
      const shown = (turnBodies()[1].results as { cards: { estimate: { level: number } }[] }).cards[0].estimate.level;
      expect(shown).toBe(0); // 미리 보기 강도 = 자동 강도
    });

    it('levels가 없으면 직접 고른 강도를 그대로 둠', async () => {
      withDetail({ intensity: { auto: 1, axes: axesOf(true) } });
      await runEdit({ prepare_delta: -10 });
      expect(mSettings).toHaveBeenCalledWith('ap1', expect.objectContaining({ levels: { sound: 2, voice: 2, vibration: 2 } }));
    });
  });

  it('켜기 · 끄기만이면 길찾기 미리 보기를 안 부름', async () => {
    script = [session(), turn({ next: 'APP_TASKS', reply: null, cards: [editCard({ edit: { appointment_id: 'ap1', enabled: { PREPARE: false } } })] }), turn({ rev: 3 })];
    await getConversation();
    const c = await say('준비 알람은 꺼줘');
    expect(mPreview).not.toHaveBeenCalled();
    expect(c.cards[0].alarms.find((a) => a.kind === 'PREPARE')?.enabled).toBe(false);
  });

  it('알람 순서가 뒤집히면 FAILED + 이유를 서버에 줌', async () => {
    mPreview.mockImplementation(async () => ({ alarms: [ring('WAKE', 9, 30), ring('PREPARE', 8, 20), ring('DEPARTURE', 9, 0), ring('ARRIVE', 10, 0)] }));
    script = [session(), turn({ next: 'APP_TASKS', reply: null, cards: [editCard()] }), turn({ rev: 3 })];
    await getConversation();
    await say('9시 반에 깨워줘');
    const result = (turnBodies()[1].results as { cards: { status: string; error: string }[] }).cards[0];
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('빠를 수 없어요');
  });

  it('약속 없는 알람 카드는 계산 없이 바로 준비 → [저장]이 createStandaloneAlarm', async () => {
    mStandalone.mockImplementation(async () => ({ id: 'alarm-9', title: '알람', alarms: [ring('WAKE', 7, 0)], level: 1 }));
    const card = { id: 'c3', kind: 'ALARM_NEW', status: 'READY', first_of_day: true, highlight: false, summary: '내일 07:00 알람', draft: null, edit: { at: at(7, 0).toISOString(), level: 2 } };
    script = [session(), turn({ cards: [card] }), turn({ rev: 3 })];
    await getConversation();
    await say('7시에 깨워줘');
    expect(mPreview).not.toHaveBeenCalled();
    await saveCard('c3');
    expect(mStandalone).toHaveBeenCalledWith({ at: at(7, 0), level: 2 });
    expect(turnBodies().at(-1)?.card_action).toMatchObject({ appointment_id: 'alarm-9' });
  });
});

describe('⑧ 실패 — 대화 · 카드는 남기고 다시 시도', () => {
  it('LLM_UNAVAILABLE: 말과 카드를 두고 unavailable, [다시 시도]는 같은 요청', async () => {
    script = [session(), new EdgeError('LLM_UNAVAILABLE', { details: { cards: [apptCard({ status: 'READY' })], fixes: [] } })];
    await getConversation();
    const c = await say('내일 10시 발표');
    expect(c.unavailable).toMatchObject({ code: 'LLM_UNAVAILABLE', canRetry: true });
    expect(c.messages.map((m) => m.who)).toEqual(['ai', 'me', 'card']); // 보낸 말 + 서버가 준 카드 상태가 남음
    expect(c.cards[0].status).toBe('READY');
    expect(c.next).toBeNull(); // 입력은 [다시 시도] 뒤에
    const failed = turnBodies()[0];

    script = [turn({ reply: { text: '네, 내일 10시 발표요.' } })];
    const again = await retry();
    expect(turnBodies()[1]).toEqual(failed); // 같은 client_turn_id · rev
    expect(again.unavailable).toBeNull();
    expect(again.messages.at(-1)?.text).toBe('네, 내일 10시 발표요.');
    expect(again.messages.filter((m) => m.who === 'me')).toHaveLength(1); // 말이 두 번 쌓이지 않음
    expect(again.next).toEqual({ who: 'me', text: '' });
  });

  it('NOT_CONFIGURED: 세션을 못 시작해도 던지지 않고 unavailable, [다시 시도]로 시작', async () => {
    script = [new EdgeError('NOT_CONFIGURED')];
    let c = await getConversation();
    expect(c.unavailable).toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(c.messages).toEqual([]);
    expect(c.next).toBeNull();
    await getConversation(); // 다시 읽어도 자동으로 또 부르지 않음
    expect(edge).toHaveBeenCalledTimes(1);

    script = [session()];
    c = await retry();
    expect(c.unavailable).toBeNull();
    expect(c.messages).toHaveLength(1);
    expect(c.next).toEqual({ who: 'me', text: '' });
  });

  it('results 단계에서 실패해도 계산한 결과를 다시 보냄 (계산을 또 하지 않음)', async () => {
    script = [session(), turn({ next: 'APP_TASKS', reply: null, cards: [apptCard()] }), new EdgeError('LLM_UNAVAILABLE')];
    await getConversation();
    const c = await say('발표');
    expect(c.unavailable).not.toBeNull();
    expect(mEstimate).toHaveBeenCalledTimes(1);
    script = [turn({ rev: 3, reply: { text: '저장할까요?' }, cards: [apptCard({ status: 'READY' })] })];
    await retry();
    expect(mEstimate).toHaveBeenCalledTimes(1);
    expect(turnBodies()[2]).toEqual(turnBodies()[1]);
  });

  it('다른 오류(VALIDATION_FAILED)는 던지고 보낸 말은 대화에서 뺌 (입력칸으로 돌아감)', async () => {
    script = [session(), new EdgeError('VALIDATION_FAILED')];
    await getConversation();
    await expect(say('안녕')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await getConversation()).messages.map((m) => m.who)).toEqual(['ai']);
  });
});

describe('⑨ 한도', () => {
  it('limits.reached = TURN이면 입력을 막고 템플릿 답은 그대로 보임', async () => {
    script = [session(), turn({ reply: { text: '오늘 대화는 여기까지예요. [완료]를 누르면 정리할게요.' }, limits: { turns_left: 0, sessions_left_today: 4, reached: 'TURN' } })];
    await getConversation();
    const c = await say('마지막 말');
    expect(c.limits?.reached).toBe('TURN');
    expect(c.next).toBeNull();
    expect(c.unavailable).toBeNull();
    const again = await say('더 할래');
    expect(again.messages.filter((m) => m.who === 'me')).toHaveLength(1);
    expect(edge).toHaveBeenCalledTimes(2); // 한도 뒤에는 서버를 안 부름
  });

  it('하루 대화 수를 넘으면 세션 없이 reached = DAY', async () => {
    script = [session({ session_id: null, messages: [], limits: { turns_left: 0, sessions_left_today: 0, reached: 'DAY' } })];
    const c = await getConversation();
    expect(c.limits?.reached).toBe('DAY');
    expect(c.messages).toEqual([]);
    expect(c.next).toBeNull();
    expect(c.unavailable).toBeNull();
    await say('안녕');
    expect(edge).toHaveBeenCalledTimes(1);
  });
});

describe('⑩ rev 어긋남 — 세션 다시 읽기', () => {
  it('CONFLICT면 resume으로 세션을 다시 읽어 서버 상태로 바꾸고 오류를 던짐', async () => {
    script = [
      session(),
      new EdgeError('CONFLICT'),
      session({ resumed: true, rev: 5, messages: [{ role: 'ai', text: '첫 마디', at: at(21, 0).toISOString() }, { role: 'user', text: '다른 기기에서 한 말', at: at(21, 1).toISOString() }] }),
    ];
    await getConversation();
    await expect(say('안녕')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(bodies().map((c) => c.name)).toEqual(['voice-session', 'voice-turn', 'voice-session']);
    expect(bodies()[2].body).toMatchObject({ resume: true });
    const c = await getConversation();
    expect(c.messages.map((m) => `${m.who}:${m.text}`)).toEqual(['ai:첫 마디', 'me:다른 기기에서 한 말']);
    script = [turn({ rev: 6 })];
    await say('이어서');
    expect(turnBodies().at(-1)).toMatchObject({ rev: 5 });
  });
});

describe('⑪ 같은 client_turn_id 재시도', () => {
  it('시간 초과 뒤 [다시 시도]는 같은 번호 · 같은 rev · 같은 글로 보냄', async () => {
    script = [session(), new EdgeError('TIMEOUT'), turn()];
    await getConversation();
    const c = await say('시간 초과 말');
    expect(c.unavailable).toMatchObject({ code: 'TIMEOUT' });
    await retry();
    const [a, b] = turnBodies();
    expect(b).toEqual(a);
    expect(b).toMatchObject({ text: '시간 초과 말', rev: 1 });
  });
});

// ---- 서버 PR(voice-state.ts · voice-turn)이 설계 14절에서 다르게 한 곳 ----
describe('서버 응답 모양 맞춤', () => {
  it('draft.place가 빈 글자면 좌표를 찾지 않고 바로 NEEDS_PLACE', async () => {
    script = [session(), turn({ next: 'APP_TASKS', reply: null, cards: [apptCard({ draft: draftOf({ place: '' }) })] }), turn({ rev: 3, cards: [apptCard({ status: 'NEEDS_PLACE', draft: draftOf({ place: '' }) })] })];
    await getConversation();
    const c = await say('내일 10시 발표 있어');
    expect(mPlaces).not.toHaveBeenCalled();
    expect(mEstimate).not.toHaveBeenCalled();
    expect((turnBodies()[1].results as { cards: { status: string; error: string }[] }).cards[0]).toMatchObject({ status: 'NEEDS_PLACE', error: '장소를 골라 주세요' });
    expect(c.cards[0]).toMatchObject({ status: 'NEEDS_PLACE', place: '' });
  });

  it('카드에 내려온 appointment_id · error를 그대로 보임', async () => {
    script = [session({ cards: [apptCard({ status: 'FAILED', error: '이미 지난 시각이에요' }), apptCard({ id: 'c2', status: 'SAVED', appointment_id: 'ap-9' })] })];
    const c = await getConversation();
    expect(c.cards.map((x) => [x.id, x.error, x.appointmentId])).toEqual([
      ['c1', '이미 지난 시각이에요', null],
      ['c2', null, 'ap-9'],
    ]);
  });

  it('알람 고치기 카드의 appointment_id가 null(모르는 약속)이면 FAILED로 서버에 알림', async () => {
    const card = { id: 'c2', kind: 'ALARM_EDIT', status: 'NEEDS_ESTIMATE', first_of_day: true, highlight: false, summary: '알람 변경', draft: null, edit: { appointment_id: null, prepare_delta: 10 } };
    script = [session(), turn({ next: 'APP_TASKS', reply: null, cards: [card] }), turn({ rev: 3 })];
    await getConversation();
    await say('준비 10분 더');
    expect(mGet).not.toHaveBeenCalled();
    expect((turnBodies()[1].results as { cards: { status: string }[] }).cards[0].status).toBe('FAILED');
  });

  it('정정 대상(participant_id)이 빈 글자면 L2 함수를 안 부르고 대상 없음', async () => {
    script = [
      session(),
      turn({ next: 'APP_TASKS', reply: null, fixes: [{ id: 'x1', fact: 'f2', kind: 'ARRIVE', participant_id: '', action: 'CORRECT', to: at(10, 20).toISOString() }] }),
      turn({ rev: 3 }),
    ];
    await getConversation();
    await say('도착은 10시 20분이었어');
    expect(mFix).not.toHaveBeenCalled();
    expect(turnBodies()[1].results).toEqual({ cards: [], fixes: [{ id: 'x1', ok: false, error: '대상 없음' }] });
  });

  it('20번째 답에서 이미 limits.reached TURN — 그 답은 그대로 보이고 입력만 막힘', async () => {
    script = [session(), turn({ reply: { text: '네, 20번째 답이에요.' }, limits: { turns_left: 0, sessions_left_today: 4, reached: 'TURN' } })];
    await getConversation();
    const c = await say('스무 번째 말');
    expect(c.messages.at(-1)).toMatchObject({ who: 'ai', text: '네, 20번째 답이에요.' });
    expect(c.limits?.reached).toBe('TURN');
    expect(c.next).toBeNull();
    expect(c.unavailable).toBeNull();
  });

  it('LLM_UNAVAILABLE details의 cards · rev · limits로 상태를 복원 (재시도는 처음 rev · 번호 그대로)', async () => {
    const details = { cards: [apptCard({ status: 'READY' })], fixes: [], rev: 2, turn_seq: 1, limits: { turns_left: 19, sessions_left_today: 4, reached: null } };
    script = [session(), new EdgeError('LLM_UNAVAILABLE', { details })];
    await getConversation();
    const c = await say('내일 10시 발표');
    expect(c.cards[0].status).toBe('READY');
    expect(c.limits).toEqual({ turnsLeft: 19, sessionsLeftToday: 4, reached: null });
    script = [turn({ rev: 3 })];
    await retry();
    expect(turnBodies()[1]).toEqual(turnBodies()[0]);
    expect(turnBodies()[1]).toMatchObject({ rev: 1 });
    script = [turn({ rev: 4 })];
    await say('다음 말');
    expect(turnBodies()[2]).toMatchObject({ rev: 3 });
  });

  it('키 없음: voice-session은 첫 마디까지 주고 voice-turn만 NOT_CONFIGURED → 대화 · 말은 남고 다시 시도', async () => {
    script = [session(), new EdgeError('NOT_CONFIGURED')];
    let c = await getConversation();
    expect(c.messages).toHaveLength(1);
    c = await say('안녕하세요');
    expect(c.unavailable).toMatchObject({ code: 'NOT_CONFIGURED', canRetry: true });
    expect(c.messages.map((m) => m.who)).toEqual(['ai', 'me']);
    script = [turn()];
    c = await retry();
    expect(c.unavailable).toBeNull();
    expect(turnBodies()[1]).toEqual(turnBodies()[0]);
    expect(c.messages.at(-1)?.text).toBe('네, 알겠어요.');
  });

  it('NOT_FOUND(카드 · 세션)는 세션을 다시 읽되, 앱에서 이미 저장한 카드는 서버가 몰라도 저장으로 둠', async () => {
    script = [session(), turn({ next: 'APP_TASKS', reply: null, cards: [apptCard()] }), turn({ rev: 3, cards: [apptCard({ status: 'READY' })] })];
    await getConversation();
    await say('발표 있어');
    // 저장 알림이 NOT_FOUND로 거절되면 세션을 다시 읽음 — 서버는 아직 READY로 알고 있어도 저장은 그대로
    script = [new EdgeError('NOT_FOUND'), session({ resumed: true, rev: 5, cards: [apptCard({ status: 'READY' })] })];
    await saveCard('c1');
    expect(bodies().map((x) => x.name).slice(-2)).toEqual(['voice-turn', 'voice-session']);
    expect(mCreate).toHaveBeenCalledTimes(1);
    const c = await getConversation();
    expect(c.cards[0]).toMatchObject({ status: 'SAVED', appointmentId: 'ap1' });
    await expect(saveCard('c1')).rejects.toThrow('이미 확인한 카드예요');
    expect(mCreate).toHaveBeenCalledTimes(1);
  });
});

// ---- 계산 중 앱이 꺼졌다 켜짐 ----
describe('⑫ 다시 열었더니 계산이 안 끝난 카드(NEEDS_ESTIMATE) — 이어서 계산', () => {
  it('estimateAppointment로 계산해 새 client_turn_id로 results만 보내고 카드는 READY', async () => {
    script = [
      session({ resumed: true, rev: 4, cards: [apptCard()] }),
      turn({ rev: 5, reply: { text: '오전 7시 40분에 깨울게요. 저장할까요?' }, cards: [apptCard({ status: 'READY' })] }),
    ];
    const c = await getConversation();
    expect(mEstimate).toHaveBeenCalledTimes(1);
    expect(bodies().map((x) => x.name)).toEqual(['voice-session', 'voice-turn']);
    const sent = turnBodies()[0];
    expect(sent).toMatchObject({ session_id: 's1', rev: 4 });
    expect(typeof sent.client_turn_id).toBe('string');
    expect(sent.text).toBeUndefined();
    expect((sent.results as { cards: { id: string; status: string }[] }).cards).toEqual([expect.objectContaining({ id: 'c1', status: 'READY' })]);
    expect(c.cards[0]).toMatchObject({ id: 'c1', status: 'READY' });
    expect(c.cards[0].alarms.map((a) => a.kind)).toEqual(['WAKE', 'PREPARE', 'DEPARTURE']);
    expect(c.messages.at(-1)?.text).toContain('저장할까요');
    await getConversation(); // 다시 읽어도 또 계산하지 않음
    expect(mEstimate).toHaveBeenCalledTimes(1);
    expect(edge).toHaveBeenCalledTimes(2);
  });

  it('장소가 필요한 카드는 NEEDS_PLACE로 알리고 그대로 둠 (계산 안 함)', async () => {
    mPlaces.mockImplementation(async () => []);
    script = [session({ resumed: true, rev: 4, cards: [apptCard()] }), turn({ rev: 5, reply: { text: '장소를 골라 주세요.' }, cards: [apptCard({ status: 'NEEDS_PLACE' })] })];
    const c = await getConversation();
    expect(mEstimate).not.toHaveBeenCalled();
    expect((turnBodies()[0].results as { cards: { status: string }[] }).cards[0]).toMatchObject({ status: 'NEEDS_PLACE', estimate: null });
    expect(c.cards[0].status).toBe('NEEDS_PLACE');
  });

  it('results를 못 보내도 계산한 결과는 남고 [다시 시도]가 같은 요청을 다시 보냄', async () => {
    script = [session({ resumed: true, rev: 4, cards: [apptCard()] }), new EdgeError('LLM_UNAVAILABLE')];
    let c = await getConversation();
    expect(c.unavailable?.code).toBe('LLM_UNAVAILABLE');
    expect(c.cards[0].status).toBe('READY');
    script = [turn({ rev: 5, reply: { text: '저장할까요?' }, cards: [apptCard({ status: 'READY' })] })];
    c = await retry();
    expect(turnBodies()[1]).toEqual(turnBodies()[0]);
    expect(mEstimate).toHaveBeenCalledTimes(1);
    expect(c.unavailable).toBeNull();
  });

  it('계산이 끝난 카드(READY)만 있으면 서버를 더 부르지 않음', async () => {
    script = [session({ resumed: true, rev: 4, cards: [apptCard({ status: 'READY' })] })];
    await getConversation();
    expect(mEstimate).not.toHaveBeenCalled();
    expect(edge).toHaveBeenCalledTimes(1);
  });
});

// ---- 실패한 요청(pending)을 카드 버튼이 덮어쓰지 않음 — 큐 ----
describe('⑬ pending이 있을 때 카드 동작은 큐에서 기다림', () => {
  // READY 카드 c1이 있는 대화에서 다음 말이 LLM_UNAVAILABLE로 실패한 상태 (state.rev = 3)
  async function textFailed() {
    script = [session(), turn({ next: 'APP_TASKS', reply: null, cards: [apptCard()] }), turn({ rev: 3, cards: [apptCard({ status: 'READY' })] })];
    await getConversation();
    await say('발표 있어');
    script = [new EdgeError('LLM_UNAVAILABLE')];
    const c = await say('그리고 하나 더');
    expect(c.unavailable?.code).toBe('LLM_UNAVAILABLE');
    edge.mockClear();
  }

  it('[저장]은 앱 일(createAppointment)을 바로 하고 서버 알림만 큐에 — unavailable · [다시 시도]는 그대로, 성공하면 순서대로 flush', async () => {
    await textFailed();
    const toast = await saveCard('c1');
    expect(toast).toBe('캡스톤 발표 알람을 맞췄어요');
    expect(mCreate).toHaveBeenCalledTimes(1); // 앱 쪽 일은 바로
    expect(edge).not.toHaveBeenCalled(); // 서버에는 아직 안 보냄 (말 요청을 덮어쓰지 않음)
    let c = await getConversation();
    expect(c.cards[0].status).toBe('SAVED');
    expect(c.unavailable?.code).toBe('LLM_UNAVAILABLE'); // 안내 · [다시 시도] 살아 있음
    expect(c.next).toBeNull();

    script = [turn({ rev: 4, reply: { text: '네, 하나 더요.' } }), turn({ rev: 5, reply: { text: '저장했어요.' }, cards: [apptCard({ status: 'SAVED' })] })];
    c = await retry();
    const [text, card] = turnBodies();
    expect(text).toMatchObject({ text: '그리고 하나 더', rev: 3 }); // 실패한 말을 같은 요청으로
    expect(card).toMatchObject({ rev: 4 }); // 말 답의 rev로 이어서
    expect(card.card_action).toMatchObject({ id: 'c1', action: 'SAVED', appointment_id: 'ap1' });
    expect(c.unavailable).toBeNull();
    expect(c.messages.at(-1)?.text).toBe('저장했어요.');
    expect(c.next).toEqual({ who: 'me', text: '' });
  });

  it('말이 다시 실패하면 큐는 그대로 두고 unavailable 유지, 다음 [다시 시도]에서 보냄 (죽은 안내 없음)', async () => {
    await textFailed();
    await rejectCard('c1');
    script = [new EdgeError('LLM_UNAVAILABLE')];
    let c = await retry();
    expect(c.unavailable?.code).toBe('LLM_UNAVAILABLE');
    expect(turnBodies()).toHaveLength(1); // 카드 요청은 아직
    script = [turn({ rev: 4 }), turn({ rev: 5, reply: null, cards: [apptCard({ status: 'REJECTED' })] })];
    c = await retry();
    expect(turnBodies()).toHaveLength(3);
    expect(turnBodies()[2].card_action).toEqual({ id: 'c1', action: 'REJECTED' });
    expect(c.unavailable).toBeNull();
    expect(c.cards[0].status).toBe('REJECTED');
  });

  it('큐의 카드 요청이 CONFLICT면 세션을 다시 읽고 같은 번호로 새 rev에 한 번 더 보냄 — 저장은 그대로', async () => {
    await textFailed();
    await saveCard('c1');
    script = [
      turn({ rev: 4 }),
      new EdgeError('CONFLICT'),
      session({ resumed: true, rev: 9, cards: [apptCard({ status: 'READY' })] }),
      turn({ rev: 10, reply: { text: '저장했어요.' }, cards: [apptCard({ status: 'SAVED' })] }),
    ];
    const c = await retry();
    expect(bodies().map((x) => x.name)).toEqual(['voice-turn', 'voice-turn', 'voice-session', 'voice-turn']);
    const cardBodies = turnBodies().slice(1);
    expect(cardBodies[0]).toMatchObject({ rev: 4 });
    expect(cardBodies[1]).toMatchObject({ rev: 9, client_turn_id: cardBodies[0].client_turn_id });
    expect(c.unavailable).toBeNull();
    expect(c.cards[0].status).toBe('SAVED');
    expect(mCreate).toHaveBeenCalledTimes(1);
  });

  it('장소 고르기 뒤 results도 큐에서 기다림 (앱 계산은 바로)', async () => {
    script = [session(), turn({ cards: [apptCard({ status: 'NEEDS_PLACE' })] })];
    await getConversation();
    await say('발표');
    script = [new EdgeError('LLM_UNAVAILABLE')];
    await say('다음');
    edge.mockClear();
    await pickCardPlace('c1', { name: '강남역 2번 출구', lat: 37.5, lng: 127.03 });
    expect(mEstimate).toHaveBeenCalledTimes(1);
    expect(edge).not.toHaveBeenCalled();
    expect((await getConversation()).cards[0].status).toBe('READY');
    expect((await getConversation()).unavailable).not.toBeNull();
    script = [turn({ rev: 4 }), turn({ rev: 5 })];
    await retry();
    expect((turnBodies()[1].results as { cards: { status: string }[] }).cards[0].status).toBe('READY');
  });
});
