import { Tabs } from 'expo-router/js-tabs';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { TabBar, Text } from '@/components/ui';
import { useSocialBadge } from '@/features/social/hooks/useSocialBadge';
import { useAccent } from '@/lib/skyTone';
import { colors } from '@/theme';

const BAR_PADDING_X = 6; // TabBar의 좌우 여백
const ICON_TOP = 12; // TabBar의 맨 위 여백 + 칸 여백

// 탭 막대 위에 그룹 아이콘 배지를 얹음 — 공용 TabBar가 tabBarBadge를 안 그려서 여기서 아이콘 오른쪽 위에 붙임
function TabBarWithBadge(props: BottomTabBarProps) {
  const accent = useAccent();
  const [width, setWidth] = useState(0);
  const index = props.state.routes.findIndex((r) => r.name === 'group');
  const value = index >= 0 ? props.descriptors[props.state.routes[index].key]?.options.tabBarBadge : undefined;
  const slot = (width - BAR_PADDING_X * 2) / props.state.routes.length;
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <TabBar {...props} />
      {value != null && width > 0 ? (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={[styles.badge, { backgroundColor: accent, left: BAR_PADDING_X + slot * index + slot / 2 + 6, top: ICON_TOP - 6 }]}
        >
          <Text variant="caption" tone="inverse" weight={700} style={styles.badgeText}>
            {value}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// 아래 탭 4개 — 홈 · 알람 · 그룹 · AI, 그림은 TabBar의 ICONS (D110 — 목업의 04 기록은 홈 맨 아래로, 알람 목록이 2번 탭)
// 그룹 탭 배지 = 받은 친구 요청 + 그룹 초대 수
export default function TabsLayout() {
  const social = useSocialBadge();
  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
      tabBar={(props) => <TabBarWithBadge {...props} />}
    >
      <Tabs.Screen name="index" options={{ title: '홈' }} />
      <Tabs.Screen name="alarms" options={{ title: '알람' }} />
      <Tabs.Screen name="group" options={{ title: '그룹', tabBarBadge: social > 0 ? social : undefined }} />
      <Tabs.Screen name="ai" options={{ title: 'AI' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  badgeText: { lineHeight: 14 },
});
