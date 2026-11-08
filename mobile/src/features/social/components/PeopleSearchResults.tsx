import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, Text } from '@/components/ui';
import { relationButton, searchNotice } from '../searchView';
import type { PeopleSearch, Person } from '../types';
import { PersonRow } from './PersonRow';

type Props = {
  search: PeopleSearch;
  busyId: string | null; // 요청 · 수락 처리 중인 사람 — 그 버튼에만 돌아가는 표시
  onRequest: (p: Person) => void;
  onAccept: (p: Person) => void;
  onInvite: () => void;
};

// F01 검색 결과 — 문구(못 찾음 · 제한 · 내 아이디) + 사람 줄(닉네임 · @아이디 + 관계대로 버튼). 동명이인은 @아이디로 구분 (2-29)
export function PeopleSearchResults({ search, busyId, onRequest, onAccept, onInvite }: Props) {
  const notice = searchNotice(search);
  return (
    <View style={styles.wrap}>
      {notice ? (
        <Card variant="dash">
          <Text variant="bodyStrong" accessibilityLiveRegion="polite">
            {notice.text}
          </Text>
          {notice.invite ? (
            <View style={styles.invite}>
              <Text variant="note" tone="sub">
                아직 앱을 안 쓰는 친구라면 카톡으로 초대해 보세요.
              </Text>
              <Button small variant="ghost" label="카톡으로 초대" onPress={onInvite} />
            </View>
          ) : null}
        </Card>
      ) : null}
      {search.rows.length ? (
        <Card>
          {search.rows.map(({ person: p, relation, via }, i) => {
            const button = relationButton(relation);
            return (
              <PersonRow
                key={p.id}
                first={i === 0}
                icon={<Avatar initial={p.initial} />}
                title={p.name}
                sub={[p.handle, via === 'GROUP' ? '같은 그룹' : null].filter(Boolean).join(' · ') || undefined}
                right={
                  button.action === 'none' ? (
                    <Text variant="label" tone="sub" weight={600}>
                      {button.label}
                    </Text>
                  ) : (
                    <Button
                      small
                      variant={button.action === 'accept' ? 'primary' : 'ghost'}
                      label={button.label}
                      loading={busyId === p.id}
                      disabled={busyId !== null && busyId !== p.id}
                      onPress={() => (button.action === 'accept' ? onAccept(p) : onRequest(p))}
                    />
                  )
                }
              />
            );
          })}
        </Card>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginBottom: 12 },
  invite: { marginTop: 8, gap: 8, alignItems: 'flex-start' },
});
