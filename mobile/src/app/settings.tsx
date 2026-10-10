import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, KeyValueRow, Screen, SectionHeader, Text, TopBar } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { DataModeToggle } from '@/features/auth/DataModeToggle';
import type { TransportType } from '@/features/profile/types';
import { signOut } from '@/lib/auth';
import { userMessage } from '@/lib/errors';
import { canUseRealData } from '@/lib/mode';

const PROVIDER_NAME: Record<string, string> = { kakao: '카카오', google: 'Google' };
const TRANSPORT_NAME: Record<TransportType, string> = {
  TRANSIT: '대중교통',
  BUS: '버스',
  SUBWAY: '지하철',
  CAR: '자차',
  WALK: '도보',
};

// 설정 — 계정 · 아침 준비 기본값 · 로그아웃 · 개발(데이터 모드). 값 바꾸기는 화면을 옮길 때(#30~) 붙임
export default function SettingsScreen() {
  const { session, profile, enabled } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const user = session?.user;
  const provider = (user?.app_metadata?.provider as string | undefined) ?? '';

  return (
    <Screen>
      <TopBar onBack={router.canGoBack() ? router.back : undefined} />
      <Text variant="title">설정</Text>

      <SectionHeader title="계정" />
      <Card>
        <KeyValueRow first label="로그인" value={enabled ? (PROVIDER_NAME[provider] ?? (provider || '-')) : '가짜 데이터 모드'} />
        <KeyValueRow label="닉네임" value={profile?.nickname ?? '-'} />
        <KeyValueRow label="아이디" value={profile?.handle ? `@${profile.handle}` : '-'} />
      </Card>

      {profile ? (
        <>
          <SectionHeader title="아침 준비 기본값" />
          <Card>
            <KeyValueRow first label="준비 시간" value={`${profile.default_prepare_minutes}분`} />
            <KeyValueRow label="여유 시간" value={`${profile.default_buffer_minutes}분`} />
            <KeyValueRow label="이동 수단" value={TRANSPORT_NAME[profile.default_transport]} />
            <KeyValueRow label="출발지" value={profile.home_name ?? '-'} />
          </Card>
        </>
      ) : null}

      {enabled && user ? (
        <View style={styles.stack}>
          <Button
            label="로그아웃"
            variant="ghost"
            onPress={() => signOut().catch((e) => setError(userMessage(e, '로그아웃하지 못했어요')))}
          />
          {error ? (
            <Text variant="small" tone="warn">
              {error}
            </Text>
          ) : null}
        </View>
      ) : (
        <Text variant="small">
          {canUseRealData ? '실데이터 모드로 바꾸면 로그인 정보가 여기에 보여요.' : 'Supabase가 연결되면 로그인 정보가 여기에 보여요.'}
        </Text>
      )}

      <SectionHeader title="개발" right={canUseRealData ? undefined : 'Supabase 연결 안 됨'} />
      <DataModeToggle />
      <Text variant="caption" style={styles.note}>
        가짜 데이터는 목업 시나리오(5월 22일)로 로그인 없이 돌아요. 화면 목록은 /dev/screens
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 8, marginTop: 16 },
  note: { marginTop: 4, marginHorizontal: 4 },
});
