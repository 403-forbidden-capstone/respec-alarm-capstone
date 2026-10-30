// 시간표 가져오기 확인 화면(app/timetable-import.tsx)으로 넘기는 메모 — 사진 읽기 · 캘린더 후보를 만든 화면이 적고, 확인 화면이 처음 열릴 때 읽음
// 사진 · 캘린더 원본은 들어 있지 않음(읽어 낸 수업 줄뿐). 읽어도 비우지 않음 — 개발 모드에서 화면 초기화가 두 번 돌아도 같은 값을 받게.
// 가져오는 쪽이 늘 화면을 열기 직전에 새로 적으므로 지난 값이 보이는 일은 없음
import type { ImportBatch } from './timetableImport';

let current: ImportBatch | null = null;

export function setImportBatch(batch: ImportBatch | null): void {
  current = batch;
}

export function getImportBatch(): ImportBatch | null {
  return current;
}
