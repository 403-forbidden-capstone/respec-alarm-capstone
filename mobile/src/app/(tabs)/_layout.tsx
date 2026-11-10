import { Tabs } from 'expo-router/js-tabs';

import { TabBar } from '@/components/ui';
import { colors } from '@/theme';

// 아래 탭 4개 — 01 홈 · 02 알람 · 03 그룹 · 04 AI (D110 — 목업의 04 기록은 홈 맨 아래로, 알람 목록이 2번 탭)
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
      tabBar={(props) => <TabBar {...props} />}
    >
      <Tabs.Screen name="index" options={{ title: '홈' }} />
      <Tabs.Screen name="alarms" options={{ title: '알람' }} />
      <Tabs.Screen name="group" options={{ title: '그룹' }} />
      <Tabs.Screen name="ai" options={{ title: 'AI' }} />
    </Tabs>
  );
}
