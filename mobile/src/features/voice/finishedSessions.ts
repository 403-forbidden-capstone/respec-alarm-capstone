// ③ 자기 전 대화 — 예전 방식으로 [완료]한 세션 번호 읽기 (폰 AsyncStorage · 웹 localStorage)
//   예전에는 [완료]가 세션을 끝냈고, 정리 요청이 실패해 서버에 안 끝난 채 남은 세션을 resume이 돌려주면 이 표시로 무시했음.
//   지금은 [완료]해도 같은 날은 같은 대화를 이어 쓰므로 새로 적지 않음 — 업데이트 전에 적힌 표시만 읽어 옛 세션을 합치지 않게 함
//   키 = respec.voice.finished.<사용자 id> → 세션 번호 배열. 못 읽으면 없음
// shortcut: 옛 표시는 지우지 않음(최대 20개) — 업데이트 뒤 며칠 지나면 이 읽기와 키를 통째로 지워도 됨
import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'respec.voice.finished.';
const KEEP = 20; // 다시 보낼 정리 목록 최대 수

const keyOf = (userId: string) => `${PREFIX}${userId}`;

async function read(userId: string): Promise<string[]> {
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(keyOf(userId))) ?? 'null') as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export async function isFinished(userId: string, sessionId: string): Promise<boolean> {
  return (await read(userId)).includes(sessionId);
}

// 대화 정리(voice-commit)를 아직 서버가 끝내지 못한 세션 — [완료] 때 적고, 서버가 DONE을 주면 지움. 못 보냈으면 다음에 대화를 열 때 다시 보냄
//   키 = respec.voice.commit.<사용자 id>. 서버는 정리한 뒤 새 말이 없으면 다시 저장하지 않으므로 여러 번 보내도 됨 (같은 날 [완료]를 또 누르면 같은 세션이 다시 적힘)
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
  commitMemory.clear();
}
