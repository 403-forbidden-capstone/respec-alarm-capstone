// ③ 자기 전 대화 — [완료]로 끝낸 세션 번호 (폰 AsyncStorage · 웹 localStorage)
//   서버에는 세션을 닫는 길이 아직 없어서(voice-commit 뒤) [완료]한 세션도 서버에는 안 끝난 채로 남음 — 앱을 다시 열면 voice-session resume이 그 세션을 또 돌려줌.
//   그래서 [완료]한 세션 번호를 앱이 적어 두고, resume이 그 세션을 주면 무시하고 새 세션을 요청함. "완료하지 않고 나갔다 돌아온" 세션은 적지 않으므로 그대로 이어짐.
//   키 = respec.voice.finished.<사용자 id> → 세션 번호 배열 (최근 것만 남김). 저장소가 막혀도 대화를 못 하게 만들지 않음 — 못 읽으면 없음, 못 쓰면 이번 실행에만
import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'respec.voice.finished.';
const KEEP = 20; // 하루 대화 5개 · 몇 날치면 충분

const keyOf = (userId: string) => `${PREFIX}${userId}`;

const memory = new Map<string, string[]>(); // 저장소가 막혔을 때 이번 실행에만 쓰는 값

async function read(userId: string): Promise<string[]> {
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(keyOf(userId))) ?? 'null') as unknown;
    const ids = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    return [...new Set([...ids, ...(memory.get(userId) ?? [])])];
  } catch {
    return memory.get(userId) ?? [];
  }
}

export async function markFinished(userId: string, sessionId: string): Promise<void> {
  const ids = [...(await read(userId)).filter((id) => id !== sessionId), sessionId].slice(-KEEP);
  memory.set(userId, ids);
  try {
    await AsyncStorage.setItem(keyOf(userId), JSON.stringify(ids));
    memory.delete(userId); // 저장됨 — 메모리 사본은 필요 없음
  } catch {
    // 저장소 오류 — 이번 실행에만
  }
}

export async function isFinished(userId: string, sessionId: string): Promise<boolean> {
  return (await read(userId)).includes(sessionId);
}

// 시험용 — 이번 실행 메모리 비우기
export function resetFinishedMemory() {
  memory.clear();
}
