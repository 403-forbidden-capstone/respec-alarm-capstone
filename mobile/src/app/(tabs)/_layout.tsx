import { Tabs } from 'expo-router/js-tabs';

import { TabBar } from '@/components/ui';
import { colors } from '@/theme';

// 아래 탭 4개 — 목업과 같은 순서 · 이름 (01 홈 · 02 그룹 · 03 AI · 04 기록)
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
      tabBar={(props) => <TabBar {...props} />}
    >
      <Tabs.Screen name="index" options={{ title: '홈' }} />
      <Tabs.Screen name="group" options={{ title: '그룹' }} />
      <Tabs.Screen name="ai" options={{ title: 'AI' }} />
      <Tabs.Screen name="records" options={{ title: '기록' }} />
    </Tabs>
  );
}
