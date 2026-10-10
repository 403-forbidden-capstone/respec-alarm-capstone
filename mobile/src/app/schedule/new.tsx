import { router } from 'expo-router';

import { Screen, Text, TopBar } from '@/components/ui';

// H05 새 일정 만들기 — 목업 화면이 들어올 자리 (#30)
export default function NewScheduleScreen() {
  return (
    <Screen>
      <TopBar screenId="H05" onBack={router.canGoBack() ? router.back : undefined} />
      <Text variant="title">새 일정 만들기</Text>
      <Text variant="lead">목업 H05 화면이 들어올 자리예요.</Text>
    </Screen>
  );
}
