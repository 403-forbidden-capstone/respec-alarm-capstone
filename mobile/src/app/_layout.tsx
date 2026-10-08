import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, type ReactNode } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';

import { SheetHost, ToastHost } from '@/components/ui';
import { AuthProvider, useAuth } from '@/features/auth/AuthProvider';
import { ProfileRetryScreen } from '@/features/auth/ProfileRetryScreen';
import { colors, fontFiles } from '@/theme';

// 글꼴 · 로그인 상태를 다 읽을 때까지 시작 화면을 유지함
SplashScreen.preventAutoHideAsync();

// 웹 로그인 팝업이 /auth/callback으로 돌아오면 팝업 주소(토큰 포함)를 원래 창에 넘기고 팝업이 닫힘
// 팝업에서 확실히 실행되는 모듈은 이 루트 레이아웃뿐이라 여기서 부름 (화면 파일은 열릴 때만 읽히고, 폰에서는 아무 일도 안 함)
WebBrowser.maybeCompleteAuthSession();

// 웹 데모를 PC 브라우저로 열면 휴대폰 크기 화면으로 가운데에 보여 줌
const PHONE = { width: 390, height: 844 };

export default function RootLayout() {
  const [loaded, error] = useFonts(fontFiles);

  // 글꼴을 못 읽어도 시스템 글꼴로 계속 진행함
  if (!loaded && !error) return null;

  return (
    <AuthProvider>
      <PhoneFrame>
        <StatusBar style="dark" />
        <RootStack />
        <SheetHost />
        <ToastHost />
      </PhoneFrame>
    </AuthProvider>
  );
}

// 로그인 전에는 login만, 아이디를 정하기 전에는 onboarding만, 그 뒤에는 탭 · 앱 화면만 열림
// 로그인은 됐는데 프로필을 못 읽었으면(오프라인 등) 온보딩 대신 다시 시도 화면
// 가짜 데이터 모드(enabled=false, lib/mode.ts)는 로그인 없이 바로 탭. login · onboarding은 /dev/screens에서 열어 볼 수만 있음
// dev/* · auth/callback은 어느 쪽에서도 열림. 앱 화면을 새로 만들면 첫 번째 Protected 안에 넣음
function RootStack() {
  const { session, loading, enabled, needsOnboarding, profileError, refreshProfile } = useAuth();

  useEffect(() => {
    if (!loading) SplashScreen.hideAsync();
  }, [loading]);

  if (loading) return null;
  if (profileError) return <ProfileRetryScreen message={profileError} onRetry={refreshProfile} />;
  const needsLogin = enabled && !session;
  const ready = !needsLogin && !needsOnboarding;
  const mock = !enabled;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={ready}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="settings" />
        {/* 목업 화면 (M1) — 화면 번호 · 데이터는 docs/screen-data-map.md, 한눈에 보기는 /dev/screens */}
        <Stack.Screen name="alarms" />
        <Stack.Screen name="alarm/[id]" />
        <Stack.Screen name="schedule/new" />
        <Stack.Screen name="wake" />
        <Stack.Screen name="ring" options={{ animation: 'fade' }} />
        <Stack.Screen name="friends/[id]/index" />
        <Stack.Screen name="friends/[id]/alarms" />
        <Stack.Screen name="permissions" />
        <Stack.Screen name="groups/[id]/index" />
        <Stack.Screen name="groups/[id]/members/[userId]" />
        <Stack.Screen name="suggestion/[id]" />
        <Stack.Screen name="journal/[date]" />
        <Stack.Screen name="routine/[id]" />
      </Stack.Protected>
      <Stack.Protected guard={needsLogin || mock}>
        <Stack.Screen name="login" />
      </Stack.Protected>
      <Stack.Protected guard={needsOnboarding || mock}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
    </Stack>
  );
}

function PhoneFrame({ children }: { children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  const wide = Platform.OS === 'web' && width > PHONE.width + 80;
  if (!wide) return <>{children}</>;

  return (
    <View style={styles.page}>
      <View style={[styles.phone, { height: Math.min(PHONE.height, height - 48) }]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.stage },
  phone: {
    width: PHONE.width,
    overflow: 'hidden',
    borderRadius: 52,
    borderWidth: 12,
    borderColor: colors.device,
    backgroundColor: colors.bg,
  },
});
