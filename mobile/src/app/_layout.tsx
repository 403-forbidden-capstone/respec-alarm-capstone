import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';

import { colors, fontFiles } from '@/theme';

// 글꼴을 다 읽을 때까지 시작 화면을 유지함
SplashScreen.preventAutoHideAsync();

// 웹 데모를 PC 브라우저로 열면 휴대폰 크기 화면으로 가운데에 보여 줌
const PHONE = { width: 390, height: 844 };

export default function RootLayout() {
  const [loaded, error] = useFonts(fontFiles);
  const { width, height } = useWindowDimensions();

  useEffect(() => {
    if (loaded || error) SplashScreen.hideAsync();
  }, [loaded, error]);

  // 글꼴을 못 읽어도 시스템 글꼴로 계속 진행함
  if (!loaded && !error) return null;

  const stack = (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
    </>
  );

  const wide = Platform.OS === 'web' && width > PHONE.width + 80;
  if (!wide) return stack;

  return (
    <View style={styles.page}>
      <View style={[styles.phone, { height: Math.min(PHONE.height, height - 48) }]}>{stack}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E6E9E4' },
  phone: {
    width: PHONE.width,
    overflow: 'hidden',
    borderRadius: 52,
    borderWidth: 12,
    borderColor: '#1A1B1A',
    backgroundColor: colors.bg,
  },
});
