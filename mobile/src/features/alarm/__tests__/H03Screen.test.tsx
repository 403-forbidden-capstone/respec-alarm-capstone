import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createElement, Fragment, type ComponentType } from 'react';
import { Text as RNText } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { SheetHost } from '@/components/ui';
import { db, kst } from '@/mocks/data';

import * as api from '../api';
import { TRAVEL_CONFIRM_EDIT, TRAVEL_CONFIRM_OK, TravelConfirmNeeded } from '../travelConfirm';
import type { AlarmSettingsDraft, StandaloneWake } from '../types';

// H03 알람 설정 화면 — 알람 없는 일정(장소 미정 · 장소를 나중에 정함)을 열고, [알람 계산해 보기] → 미리 보기 → 저장,
//   같은 날 일정 없는 기상 알람이 있으면 합칠지 · 따로 둘지 묻는 시트. 데이터는 가짜 모드 api 그대로, 독립 기상 알람 · 저장 · 토스트만 바꿔 봄

let mockId = '';
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true, canDismiss: () => false },
  useLocalSearchParams: () => ({ id: mockId }),
  useIsFocused: () => true,
  useScrollToTop: () => {},
  useNavigation: () => ({ dispatch: jest.fn() }),
  // 화면에 들어온 것처럼 한 번 (effect와 같게)
  useFocusEffect: (effect: () => void | (() => void)) => jest.requireActual<typeof import('react')>('react').useEffect(effect, [effect]),
}));
jest.mock('@/lib/useLeaveGuard', () => ({ useLeaveGuard: () => ({ allowLeave: () => {} }) }));
jest.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ session: null }) }));

const mockToast = jest.fn<(text: string) => void>();
jest.mock('@/components/ui', () => ({ ...jest.requireActual<object>('@/components/ui'), toast: (text: string) => mockToast(text) }));

