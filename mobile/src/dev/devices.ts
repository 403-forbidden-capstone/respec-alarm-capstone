// 웹 미리보기 기종 목록 — 웹 · 네이티브 공용 순수 데이터 (components/dev/DeviceFrame이 씀)
// 폭 · 높이는 개발자 도구 기종 에뮬레이션과 같은 CSS 뷰포트 값, inset은 실기기의 상태바 · 제스처 바 높이
// 앱 화면이 보는 크기는 width × height 그대로이고, 베젤은 그 바깥에 더해짐

export type CameraShape = 'punchhole' | 'notch' | 'island'; // 가운데 펀치홀 · 노치 · 다이내믹 아일랜드

export type Device = {
  id: string;
  name: string;
  width: number; // CSS px
  height: number;
  radius: number; // 화면 모서리 반지름
  insetTop: number; // 상태바 높이
  insetBottom: number; // 제스처 바 영역 높이
  camera: CameraShape;
  bezel: number; // 베젤 두께
};

export const DEVICES: readonly Device[] = [
  { id: 's24', name: 'Galaxy S24', width: 360, height: 780, radius: 28, insetTop: 32, insetBottom: 24, camera: 'punchhole', bezel: 10 },
  { id: 's24-ultra', name: 'Galaxy S24 Ultra', width: 384, height: 824, radius: 14, insetTop: 32, insetBottom: 24, camera: 'punchhole', bezel: 10 },
  { id: 'a54', name: 'Galaxy A54', width: 412, height: 915, radius: 24, insetTop: 32, insetBottom: 24, camera: 'punchhole', bezel: 10 },
  { id: 'pixel8', name: 'Pixel 8', width: 412, height: 915, radius: 36, insetTop: 48, insetBottom: 24, camera: 'punchhole', bezel: 10 },
  { id: 'iphone15', name: 'iPhone 15 (참고용)', width: 393, height: 852, radius: 55, insetTop: 59, insetBottom: 34, camera: 'island', bezel: 12 },
];

export const DEFAULT_DEVICE_ID = 's24';

// 고른 기종 저장 키(localStorage)와 주소 인자(?device=s24) — 주소에 있으면 저장값보다 앞섬
export const DEVICE_STORAGE_KEY = 'respec.device';
export const DEVICE_QUERY = 'device';
export const PANEL_TOOLS_KEY = 'respec.panelTools'; // 패널 "도구" 묶음을 펼쳐 뒀는지 ('1' = 펼침). 새 세션을 눌러도 남김

// 레이아웃 숫자
export const PANEL_WIDTH = 280; // 왼쪽 패널 폭
export const PANEL_COLLAPSED_WIDTH = 44; // 접었을 때 폭
export const STAGE_MARGIN = 48; // 프레임 둘레 여백
export const FRAME_MIN_EXTRA = 100; // 창 폭이 기종 폭 + 이 값보다 좁으면 프레임 없이 앱만
export const MIN_SCALE = 0.3; // 축소 하한

export type Panel = { width: number; margin: number };
export type Size = { width: number; height: number };

export function getDevice(id: string | null | undefined): Device {
  return DEVICES.find((d) => d.id === id) ?? DEVICES.find((d) => d.id === DEFAULT_DEVICE_ID) ?? DEVICES[0];
}

export function isDeviceId(id: string | null | undefined): id is string {
  return DEVICES.some((d) => d.id === id);
}

// 프레임 전체 크기 (화면 + 베젤)
export function frameSize(device: Device): Size {
  return { width: device.width + device.bezel * 2, height: device.height + device.bezel * 2 };
}

// 프레임 · 패널을 보여 줄 만큼 넓은 창인지 — 좁으면 실기기 브라우저 · 개발자 도구 에뮬레이션으로 보고 앱만 그림
export function showFrame(windowWidth: number, device: Device): boolean {
  return windowWidth >= device.width + FRAME_MIN_EXTRA;
}

// 창에 프레임이 비율 1로 안 들어가면 줄이는 비율 (MIN_SCALE ~ 1)
// panel.width = 지금 차지하는 패널 폭(접으면 좁은 폭), panel.margin = 프레임 둘레 여백
export function fitScale(win: Size, device: Device, panel: Panel = { width: PANEL_WIDTH, margin: STAGE_MARGIN }): number {
  const frame = frameSize(device);
  const byWidth = (win.width - panel.width - panel.margin) / frame.width;
  const byHeight = (win.height - panel.margin) / frame.height;
  const scale = Math.min(1, byWidth, byHeight);
  return Number.isFinite(scale) ? Math.max(MIN_SCALE, scale) : 1;
}
