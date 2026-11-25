import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, confirm, EmptyState, LoadError, Loading, Screen, Text, toast, TopBar } from '@/components/ui';
import { listBlocks, unblockUser } from '@/features/social/api';
import { UNBLOCK_TEXT } from '@/features/social/blockTexts';
import { Note } from '@/features/social/components/Note';
import { PersonRow } from '@/features/social/components/PersonRow';
import type { Person } from '@/features/social/types';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';

// 설정 > 차단한 사람 (새 화면, 친구 4장) — 내가 차단한 사람만. 줄 = 닉네임 · 아이디 + [풀기]. 횟수 제한 없음
//   탈퇴한 사람은 서버가 빼고 아이디를 바꾸면 새 아이디가 보임. 풀어도 친구는 새 요청부터, 상대에게 알리지 않음
export default function BlocksScreen() {
  const { data, error, reload } = useLoad(listBlocks);
  const { run } = useAction();

  const unblock = (p: Person) =>
    run(async () => {
      const ok = await confirm({ title: UNBLOCK_TEXT.title(p.name), message: UNBLOCK_TEXT.body, okLabel: UNBLOCK_TEXT.ok });
      if (!ok) return;
      try {
        await unblockUser(p.id);
        toast(UNBLOCK_TEXT.toast);
      } finally {
        await reload().catch(() => undefined); // 이미 풀린 경우(GONE)에도 목록을 새로 읽음
      }
    }, '차단을 풀지 못했어요. 다시 해 주세요');

  return (
    <Screen onRefresh={reload}>
      <TopBar onBack={backOrHome} />
      <Text variant="title" style={styles.title}>
        차단한 사람
      </Text>
      <Text variant="lead" style={styles.lead}>
        차단하면 서로 검색 · 요청 · 그룹 기상 · 깨우기에서 빠져요.
      </Text>

      {!data ? error ? <LoadError onRetry={reload} /> : <Loading /> : null}
      {data && !data.length ? <EmptyState title="차단한 사람이 없어요" /> : null}
      {data?.length ? (
        <Card>
          {data.map(({ person: p }, i) => (
            <PersonRow
              key={p.id}
              first={i === 0}
              icon={<Avatar initial={p.initial} />}
              title={p.name}
              sub={p.handle ?? undefined}
              rightIsButtons
              right={
                <View>
                  <Button small variant="ghost" label="풀기" onPress={() => unblock(p)} />
                </View>
              }
            />
          ))}
        </Card>
      ) : null}
      {data?.length ? <Note>풀어도 다시 친구가 되지는 않아요. 친구는 새 요청부터 시작해요. 상대에게는 알리지 않아요.</Note> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
});
