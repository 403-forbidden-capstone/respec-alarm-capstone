import { useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useRef } from 'react';

import { confirm } from '@/components/ui';

// 입력한 내용이 있는 채로 화면을 나가려 하면 확인 창을 띄움 — "← 이전"(backOrHome) · 안드로이드 뒤로 가기 · 제스처 모두
// 나가려는 동작(router.back · replace · dismissTo …)은 모두 화면이 빠지는 일이라 한 곳에서 걸림
// 저장하고 나갈 때는 allowLeave()를 먼저 불러야 함 — dirty를 false로 바꿔도 같은 순간의 router.back에는 아직 반영되지 않음
//   const { allowLeave } = useLeaveGuard(dirty);
//   await save(); allowLeave(); router.back();
export function useLeaveGuard(dirty: boolean, message?: string) {
  const navigation = useNavigation();
  const allowed = useRef(false);

  usePreventRemove(dirty, ({ data }) => {
    // 저장 뒤처럼 이미 나가도 되는 경우는 물어보지 않고 막았던 동작을 그대로 이어 감
    if (allowed.current) {
      navigation.dispatch(data.action);
      return;
    }
    void confirm({
      title: '저장하지 않고 나갈까요?',
      message: message ?? '바꾼 내용이 사라져요.',
      okLabel: '나가기',
      destructive: true,
    }).then((ok) => {
      if (ok) navigation.dispatch(data.action);
    });
  });

  return {
    allowLeave: () => {
      allowed.current = true;
    },
  };
}
