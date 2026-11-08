import { StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';

import type { GroupInvite } from '../types';
import { GroupIcon } from './GroupIcon';

type Props = {
  invite: GroupInvite;
  working: boolean; // 이 카드를 처리 중
  disabled: boolean; // 다른 카드를 처리 중이라 못 누름
  onAccept: () => void;
  onDecline: () => void;
};

// G01 그룹 탭 위 받은 초대 카드 — 그룹 이름 · 인원 · 초대한 사람까지만 (코드 · 멤버 목록은 수락 뒤, 5-29)
export function GroupInviteCard({ invite, working, disabled, onAccept, onDecline }: Props) {
  const by = invite.invitedByName ? ` · ${invite.invitedByName}님이 초대했어요` : '';
  return (
    <Card>
      <View style={styles.row}>
        <GroupIcon label={invite.initial} />
        <View style={styles.grow}>
          <Text variant="big" numberOfLines={1}>
            {invite.name}
          </Text>
          <Text variant="small" tone="sub" numberOfLines={2}>
            {`${invite.memberCount}명${by}`}
          </Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Button variant="plain" label="거절" small disabled={disabled || working} onPress={onDecline} />
        <Button label="참여" small loading={working} disabled={disabled} onPress={onAccept} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 10 },
});
