import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Screen, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '@/features/auth/devLogin';
import { signInWithEmail, signInWithProvider, type OAuthProvider } from '@/lib/auth';
import { userMessage } from '@/lib/errors';
import { canUseRealData, devLoginVisible } from '@/lib/mode';
import { colors, radius, size } from '@/theme';

// 로그인 — 카카오 · 구글. 로그인되면 루트 레이아웃이 알아서 탭으로 보냄
export default function LoginScreen() {
  const { enabled } = useAuth();
  const [busy, setBusy] = useState<OAuthProvider | 'demo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [devOpen, setDevOpen] = useState(false); // 알람 테스트 · 개발 메뉴 접힌 칸

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

  // 데모 계정 바로 로그인 — 개발자용 배포 APK · 웹 · 폰 개발용 (lib/modePolicy showDevLogin). 비밀번호가 빌드에 없으면 개발 메뉴 입력 칸으로
  async function demoLogin() {
    if (!DEMO_PASSWORD) {
      router.push('/dev/screens');
      return;
    }
    setBusy('demo');
    setError(null);
    try {
      await signInWithEmail(DEMO_ACCOUNTS[0], DEMO_PASSWORD);
    } catch (e) {
      setError(userMessage(e, '데모 계정으로 로그인하지 못했어요'));
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
          {/* 알람 테스트 바로 가기 — 로그인 전에도 알람이 울리는지 시험해 볼 수 있게 (/dev/alarm-test, 루트 레이아웃 가드 밖). 출시용 APK에도 있음 (10/18 지형님, #177)
              첫 화면에서는 누를 것을 줄이려 접힌 칸 안에 둠 (UX A-08). D16(출시 빌드에서 개발 메뉴를 보일지)이 정해지면 이 칸째 숨길 대상 */}
          {devLoginVisible && enabled ? (
            // 데모(시드) 계정 로그인 — 웹 · 폰 개발용 · 개발자용 배포 APK에서만 (실배포 APK는 안 보임). 다른 데모 계정은 개발 메뉴 입력 칸에서
            <Button
              variant="ghost"
              label={busy === 'demo' ? '데모 계정으로 로그인 중…' : DEMO_PASSWORD ? `데모 계정으로 로그인 (${DEMO_ACCOUNTS[0].split('@')[0]})` : '데모 계정으로 로그인'}
              disabled={busy !== null}
              onPress={demoLogin}
            />
          ) : null}
          <Button
            variant="plain"
            small
            label={devOpen ? '접기' : devLoginVisible && enabled ? '다른 데모 계정 · 개발 메뉴' : '알람 테스트'}
            onPress={() => setDevOpen((v) => !v)}
          />
          {devOpen ? (
            <>
              <Button variant="plain" small label="알람 테스트" onPress={() => router.push('/dev/alarm-test')} />
              {devLoginVisible && enabled ? <Button variant="plain" small label="개발 메뉴" onPress={() => router.push('/dev/screens')} /> : null}
            </>
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
