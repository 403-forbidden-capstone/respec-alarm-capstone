import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, type ReactNode } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';

import { AuthProvider, useAuth } from '@/features/auth/AuthProvider';
import { colors, fontFiles } from '@/theme';

// 글꼴 · 로그인 상태를 다 읽을 때까지 시작 화면을 유지함
SplashScreen.preventAutoHideAsync();

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
      </PhoneFrame>
    </AuthProvider>
  );
}

// 로그인 전에는 login만, 아이디를 정하기 전에는 onboarding만, 그 뒤에는 탭 · 앱 화면만 열림
// Supabase가 연결 안 된 목업 모드(enabled=false)는 로그인 없이 바로 탭
// dev/* · auth/callback은 어느 쪽에서도 열림. 앱 화면을 새로 만들면 첫 번째 Protected 안에 넣음
function RootStack() {
  const { session, loading, enabled, needsOnboarding } = useAuth();

  useEffect(() => {
    if (!loading) SplashScreen.hideAsync();
  }, [loading]);

  if (loading) return null;
  const needsLogin = enabled && !session;
  const ready = !needsLogin && !needsOnboarding;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={ready}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="settings" />
      </Stack.Protected>
      <Stack.Protected guard={needsLogin}>
        <Stack.Screen name="login" />
      </Stack.Protected>
      <Stack.Protected guard={needsOnboarding}>
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
