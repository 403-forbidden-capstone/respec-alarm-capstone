// expo-router 가짜 — 푸시 · 알림을 눌러 화면이 어디로 갔는지만 기록
export const navLog: string[] = [];

const text = (href: unknown): string => (typeof href === 'string' ? href : JSON.stringify(href));

export const router = {
  push: (href: unknown) => void navLog.push(`push ${text(href)}`),
  navigate: (href: unknown) => void navLog.push(`navigate ${text(href)}`),
  dismissTo: (href: unknown) => void navLog.push(`dismissTo ${text(href)}`),
  canDismiss: () => false,
  replace: (href: unknown) => void navLog.push(`replace ${text(href)}`),
};

export function resetNav() {
  navLog.length = 0;
}
