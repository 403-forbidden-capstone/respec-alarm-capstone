import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, Chip, EmptyState, Text } from '@/components/ui';

import { relationAction } from '../draft';
import type { HandleSearchResult as SearchHit, Person } from '../types';

type Props = {
  result: SearchHit | null; // 못 찾았으면 null
  busy?: boolean; // 요청 · 수락을 보내는 중
  onRequest: (person: Person) => void; // 관계가 NONE일 때 [친구 요청]
  onAccept: (person: Person) => void; // 관계가 RECEIVED일 때 [수락]
};

// 친구 추가 시트의 "아이디 검색" 칸 (U01) — 찾은 사람 한 명과 나와의 관계에 맞는 버튼 하나
export function HandleSearchResult({ result, busy, onRequest, onAccept }: Props) {
  if (!result) return <EmptyState title="그 아이디를 찾지 못했어요" body="아이디를 한 번 더 확인해 주세요." />;

  const { person, relation } = result;
  const { label, action } = relationAction(relation);
  return (
    <Card>
      <View style={styles.row}>
        <Avatar initial={person.initial} />
        <View style={styles.grow}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {person.name}
          </Text>
          {person.handle ? (
            <Text variant="small" tone="sub">
              {person.handle}
            </Text>
          ) : null}
        </View>
        {action ? (
          <Button small label={label} loading={busy} onPress={() => (action === 'request' ? onRequest(person) : onAccept(person))} />
        ) : (
          <Chip label={label} variant="fill" />
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0 },
});
