import { StyleSheet, View } from 'react-native';

import { Button, Loading, Sheet, Text } from '@/components/ui';
import { colors } from '@/theme';

import type { GroupCode } from '../types';

type Props = {
  visible: boolean;
  groupName: string;
  code: GroupCode | null; // 읽는 중이면 null
  expiresLabel: string | null; // '11/15까지'
  busy?: boolean;
  onShare: () => void;
  onNewCode: () => void;
  onClose: () => void;
};

// 새 코드 시트 — 코드 + 만료일 + 공유 (친구 5장). 열 때 서버가 만료된 코드를 새 코드 + 7일로 바꿔 줌 (5-49)
export function GroupCodeSheet({ visible, groupName, code, expiresLabel, busy, onShare, onNewCode, onClose }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title="그룹 초대 코드">
      {code ? (
        <View style={styles.stack}>
          <Text variant="small" tone="sub">
            이 코드를 보내면 {groupName}에 참여할 수 있어요.
          </Text>
          <View style={styles.codeBox}>
            <Text variant="stat" selectable accessibilityLabel={`초대 코드 ${code.code}`}>
              {code.code}
            </Text>
            {expiresLabel ? (
              <Text variant="caption" tone="sub" style={styles.expires}>
                {expiresLabel}
              </Text>
            ) : null}
          </View>
          <Button label="공유하기" onPress={onShare} disabled={busy} />
          <Button variant="ghost" label="새 코드 만들기" onPress={onNewCode} loading={busy} />
          <Text variant="caption" align="center">
            새 코드를 만들면 옛 코드는 바로 못 써요.
          </Text>
        </View>
      ) : (
        <Loading />
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 8, marginTop: 4 },
  codeBox: { alignItems: 'center', marginVertical: 8, paddingVertical: 18, borderRadius: 16, backgroundColor: colors.chip },
  expires: { marginTop: 6 },
});
