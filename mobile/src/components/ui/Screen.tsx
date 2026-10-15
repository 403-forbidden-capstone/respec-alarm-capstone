import { useScrollToTop } from 'expo-router';
import { NavigationContext, NavigationRouteContext } from 'expo-router/react-navigation';
import { use, useRef, useState, type ReactNode, type RefObject } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, space } from '@/theme';

type Props = {
  children: ReactNode;
  scroll?: boolean; // 기본은 스크롤. 채팅처럼 직접 스크롤을 다룰 때만 끔
  footer?: ReactNode; // 화면 아래 고정 버튼 자리
  contentStyle?: ViewStyle;
  onRefresh?: () => Promise<unknown> | void; // 있으면 아래로 당겨 새로고침 (끝날 때까지 돌아가는 표시)
  avoidKeyboard?: boolean; // 키보드가 올라오면 화면을 밀어 올림 (기본 켬). 화면이 이미 직접 처리하면(채팅) 끔
  scrollRef?: RefObject<ScrollView | null>; // 화면이 직접 스크롤 위치를 옮길 때 (예: 방금 만든 카드로)
};

// iOS는 padding, Android는 height, 웹은 키보드가 화면을 덮지 않아 없음
const keyboardBehavior = Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined;

// 탭을 다시 누르면 맨 위로 — 탭 화면(내비게이션 안)에서만 붙임. 루트에 직접 그리는 화면(ProfileRetryScreen)은 내비게이션 밖이라 훅이 오류를 냄
function ScrollToTopOnTabPress({ target }: { target: RefObject<ScrollView | null> }) {
  useScrollToTop(target);
  return null;
}

// 화면 바탕 · 좌우 여백 · 안전 영역을 맞춘 화면 틀
// 아래 안전 영역(시스템 내비게이션 막대)은 늘 잡음. 키보드가 올라오면 입력칸 · 아래 고정 버튼(footer)이 키보드 위로 밀려 올라감
export function Screen({ children, scroll = true, footer, contentStyle, onRefresh, avoidKeyboard = true, scrollRef: outerRef }: Props) {
  const innerRef = useRef<ScrollView>(null);
  const scrollRef = outerRef ?? innerRef;
  const navigation = use(NavigationContext);
  const route = use(NavigationRouteContext);
  const inNavigation = navigation != null && route != null;
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    if (!onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  // 웹 미리 보기는 안전 영역을 기기 값 그대로 더해서 탭 화면 아래(탭 막대 위)에도 빈 틈이 생기므로 footer가 있을 때만 (폰은 겹친 만큼만 잡아 줌)
  const edges = Platform.OS === 'web' && !footer ? (['top'] as const) : (['top', 'bottom'] as const);

  return (
    <SafeAreaView style={styles.safe} edges={edges}>
      <KeyboardAvoidingView style={styles.fill} behavior={avoidKeyboard ? keyboardBehavior : undefined} enabled={avoidKeyboard}>
        {scroll ? (
          <ScrollView
            ref={scrollRef}
            style={styles.fill}
            contentContainerStyle={[styles.content, contentStyle]}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.sub} colors={[colors.ink]} /> : undefined}
          >
            {children}
          </ScrollView>
        ) : (
          <View style={[styles.fill, styles.content, contentStyle]}>{children}</View>
        )}
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </KeyboardAvoidingView>
      {scroll && inNavigation ? <ScrollToTopOnTabPress target={scrollRef} /> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  fill: { flex: 1 },
  content: { paddingHorizontal: space.screenX, paddingBottom: 28 },
  footer: { paddingHorizontal: space.screenX, paddingTop: 8, paddingBottom: 12, backgroundColor: colors.bg },
});
