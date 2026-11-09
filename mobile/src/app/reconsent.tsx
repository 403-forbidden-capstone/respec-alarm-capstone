import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Screen, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { consentBlocked, consentItems, PRIVACY_VERSION } from '@/features/onboarding/consent';
import { ConsentStep } from '@/features/onboarding/views/ConsentStep';
import { saveProfileFields } from '@/features/profile/api';
import { TIMETABLE_PATHS } from '@/lib/flags';
import { keepWords } from '@/lib/format';
import { useAction } from '@/lib/useAction';

// 개인정보 안내 다시 동의 (친구 13-바 · 13-14) — 안내 판이 올라갔는데 내가 동의한 판이 낮으면 앱을 열 때 이 화면만 먼저 뜸
//   온보딩을 끝낸 계정만 옴(그 전 계정은 온보딩의 동의 단계가 받음). 만 14세 이상 확인 포함, 동의하면 판 · 시각을 저장하고 프로필을 다시 읽어 판정이 꺼지면 이 화면은 사라지고 홈
//   거절하는 길은 없음 — 동의하지 않으면 앱을 쓸 수 없음(온보딩 동의와 같은 규칙). 저장이 실패하면 토스트 후 다시 누르면 됨
export default function ReconsentScreen() {
  const { session, refreshProfile } = useAuth();
  const { busy, run } = useAction();
  const [ageChecked, setAgeChecked] = useState(false);
  const userId = session?.user.id ?? null;

  const agree = () =>
    run(async () => {
      if (!userId) return;
      await saveProfileFields(userId, { privacy_agreed_at: new Date().toISOString(), privacy_version: PRIVACY_VERSION });
      await refreshProfile(); // 판정이 꺼지면 루트가 이 화면을 걷고 홈으로
    }, '저장하지 못했어요');

  return (
    <Screen footer={<Button label="동의하고 계속" onPress={agree} disabled={consentBlocked(false, ageChecked)} loading={busy} />}>
      <Text variant="title" style={styles.title}>
        {keepWords('개인정보 안내가 바뀌었어요')}
      </Text>
      <Text variant="lead" tone="sub" style={styles.lead}>
        {keepWords('바뀐 내용을 읽고 동의하면 이어서 쓸 수 있어요')}
      </Text>
      <View>
        <ConsentStep items={consentItems(TIMETABLE_PATHS)} ageChecked={ageChecked} onAgeChange={setAgeChecked} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 24 },
  lead: { marginTop: 8, marginBottom: 16 },
});
