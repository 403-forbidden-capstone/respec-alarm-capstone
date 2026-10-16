import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Field, SectionHeader, Text, toast } from '@/components/ui';
import { signInWithEmail } from '@/lib/auth';
import { useAction } from '@/lib/useAction';

// 개발 메뉴(/dev/screens) 맨 위의 이메일 로그인 — 시드 계정(supabase/seed, 이메일 demo-me@example.com 등)으로 카카오 · 구글 없이 실데이터 모드를 시험할 때
// 웹 · 폰 개발용에서만 보임 (lib/modePolicy.ts showDevLogin). 비밀번호는 시드 때 정한 SEED_PASSWORD를 입력 칸에 넣음 — 코드에 적지 않음
// 로그인되면 루트 레이아웃이 알아서 앱 화면을 열어 줌 (여기서는 화면을 옮기지 않음)
export function DevLoginForm() {
  const [email, setEmail] = useState('demo-me@example.com');
  const [password, setPassword] = useState('');
  const { busy, run } = useAction();

  function login() {
    return run(async () => {
      await signInWithEmail(email, password);
      setPassword('');
      toast('로그인했어요');
    }, '로그인하지 못했어요');
  }

  return (
    <View>
      <SectionHeader title="개발용 이메일 로그인" right="시드 계정" />
      <Card>
        <Field first label="이메일" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username" />
        <Field label="비밀번호" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder="시드 비밀번호" textContentType="password" onSubmitEditing={login} />
      </Card>
      <View style={styles.actions}>
        <Button small label="이메일로 로그인" loading={busy} disabled={!email.trim() || !password} onPress={login} />
      </View>
      <Text variant="caption" style={styles.note}>
        시드 계정: demo-me · demo-suyeon · demo-jihyeong · demo-junseong @example.com (비밀번호는 시드를 넣을 때 정한 SEED_PASSWORD, supabase/README.md)
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', marginTop: 8 },
  note: { marginTop: 4, marginHorizontal: 4 },
});
