import { Share } from 'react-native';

import { toast } from '@/components/ui';

// 초대 코드를 다른 앱으로 보냄 (카카오톡 · 메시지 · 복사는 공유창에서)
// 웹처럼 공유창이 없으면 코드를 길게 눌러 복사하도록 안내 — 사용자가 창을 닫은 것(AbortError)은 오류가 아님
// G02 "+ 초대"(groups/[id]/index.tsx)에도 같은 코드가 있음 — 그 파일의 바로 위 줄을 #354가 고치고 있어, 머지 뒤 이 함수로 바꿈
export async function shareInvite(name: string, code: string) {
  try {
    await Share.share({ message: `Re:Spec 알람 '${name}' 그룹에 초대해요. 초대 코드: ${code}` });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return;
    toast('코드를 길게 눌러 복사해 주세요');
  }
}
