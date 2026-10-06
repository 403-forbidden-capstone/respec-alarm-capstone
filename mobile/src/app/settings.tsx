import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, KeyValueRow, Screen, Text, TopBar } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { signOut } from '@/lib/auth';

const PROVIDER_NAME: Record<string, string> = { kakao: '카카오', google: 'Google' };

// 설정 — 지금은 계정 정보 · 로그아웃만. 준비시간 · 알람 선호 · 권한은 온보딩과 함께 추가
export default function SettingsScreen() {
  const { session, enabled } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const user = session?.user;
  const provider = (user?.app_metadata?.provider as string | undefined) ?? '';

  return (
    <Screen>
      <TopBar onBack={router.canGoBack() ? router.back : undefined} />
      <Text variant="title">설정</Text>

      <Card style={styles.card}>
        <KeyValueRow first label="로그인" value={enabled ? (PROVIDER_NAME[provider] ?? (provider || '-')) : '목업 모드'} />
        <KeyValueRow label="이메일" value={user?.email ?? '-'} />
      </Card>

      {enabled && user ? (
        <View style={styles.stack}>
          <Button
            label="로그아웃"
            variant="ghost"
            onPress={() => signOut().catch((e) => setError(e instanceof Error ? e.message : '로그아웃하지 못했어요'))}
          />
          {error ? (
            <Text variant="small" tone="warn">
              {error}
            </Text>
          ) : null}
        </View>
      ) : (
        <Text variant="small">Supabase가 연결되면 로그인 정보가 여기에 보여요.</Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 16 },
  stack: { gap: 8 },
});
