import { router } from 'expo-router';

import { Screen, Text, TopBar } from '@/components/ui';

// S01 알람 조정 제안 — 목업 화면이 들어올 자리 (#38)
export default function SuggestionScreen() {
  return (
    <Screen>
      <TopBar screenId="S01" onBack={router.canGoBack() ? router.back : undefined} />
      <Text variant="title">알람 조정 제안</Text>
      <Text variant="lead">목업 S01 화면이 들어올 자리예요.</Text>
    </Screen>
  );
}
