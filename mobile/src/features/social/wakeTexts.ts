// 그룹 기상 상태 문구 (친구 7장) — G01 카드 · G02 멤버 메뉴 · G03 · 옛 값 안내
//   단계 글자('8:50 알람' · '울렸어요' · '일어났어요 8:08' · '알람 없음' · '공유 안 함')는 map.ts wakeStateOf

// G01 그룹 카드 '오늘 n명 일어남' — 분모 없음, 약속 없는 날(null)은 줄을 숨김 (7-사 · 7-34)
export const wokeLine = (n: number | null) => (n == null ? null : `오늘 ${n}명 일어남`);

// G02 멤버 메뉴 — 숨김은 사람 단위(내가 속한 모든 그룹), 상대는 모름 (7-더 · 7-43)
export const wakeHideLabel = (hidden: boolean) => (hidden ? '이 사람에게 기상 보이기' : '이 사람에게 기상 숨기기');
export const wakeHideToast = (name: string, hidden: boolean) =>
  hidden ? `${name}님에게 내 기상을 숨겼어요. 상대에게는 알리지 않아요` : `${name}님에게 내 기상이 다시 보여요`;
export const WAKE_HIDE_FAILED = '이 사람에게는 기상 숨기기를 바꿀 수 없어요'; // set_wake_hidden NOT_FOUND (관계가 끊김 등)

// 다시 읽기가 실패했거나 실시간이 끊겼을 때 — 옛 값을 최신처럼 보이지 않게 (7-36)
export const WAKE_STALE_TEXT = '연결이 끊겨 최신 상태가 아닐 수 있어요';

// G03 — 줄이 안 나온 사람(동의 안 함 · 숨김 · 차단)은 구분 없이 같은 말 (7-06)
export const WAKE_NOT_SHARED_TITLE = '기상 상태를 볼 수 없어요';
export const WAKE_NOT_SHARED_BODY = '이 그룹에서 기상 공유를 켠 멤버만 볼 수 있어요.';
