import { router } from 'expo-router';

import { Screen, Text, TopBar } from '@/components/ui';

// F03 공유 권한 설정 — 목업 화면이 들어올 자리 (#43)
export default function PermissionSettingsScreen() {
  return (
    <Screen>
      <TopBar screenId="F03" onBack={router.canGoBack() ? router.back : undefined} />
      <Text variant="title">공유 권한 설정</Text>
      <Text variant="lead">목업 F03 화면이 들어올 자리예요.</Text>
    </Screen>
  );
}
