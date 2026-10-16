import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Screen, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { signInWithProvider, type OAuthProvider } from '@/lib/auth';
import { userMessage } from '@/lib/errors';
import { canUseRealData } from '@/lib/mode';
import { colors, radius, size } from '@/theme';

// 로그인 — 카카오 · 구글. 로그인되면 루트 레이아웃이 알아서 탭으로 보냄
export default function LoginScreen() {
  const { enabled } = useAuth();
  const [busy, setBusy] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function login(provider: OAuthProvider) {
    // 가짜 데이터 모드에서는 화면만 열어 봄 (주소로 연 경우) — 로그인해도 가짜 프로필이 쓰이므로 막음
    if (!enabled) {
      setError(
        canUseRealData
          ? '가짜 데이터 모드예요. 로그인하려면 /dev/screens나 설정에서 실데이터로 바꿔 주세요'
          : '이 빌드에서는 로그인할 수 없어요. 가짜 데이터로만 돌아요',
      );
      return;
    }
    setBusy(provider);
    setError(null);
    try {
      await signInWithProvider(provider);
    } catch (e) {
      setError(userMessage(e, '로그인하지 못했어요'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen
      scroll={false}
      footer={
        <View style={styles.buttons}>
          <Pressable
            onPress={() => login('kakao')}
            disabled={busy !== null}
            accessibilityRole="button"
            style={({ pressed }) => [styles.button, styles.kakao, (pressed || busy === 'kakao') && styles.pressed]}
          >
            <Text variant="button" style={{ color: colors.kakaoText }}>
              {busy === 'kakao' ? '카카오로 로그인 중…' : '카카오로 시작하기'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => login('google')}
            disabled={busy !== null}
            accessibilityRole="button"
            style={({ pressed }) => [styles.button, styles.google, (pressed || busy === 'google') && styles.pressed]}
          >
            <Text variant="button">{busy === 'google' ? 'Google로 로그인 중…' : 'Google로 시작하기'}</Text>
          </Pressable>
          {error ? (
            <Text variant="small" tone="warn" align="center">
              {error}
            </Text>
          ) : null}
        </View>
      }
    >
      <View style={styles.hero}>
        <Text variant="screenId">Re:Spec Alarm</Text>
        <Text variant="title">혼자 깨는 알람에서,{'\n'}함께 약속을 지키는 알람으로</Text>
        <Text variant="lead">약속 시간에 맞춰 일어날 시간을 계산하고, 친구와 기상을 확인해요.</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { flex: 1, justifyContent: 'center', gap: 8 },
  buttons: { gap: 10, paddingBottom: 8 },
  button: { height: size.button, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' },
  kakao: { backgroundColor: colors.kakao },
  google: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  pressed: { opacity: 0.75 },
});
