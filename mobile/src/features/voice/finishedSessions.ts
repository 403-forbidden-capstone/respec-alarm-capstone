// ③ 자기 전 대화 — [완료]로 끝낸 세션 번호 (폰 AsyncStorage · 웹 localStorage)
//   서버는 대화 끝 정리(voice-commit)가 끝나야 세션을 닫으므로, 정리 요청이 실패하면 [완료]한 세션이 서버에는 안 끝난 채로 남음 — 앱을 다시 열면 voice-session resume이 그 세션을 또 돌려줌.
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

// 대화 끝 정리(voice-commit)를 아직 서버가 끝내지 못한 세션 — [완료] 때 적고, 서버가 DONE을 주면 지움. 못 보냈으면 다음에 대화를 열 때 다시 보냄
//   키 = respec.voice.commit.<사용자 id>. 서버는 같은 세션을 한 번만 정리하므로 여러 번 보내도 됨
//   rejected = 그 세션에서 [저장 안 함]을 누른 카드 번호 — 서버에 못 알렸을 수 있어 정리 요청에 실어 보냄(서버가 열린 카드만 REJECTED로). 옛 모양(세션 번호 글자)은 rejected 없음으로 읽음
export type PendingCommit = { sessionId: string; rejected: string[] };
const COMMIT_PREFIX = 'respec.voice.commit.';
const commitMemory = new Map<string, PendingCommit[]>();

function commitOf(v: unknown): PendingCommit | null {
  if (typeof v === 'string') return { sessionId: v, rejected: [] };
  const o = v as { sessionId?: unknown; rejected?: unknown } | null;
  if (!o || typeof o.sessionId !== 'string') return null;
  return { sessionId: o.sessionId, rejected: Array.isArray(o.rejected) ? o.rejected.filter((r): r is string => typeof r === 'string') : [] };
}

async function readCommits(userId: string): Promise<PendingCommit[]> {
  const mem = commitMemory.get(userId);
  if (mem) return mem; // 저장소가 막혀 이번 실행에만 둔 목록이 최신
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(`${COMMIT_PREFIX}${userId}`)) ?? 'null') as unknown;
    return Array.isArray(parsed) ? parsed.map(commitOf).filter((c): c is PendingCommit => c !== null) : [];
  } catch {
    return [];
  }
}

async function writeCommits(userId: string, list: PendingCommit[]): Promise<void> {
  commitMemory.set(userId, list);
  try {
    if (list.length > 0) await AsyncStorage.setItem(`${COMMIT_PREFIX}${userId}`, JSON.stringify(list));
    else await AsyncStorage.removeItem(`${COMMIT_PREFIX}${userId}`);
    commitMemory.delete(userId);
  } catch {
    // 저장소 오류 — 이번 실행에만
  }
}

export const pendingCommits = (userId: string): Promise<PendingCommit[]> => readCommits(userId);

export async function addPendingCommit(userId: string, sessionId: string, rejected: string[] = []): Promise<void> {
  await writeCommits(userId, [...(await readCommits(userId)).filter((c) => c.sessionId !== sessionId), { sessionId, rejected }].slice(-KEEP));
}

export async function removePendingCommit(userId: string, sessionId: string): Promise<void> {
  await writeCommits(userId, (await readCommits(userId)).filter((c) => c.sessionId !== sessionId));
}

// 시험용 — 이번 실행 메모리 비우기
export function resetFinishedMemory() {
  memory.clear();
  commitMemory.clear();
}
