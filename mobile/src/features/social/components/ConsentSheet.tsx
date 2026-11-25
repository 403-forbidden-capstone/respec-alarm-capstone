import { StyleSheet, View } from 'react-native';

import { Button, Sheet, Text } from '@/components/ui';

import { CONSENT_TEXT, consentTitle } from '../groupTexts';

type Props = {
  visible: boolean;
  busy?: boolean;
  groupName?: string | null; // 있으면 제목에 그룹 이름 — 받은 초대가 여럿일 때 어느 그룹인지 (D-10)
  onChoose: (share: boolean) => void; // [공유] = true, [나중에] = false
  onClose: () => void; // 고르지 않고 닫음
};

// 그룹에 들어갈 때(코드 참여 · 초대 수락 · 만든 직후) 한 번 묻는 기상 상태 공유 동의 시트 (친구 5장, 5-03 · 5-09 · 5-10)
//   시트 내용은 화면 밖(루트)에서 그려져 값 · 콜백만 받음
export function ConsentSheet({ visible, busy, groupName, onChoose, onClose }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title={consentTitle(groupName)}>
      <View style={styles.stack}>
        <Text variant="small" tone="sub">
          {CONSENT_TEXT.body}
        </Text>
        <Button label={CONSENT_TEXT.share} onPress={() => onChoose(true)} loading={busy} />
        <Button variant="ghost" label={CONSENT_TEXT.later} onPress={() => onChoose(false)} disabled={busy} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 8, marginTop: 4 },
});
