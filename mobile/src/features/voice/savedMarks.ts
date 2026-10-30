// ③ 자기 전 대화 — '저장됨' 로컬 표시 (폰 AsyncStorage · 웹 localStorage)
//   카드 [저장]이 L1 함수로 일정을 만든 직후, 서버에 SAVED를 알리기 전에 적어 둠. 서버에 못 알리고 앱이 꺼져도(서버는 카드를 READY로 기억)
//   다시 열었을 때 이 표시로 카드를 저장됨으로 복원해 createAppointment가 또 불리지 않게 하고, SAVED 알림만 다시 보냄
//   서버가 SAVED로 확인하면(알림 성공 · 다시 열었더니 서버가 이미 SAVED · 서버가 카드를 모름) 지움
//   저장소가 막히거나 값이 깨져도 대화를 못 하게 만들지 않음 — 못 읽으면 표시 없음(지금 동작), 못 쓰면 이번 실행에만
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { CardKind } from './types';

const PREFIX = 'respec.voice.saved.'; // + 세션 번호 → { [카드 번호]: SavedMark }

// 서버에 SAVED를 다시 알리는 데 필요한 값 (card_action SAVED의 appointment_id · alarms)
export type SavedMark = {
  appointmentId: string;
  cardKind: CardKind;
  alarms: { kind: string; at: string; enabled: boolean; level: number }[];
  savedAt: string; // ISO
};

type Marks = Record<string, SavedMark>;

const keyOf = (sessionId: string) => `${PREFIX}${sessionId}`;

const isMark = (v: unknown): v is SavedMark => {
  const m = v as Partial<SavedMark> | null;
  return !!m && typeof m === 'object' && typeof m.appointmentId === 'string' && Array.isArray(m.alarms) && typeof m.cardKind === 'string';
};

async function readAll(sessionId: string): Promise<Marks> {
  try {
    const raw = await AsyncStorage.getItem(keyOf(sessionId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Marks = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) if (isMark(v)) out[id] = v;
    return out;
  } catch {
    return {};
  }
}

async function writeAll(sessionId: string, marks: Marks): Promise<void> {
  try {
    if (Object.keys(marks).length === 0) await AsyncStorage.removeItem(keyOf(sessionId));
    else await AsyncStorage.setItem(keyOf(sessionId), JSON.stringify(marks));
  } catch {
    // 저장소 오류 — 표시 없이 진행
  }
}

export async function readSavedMarks(sessionId: string): Promise<Marks> {
  return readAll(sessionId);
}

export async function markSaved(sessionId: string, cardId: string, mark: SavedMark): Promise<void> {
  const marks = await readAll(sessionId);
  marks[cardId] = mark;
  await writeAll(sessionId, marks);
}

export async function clearSaved(sessionId: string, cardId: string): Promise<void> {
  const marks = await readAll(sessionId);
  if (!(cardId in marks)) return;
  delete marks[cardId];
  await writeAll(sessionId, marks);
}

// 지금 세션이 아닌 세션의 표시는 지움 — 하루가 지나 새 세션이 열리면 앞 세션 카드는 서버에 알릴 수 없음
export async function pruneOtherSessions(currentSessionId: string): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const stale = keys.filter((k) => k.startsWith(PREFIX) && k !== keyOf(currentSessionId));
    if (stale.length > 0) await AsyncStorage.multiRemove(stale);
  } catch {
    // 저장소 오류 — 남겨 둠
  }
}