const mockWakes = jest.fn<(at: Date) => Promise<StandaloneWake[]>>();
const mockSave = jest.fn<(id: string, draft: AlarmSettingsDraft) => ReturnType<typeof api.saveAlarmSettings>>();
jest.mock('../api', () => {
  const actual = jest.requireActual<typeof import('../api')>('../api');
  return {
    ...actual,
    listStandaloneWakes: (at: Date) => mockWakes(at),
    saveAlarmSettings: (id: string, draft: AlarmSettingsDraft) => mockSave(id, draft),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Screen = require('@/app/alarm/[id]').default as ComponentType;

jest.setTimeout(30_000); // 화면 전체를 처음 불러와 그리는 시험이라 전체 실행(병렬)에서는 5초를 넘기기도 함

const SEEDS = db.appointments.map((a) => ({ ...a }));
const actualSave = jest.requireActual<typeof import('../api')>('../api').saveAlarmSettings;
const EIGHT: StandaloneWake = { id: 'al-8', at: kst(23, 480) };
let renderer: ReactTestRenderer;

beforeEach(() => {
  mockToast.mockReset();
  mockWakes.mockReset();
  mockWakes.mockResolvedValue([]);
  mockSave.mockReset();
  mockSave.mockImplementation((id, draft) => actualSave(id, draft));
});
afterEach(() => {
  act(() => renderer?.unmount());
  db.appointments.splice(0, db.appointments.length, ...SEEDS.map((a) => ({ ...a })));
});

const flush = () => act(async () => {});
async function open(id: string) {
  mockId = id;
  await act(async () => {
    renderer = create(createElement(SafeAreaProvider, { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } } }, createElement(Fragment, null, createElement(Screen), createElement(SheetHost))));
  });
  await flush();
}

const textOf = (n: unknown): string => (typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : '');
// 공용 Text가 끼우는 한글 줄바꿈용 글자 이음(U+2060)은 빼고 비교
const screenText = () => renderer.root.findAllByType(RNText).map((n) => textOf(n.props.children)).join('\n').replace(/⁠/g, '');
const buttons = (label: string) => renderer.root.findAll((n) => n.props.label === label && typeof n.props.onPress === 'function');
const button = (label: string): ReactTestInstance => {
  const found = buttons(label);
  if (!found.length) throw new Error(`버튼 "${label}" 없음\n${screenText()}`);
  return found[0];
};
const press = async (label: string) => {
  await act(async () => {
    button(label).props.onPress();
  });
  await flush();
};
const byProp = (prop: string) => renderer.root.findAll((n) => typeof n.props[prop] === 'function')[0];

// 장소 없이 저장한 일정 (가짜 모드 = alarm-commit PLACE_PENDING과 같은 모양: 장소 빈칸 · 알람 없음)
const pendingMeeting = async () => (await api.createPlacePendingAppointment({ title: '캡스톤 회의', at: kst(23, 780), importance: 'NORMAL' })).id;
const placedMeeting = async () => {
  const id = await pendingMeeting();
  await api.updateAppointment(id, { place: '세종대학교', placeLat: 37.55, placeLng: 127.07 }, 'this', { confirmed: true });
  return id;
};
async function previewShown(id: string) {
  await open(id);
  await press('알람 계산해 보기');
  await flush();
}

describe('H03 — 알람 없는 일정', () => {
  it('장소 미정: 열리고 "장소 미정" · 장소를 정하라는 안내, 알람 계산 · 저장 버튼 없음 → 연결 일정에서 장소를 고르면 같은 일정에 장소가 붙고 [알람 계산해 보기]가 생김', async () => {
    const id = await pendingMeeting();
    await open(id);
    const text = screenText();
    expect(text).toContain('캡스톤 회의');
    expect(text).toContain('장소 미정');
    expect(text).toContain('장소가 정해지지 않아 알람을 계산하지 않았어요');
    expect(text).toContain('알람 없음');
    expect(buttons('알람 계산해 보기')).toHaveLength(0);
    expect(buttons('저장')).toHaveLength(0);

    // 연결 일정 → 편집 시트 → 장소 고르기 → 저장 (화면과 같은 콜백)
    await act(async () => byProp('onPickPlace').props.onPickPlace());
    await act(async () => byProp('onPick').props.onPick({ name: '세종대학교', lat: 37.55, lng: 127.07 }));
    await act(async () => byProp('onSave').props.onSave());
    await flush();

    const after = screenText();
    expect(after).toContain('세종대학교');
    expect(after).not.toContain('장소가 정해지지 않아');
    expect(buttons('알람 계산해 보기')).toHaveLength(1);
    expect((await api.getAppointment(id, { withoutAlarms: true }))?.alarms).toEqual([]); // 장소만 · 알람은 아직
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('[알람 계산해 보기] → 미리 보기(출발 · 도착 목표) · 저장 버튼 켜짐 — 저장을 누르기 전엔 저장 안 함 · 완료 토스트 없음 → 저장하면 알람이 생기고 "알람을 만들었어요"', async () => {
    const id = await placedMeeting();
    await previewShown(id);
    expect(screenText()).toContain('출발');
    expect(button('저장').props.disabled).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();

    await press('저장');
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0][1].linkWakeAlarmId).toBeUndefined();
    expect(mockToast).toHaveBeenCalledWith('알람을 만들었어요');
    expect((await api.getAppointment(id))?.alarms.length).toBeGreaterThan(0);
  });
});

describe('H03 — 같은 날 일정 없는 기상 알람 합치기 시트', () => {
  // 그날 첫 일정이라 기상이 생기는 일정 — 기상이 새로 생길 때만 시트를 띄움
  const withWake = async () => {
    const id = await placedMeeting();
    Object.assign(db.appointments.find((a) => a.id === id)!, { withWake: true, prepMinutes: 60, predictedPrepMinutes: 60, beforePrepMinutes: 20 });
    mockWakes.mockResolvedValue([EIGHT]);
    await previewShown(id);
    expect(screenText()).toContain('기상');
    return id;
  };

  it('저장을 누르면 저장 전에 시트 — 직접 만든 기상 8:00 · 계산한 기상 · [합치기] · [따로 두기], 아직 저장 · 완료 토스트 없음', async () => {
    await withWake();
    await press('저장');
    const text = screenText();
    expect(text).toContain('같은 날 기상 알람이 있어요');
    expect(text).toContain('직접 만든 기상');
    expect(text).toContain('이 일정의 기상 (계산)');
    expect(buttons('오전 8:00 알람을 이 일정 기상으로 합치기')).toHaveLength(1);
    expect(buttons('따로 두기 (둘 다 울림)')).toHaveLength(1);
    expect(mockWakes).toHaveBeenCalledWith(kst(23, 780));
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('[합치기] → 기상 = 8:00 · link_wake 알람 id로 저장, 저장이 끝난 뒤에만 "합쳤어요"', async () => {
    await withWake();
    await press('저장');
    await press('오전 8:00 알람을 이 일정 기상으로 합치기');
    expect(mockSave).toHaveBeenCalledTimes(1);
    const draft = mockSave.mock.calls[0][1];
    expect([draft.linkWakeAlarmId, draft.times.WAKE]).toEqual(['al-8', kst(23, 480)]);
    expect(mockToast).toHaveBeenCalledWith('오전 8:00 기상 알람을 이 일정의 기상 알람으로 합쳤어요');
    expect(screenText()).not.toContain('같은 날 기상 알람이 있어요');
  });

  it('[따로 두기] → 합치지 않고 저장 (일정 없는 알람은 그대로)', async () => {
    await withWake();
    await press('저장');
    await press('따로 두기 (둘 다 울림)');
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0][1].linkWakeAlarmId).toBeUndefined();
    expect(mockSave.mock.calls[0][1].times.WAKE).toBeUndefined();
    expect(mockToast).toHaveBeenCalledWith('알람을 만들었어요');
  });

  it('시트 닫기 → 저장 안 함 · 다음 저장에서 다시 물음', async () => {
    await withWake();
    await press('저장');
    const sheet = renderer.root.findAll((n) => n.props.title === '같은 날 기상 알람이 있어요' && typeof n.props.onClose === 'function')[0];
    await act(async () => sheet.props.onClose()); // 바깥 누름 · 뒤로 가기 = 시트 onClose
    await flush();
    expect(screenText()).not.toContain('같은 날 기상 알람이 있어요');
    expect(mockSave).not.toHaveBeenCalled();
    await press('저장');
    expect(screenText()).toContain('같은 날 기상 알람이 있어요');
    expect(mockWakes).toHaveBeenCalledTimes(2);
  });

  it('[합치기]로 고른 저장이 실패하면 완료 토스트 없이 다음 저장에서 다시 물음 — 이전 선택(합치기)을 묻지 않고 다시 쓰지 않음', async () => {
    await withWake();
    mockSave.mockRejectedValueOnce(new Error('네트워크'));
    await press('저장');
    await press('오전 8:00 알람을 이 일정 기상으로 합치기');
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockToast).not.toHaveBeenCalledWith(expect.stringContaining('합쳤어요'));

    await press('저장');
    expect(screenText()).toContain('같은 날 기상 알람이 있어요'); // 다시 물음
    expect(mockSave).toHaveBeenCalledTimes(1);
    await press('따로 두기 (둘 다 울림)');
    expect(mockSave.mock.calls[1][1].linkWakeAlarmId).toBeUndefined(); // 지금 고른 것(따로 두기)대로
  });

  it('[합치기] 뒤 이동시간 확인 시트를 닫고(저장 안 함) 다시 저장하면 다시 물음 — 이전 합치기를 묻지 않고 다시 쓰지 않음', async () => {
    await withWake();
    mockSave.mockRejectedValueOnce(new TravelConfirmNeeded({ minutes: 35, source: 'ESTIMATE' }));
    await press('저장');
    await press('오전 8:00 알람을 이 일정 기상으로 합치기');
    expect(screenText()).toContain('이동시간을 확인해 주세요');
    await press(TRAVEL_CONFIRM_EDIT); // 저장하지 않고 닫음
    expect(mockToast).not.toHaveBeenCalled();

    await press('저장');
    expect(screenText()).toContain('같은 날 기상 알람이 있어요'); // 다시 물음
    expect(mockSave).toHaveBeenCalledTimes(1);
    await press('따로 두기 (둘 다 울림)');
    expect(mockSave.mock.calls[1][1].linkWakeAlarmId).toBeUndefined();
  });

  it('[합치기] 뒤 이동시간 확인 시트에서 [이 값으로 저장] — 같은 저장 흐름이라 고른 합치기를 그대로 씀', async () => {
    await withWake();
    mockSave.mockRejectedValueOnce(new TravelConfirmNeeded({ minutes: 35, source: 'ESTIMATE' }));
    await press('저장');
    await press('오전 8:00 알람을 이 일정 기상으로 합치기');
    await press(TRAVEL_CONFIRM_OK);
    expect(mockSave).toHaveBeenCalledTimes(2);
    expect([mockSave.mock.calls[1][1].linkWakeAlarmId, mockSave.mock.calls[1][1].travelMinutes]).toEqual(['al-8', 35]);
    expect(mockToast).toHaveBeenCalledWith('오전 8:00 기상 알람을 이 일정의 기상 알람으로 합쳤어요');
  });
});
