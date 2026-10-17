// UUID v4 — 개발 화면의 테스트 알람 id와 웹 대체의 기록 번호에 씀 (보안용 아님)
export function makeUuid(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    return (char === 'x' ? random : (random % 4) + 8).toString(16);
  });
}
