import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Screen, Text } from '@/components/ui';
import { signOut } from '@/lib/auth';
import { userMessage } from '@/lib/errors';

type Props = {
  message: string; // 못 읽은 이유 (useAuth().profileError) — UserError일 때만, 아니면 ''
  onRetry: () => Promise<void>; // 다시 읽기 (useAuth().refreshProfile) — 실패하면 던짐
};

// 로그인은 됐는데 프로필을 못 읽었을 때(오프라인 등) 루트 레이아웃이 보여 줌
// 온보딩으로 보내면 저장해 둔 기본값을 덮어쓰므로, 다시 읽거나 로그아웃할 때까지 기다림
export function ProfileRetryScreen({ message, onRetry }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(userMessage(e, '다시 시도하지 못했어요'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      scroll={false}
      footer={
        <View style={styles.actions}>
          <Button label={busy ? '불러오는 중…' : '다시 시도'} onPress={() => run(onRetry)} disabled={busy} />
          <Button label="로그아웃" variant="ghost" onPress={() => run(signOut)} disabled={busy} />
          {error ? (
            <Text variant="small" tone="warn" align="center">
              {error}
            </Text>
          ) : null}
        </View>
      }
    >
      <View style={styles.center}>
        <Text variant="title">내 정보를 불러오지 못했어요</Text>
        <Text variant="lead">연결을 확인한 뒤 다시 시도해 주세요.</Text>
        {message ? <Text variant="caption">{message}</Text> : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', gap: 8 },
  actions: { gap: 10, paddingBottom: 8 },
});
