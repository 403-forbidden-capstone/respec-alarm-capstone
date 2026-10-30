// ③ 자기 전 대화 — '저장됨' 로컬 표시 (폰 AsyncStorage · 웹 localStorage)
//   카드 [저장]이 L1 함수로 일정을 만든 직후, 서버에 SAVED를 알리기 전에 적어 둠. 서버에 못 알리고 앱이 꺼져도(서버는 카드를 READY로 기억)
//   다시 열었을 때 이 표시로 카드를 저장됨으로 복원해 createAppointment가 또 불리지 않게 하고, SAVED 알림만 다시 보냄
//   서버가 SAVED로 확인하면(알림 성공 · 다시 열었더니 서버가 이미 SAVED · REJECTED · 알림이 NOT_FOUND) 지움
//   키 = respec.voice.saved.<사용자 id>.<세션 번호> — 다른 계정으로 로그인하면 보이지 않고(로그아웃 때 비우지 않음), 같은 사람이 돌아오면 복원됨
//   정리: 지금 사용자의 다른 세션 표시(pruneOtherSessions, 하루 뒤 새 세션이 열리면 앞 세션 카드는 서버에 알릴 수 없음) ·
//         7일 지난 표시와 옛 키(사용자 id 없던 respec.voice.saved.<세션 번호>)는 모든 사용자 것을 앱이 대화를 열 때(pruneExpired) ·
//         L7 [내 시험 데이터 지우기]는 clearSavedMarksForUser
//   저장소가 막히거나 값이 깨져도 대화를 못 하게 만들지 않음 — 못 읽으면 표시 없음(지금 동작), 못 쓰면 이번 실행에만
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { CardKind } from './types';

const PREFIX = 'respec.voice.saved.'; // + 사용자 id + '.' + 세션 번호 → { [카드 번호]: SavedMark }
export const SAVED_MARK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 이만큼 지난 표시는 지움

// 서버에 SAVED를 다시 알리는 데 필요한 값 (card_action SAVED의 appointment_id · alarms)
export type SavedMark = {
  appointmentId: string;
  cardKind: CardKind;
  alarms: { kind: string; at: string; enabled: boolean; level: number }[];
  savedAt: string; // ISO — 7일 정리 기준
};

type Marks = Record<string, SavedMark>;

const keyOf = (userId: string, sessionId: string) => `${PREFIX}${userId}.${sessionId}`;

// PREFIX 뒤에 '.'이 없으면 사용자 id가 없던 옛 키 (id · 세션 번호는 uuid라 '.'이 없음)
const isLegacyKey = (key: string) => !key.slice(PREFIX.length).includes('.');

const isMark = (v: unknown): v is SavedMark => {
  const m = v as Partial<SavedMark> | null;
  return !!m && typeof m === 'object' && typeof m.appointmentId === 'string' && Array.isArray(m.alarms) && typeof m.cardKind === 'string';
};

function parseMarks(raw: string | null): Marks {
  const parsed = raw ? (JSON.parse(raw) as unknown) : null;
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Marks = {};
  for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) if (isMark(v)) out[id] = v;
  return out;
}

async function readAll(userId: string, sessionId: string): Promise<Marks> {
  try {
    return parseMarks(await AsyncStorage.getItem(keyOf(userId, sessionId)));
  } catch {
    return {};
  }
}

async function writeAll(userId: string, sessionId: string, marks: Marks): Promise<void> {
  try {
    if (Object.keys(marks).length === 0) await AsyncStorage.removeItem(keyOf(userId, sessionId));
    else await AsyncStorage.setItem(keyOf(userId, sessionId), JSON.stringify(marks));
  } catch {
    // 저장소 오류 — 표시 없이 진행
  }
}

export async function readSavedMarks(userId: string, sessionId: string): Promise<Marks> {
  return readAll(userId, sessionId);
}

export async function markSaved(userId: string, sessionId: string, cardId: string, mark: SavedMark): Promise<void> {
  const marks = await readAll(userId, sessionId);
  marks[cardId] = mark;
  await writeAll(userId, sessionId, marks);
}

export async function clearSaved(userId: string, sessionId: string, cardId: string): Promise<void> {
  const marks = await readAll(userId, sessionId);
  if (!(cardId in marks)) return;
  delete marks[cardId];
  await writeAll(userId, sessionId, marks);
}

// 이 사용자의, 지금 세션이 아닌 세션의 표시를 지움 — 다른 사용자의 표시는 건드리지 않음
export async function pruneOtherSessions(userId: string, currentSessionId: string): Promise<void> {
  try {
    const mine = `${PREFIX}${userId}.`;
    const keys = await AsyncStorage.getAllKeys();
    const stale = keys.filter((k) => k.startsWith(mine) && k !== keyOf(userId, currentSessionId));
    if (stale.length > 0) await AsyncStorage.multiRemove(stale);
  } catch {
    // 저장소 오류 — 남겨 둠
  }
}

// 모든 사용자의 표시 중 savedAt이 7일 넘은 것을 지움 (값이 깨졌거나 savedAt을 못 읽는 표시도 지움). 옛 키(사용자 id 없음)는 읽지 않고 통째로 지움
//   앱이 대화를 열 때 한 번 — now는 lib/clock now()
export async function pruneExpired(now: Date): Promise<void> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
    const drop: string[] = keys.filter(isLegacyKey);
    for (const key of keys) {
      if (isLegacyKey(key)) continue;
      try {
        const marks = parseMarks(await AsyncStorage.getItem(key));
        const alive: Marks = {};
        for (const [id, mark] of Object.entries(marks)) {
          const savedAt = new Date(mark.savedAt).getTime();
          if (Number.isFinite(savedAt) && now.getTime() - savedAt <= SAVED_MARK_TTL_MS) alive[id] = mark;
        }
        const left = Object.keys(alive).length;
        if (left === 0) drop.push(key);
        else if (left !== Object.keys(marks).length) await AsyncStorage.setItem(key, JSON.stringify(alive));
      } catch {
        drop.push(key); // JSON이 깨진 키
      }
    }
    if (drop.length > 0) await AsyncStorage.multiRemove(drop);
  } catch {
    // 저장소 오류 — 남겨 둠
  }
}

// L7 [내 시험 데이터 지우기] — 그 사용자의 표시를 전부 지움
export async function clearSavedMarksForUser(userId: string): Promise<void> {
  try {
    const mine = `${PREFIX}${userId}.`;
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(mine));
    if (keys.length > 0) await AsyncStorage.multiRemove(keys);
  } catch {
    // 저장소 오류 — 남겨 둠
  }
}
