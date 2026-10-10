import { router } from 'expo-router';

import { Screen, Text, TopBar } from '@/components/ui';

// F02 친구 권한 — 목업 화면이 들어올 자리 (#43)
export default function FriendPermissionScreen() {
  return (
    <Screen>
      <TopBar screenId="F02" onBack={router.canGoBack() ? router.back : undefined} />
      <Text variant="title">친구 권한</Text>
      <Text variant="lead">목업 F02 화면이 들어올 자리예요.</Text>
    </Screen>
  );
}
