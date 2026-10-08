import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Field, Screen, SectionHeader, Segmented, Stepper, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { isHandleTaken, saveOnboarding } from '@/features/profile/api';
import { HANDLE_PATTERN, type TransportType } from '@/features/profile/types';

const TRANSPORTS = [
  ['TRANSIT', '대중교통'],
  ['CAR', '자차'],
  ['WALK', '도보'],
] as const;

// 처음 설정 — 아이디 · 아침 준비 기본값 · 집. 저장하면 루트 레이아웃이 탭으로 보냄
export default function OnboardingScreen() {
  const { session, profile, refreshProfile } = useAuth();
  const [nickname, setNickname] = useState(profile?.nickname ?? '');
  const [handle, setHandle] = useState('');
  const [prepare, setPrepare] = useState(profile?.default_prepare_minutes ?? 60);
  const [buffer, setBuffer] = useState(profile?.default_buffer_minutes ?? 10);
  const [transport, setTransport] = useState<TransportType>(
    profile?.default_transport === 'CAR' || profile?.default_transport === 'WALK' ? profile.default_transport : 'TRANSIT',
  );
  const [home, setHome] = useState(profile?.home_name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanHandle = handle.trim().replace(/^@/, '').toLowerCase();
  const handleOk = HANDLE_PATTERN.test(cleanHandle);
  const canSave = handleOk && nickname.trim().length > 0 && !saving;

  async function save() {
    if (!session) {
      setError('가짜 데이터 모드라 저장하지 않아요'); // /dev/screens에서 화면만 열어 본 경우
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (await isHandleTaken(cleanHandle, session.user.id)) {
        setError('이미 쓰는 아이디예요');
        return;
      }
      await saveOnboarding(session.user.id, {
        nickname: nickname.trim(),
        handle: cleanHandle,
        home_name: home.trim() || null,
        default_prepare_minutes: prepare,
        default_buffer_minutes: buffer,
        default_transport: transport,
      });
      await refreshProfile();
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장하지 못했어요');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen footer={<Button label={saving ? '저장하는 중…' : '시작하기'} onPress={save} disabled={!canSave} />}>
      <Text variant="title" style={styles.title}>
        처음 설정
      </Text>
      <Text variant="lead">친구가 찾을 아이디와 아침 준비 기본값을 정해요. 나중에 설정에서 바꿀 수 있어요.</Text>

      <SectionHeader title="프로필" />
      <Card>
        <Field first label="닉네임" value={nickname} onChangeText={setNickname} maxLength={30} placeholder="이름" />
        <Field
          label="아이디"
          value={handle}
          onChangeText={setHandle}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={21}
          placeholder="respec_kim"
        />
      </Card>
      <Text variant="caption" tone={handle && !handleOk ? 'warn' : 'faint'} style={styles.help}>
        영문 소문자 · 숫자 · 밑줄(_) 3~20자, @는 빼고 적어요. 친구가 @아이디로 나를 찾아요.
      </Text>

      <SectionHeader title="아침 준비" right="알람 계산의 처음 값" />
      <Card>
        <Stepper first label="준비 시간" value={prepare} onChange={setPrepare} min={10} max={180} unit="분" />
        <Stepper label="여유 시간" value={buffer} onChange={setBuffer} min={0} max={30} unit="분" />
      </Card>
      <Text variant="caption" style={styles.help}>
        기록이 쌓이면 준비 시간은 실제 준비한 시간으로 맞춰져요.
      </Text>

      <SectionHeader title="이동 수단" />
      <Segmented options={TRANSPORTS} value={transport} onChange={setTransport} />

      <SectionHeader title="집" />
      <Card>
        <Field first label="출발지" value={home} onChangeText={setHome} maxLength={200} placeholder="예: 집 · 자취방 동네" />
      </Card>
      <Text variant="caption" style={styles.help}>
        지금은 이름만 저장해요. 장소 검색이 붙으면 위치로 바꿀 수 있어요.
      </Text>

      {error ? (
        <View style={styles.error}>
          <Text variant="small" tone="warn">
            {error}
          </Text>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 16 },
  help: { marginTop: -4, marginHorizontal: 4 },
  error: { marginTop: 16 },
});
