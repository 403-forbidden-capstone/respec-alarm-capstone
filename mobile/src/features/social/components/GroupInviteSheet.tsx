import { StyleSheet, View } from 'react-native';

import { Avatar, Button, EmptyState, Loading, Sheet, Text } from '@/components/ui';

import type { InvitableFriend } from '../types';

type Props = {
  visible: boolean;
  groupName: string;
  friends: InvitableFriend[] | null; // 읽는 중이면 null
  invitingId: string | null; // 초대 보내는 중인 친구
  onInvite: (friend: InvitableFriend) => void;
  onCode: () => void; // 코드로 초대하려면 코드 시트로
  onClose: () => void;
};

// G02 [+ 초대] — 내 친구 중에서 고르는 직접 초대 (멤버 누구나, 5-27). 이미 멤버 · 초대 중은 표시만, 코드로 보내는 길도 같이
export function GroupInviteSheet({ visible, groupName, friends, invitingId, onInvite, onCode, onClose }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title={`${groupName}에 초대`}>
      <View style={styles.stack}>
        {friends === null ? (
          <Loading />
        ) : friends.length === 0 ? (
          <EmptyState title="초대할 친구가 없어요" body="친구를 만든 뒤 초대하거나, 코드를 보내 보세요." />
        ) : (
          friends.map((f) => (
            <View key={f.person.id} style={styles.row}>
              <Avatar initial={f.person.initial} />
              <View style={styles.grow}>
                <Text variant="body" numberOfLines={1}>
                  {f.person.name}
                </Text>
                {f.person.handle ? (
                  <Text variant="caption" tone="sub" numberOfLines={1}>
                    {f.person.handle}
                  </Text>
                ) : null}
              </View>
              {f.state === 'MEMBER' ? (
                <Text variant="small" tone="faint">
                  참여 중
                </Text>
              ) : f.state === 'INVITED' ? (
                <Text variant="small" tone="faint">
                  초대 중
                </Text>
              ) : (
                <Button label="초대" small loading={invitingId === f.person.id} disabled={invitingId !== null && invitingId !== f.person.id} onPress={() => onInvite(f)} />
              )}
            </View>
          ))
        )}
        <Button variant="ghost" label="코드로 초대하기" onPress={onCode} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 8, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 },
  grow: { flex: 1, minWidth: 0 },
});
