// 저장과 따로 불리는 고친 값 기록(recordEdit)을 다음 저장(alarm-commit)에 실어 보내려고 잠깐 쌓아 두는 곳 (실데이터)
//   고친 값 기록은 저장이 성공해야 남기는 것이라(F9 · D42 C) 따로 insert하지 않음 — alarm-commit이 요청의 edits를 user_edit_logs에 씀
//   같은 일정(appointmentId)의 다음 저장이 이 줄들을 가져가고, 저장이 성공하면 큐에서 뺌. 메모리에만 두므로 앱을 닫으면 사라짐
//   (S01처럼 자기 저장 경로가 있는 화면은 자기 alarm-commit 요청의 edits에 직접 담으면 됨)
import type { EditLogLine } from './edits';

const MAX_QUEUED = 100;
let queue: EditLogLine[] = [];

const keyOf = (line: Pick<EditLogLine, 'appointmentId'>) => line.appointmentId ?? null;

export function queueEdit(line: EditLogLine): void {
  queue.push(line);
  if (queue.length > MAX_QUEUED) queue = queue.slice(-MAX_QUEUED);
}

// 이 일정(없으면 일정 없는 알람)에 실어 보낼 줄 — 빼지는 않음 (저장이 실패하면 다음에 다시)
export function peekEdits(appointmentId: string | null): EditLogLine[] {
  return queue.filter((line) => keyOf(line) === appointmentId);
}

// 저장이 성공한 뒤 보낸 줄만 뺌
export function dropEdits(sent: readonly EditLogLine[]): void {
  const gone = new Set(sent);
  queue = queue.filter((line) => !gone.has(line));
}

export function clearEdits(): void {
  queue = [];
}
