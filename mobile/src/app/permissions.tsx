import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, Chip, LoadError, Screen, Segmented, Sheet, Text, toast, Toggle, TopBar } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import {
  getFriendGrant,
  getGroup,
  getReceived,
  getShareSettings,
  listFriends,
  listRelations,
  saveShareSettings,
} from '@/features/social/api';
import { GroupIcon } from '@/features/social/components/GroupIcon';
import { PersonRow } from '@/features/social/components/PersonRow';
import { parseRelation, permissionNames, togglePermission } from '@/features/social/permissions';
import { PERMISSIONS, type PermissionSet, type Relation, type RelationId } from '@/features/social/types';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';
import { useAction } from '@/lib/useAction';

type Side = 'give' | 'recv';

const SIDES = [
  ['give', '내가 공유'],
  ['recv', '받은 권한'],
] as const;

// F03 공유 권한 설정 — 관계(친구 한 명 · 그룹 하나)를 골라 내가 주는 권한을 바꾸고, 그 관계에서 받은 권한을 봄
// 주소: /permissions?relation=group:cap · friend:sy. 없으면 첫 관계(그룹 먼저 — 목업 "권한 관리"는 캡스톤팀)
export default function PermissionSettingsScreen() {
  const { relation: param } = useLocalSearchParams<{ relation?: string }>();
  const { data: relations, error, reload } = useLoad(listRelations);
  const [picked, setPicked] = useState<RelationId | null>(null);
  const [side, setSide] = useState<Side>('give');
  const [picking, setPicking] = useState(false);
  // 저장 전 스위치 값 — 관계를 바꾸면 버림, 내가 공유 · 받은 권한을 오가도 남음 (목업 pDraft)
  const [draft, setDraft] = useState<{ id: RelationId; set: PermissionSet } | null>(null);
  const back = router.canGoBack() ? router.back : undefined;

  const head = (
    <>
      <TopBar onBack={back} screenId="F03" />
      <Text variant="title" style={styles.title}>
        공유 권한 설정
      </Text>
      <Text variant="lead" style={styles.lead}>
        관계별로 내가 공유할 정보와 허용할 행동을 정해요.
      </Text>
    </>
  );

  if (!relations) return <Screen>{head}{error ? <LoadError onRetry={reload} /> : null}</Screen>;
  const wanted = picked ?? param ?? relations[0]?.id;
  const relation = relations.find((r) => r.id === wanted);
  if (!relation) {
    return (
      <Screen>
        {head}
        <Text variant="body" tone="sub">
          관계를 찾을 수 없어요.
        </Text>
      </Screen>
    );
  }

  function pick(id: RelationId) {
    setPicked(id);
    setDraft(null);
    setPicking(false);
  }

  return (
    <Screen>
      {head}
      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          권한을 적용할 관계
        </Text>
        <View style={styles.between}>
          <View style={styles.relation}>
            <RelationIcon relation={relation} />
            <View style={styles.grow}>
              <Text variant="bodyStrong">{relation.label}</Text>
              <Text variant="small" tone="sub">
                {relation.sub}
              </Text>
            </View>
          </View>
          <TextLink label="변경" onPress={() => setPicking(true)} />
        </View>
      </Card>

      <Segmented options={SIDES} value={side} onChange={setSide} />
      {side === 'give' ? (
        <ShareEditor
          key={relation.id}
          relation={relation}
          draft={draft?.id === relation.id ? draft.set : null}
          // 비울 때는 이 관계의 초안만 — 저장 중에 관계를 바꿨으면 새 관계의 초안은 남김
          onDraft={(set) => setDraft((d) => (set ? { id: relation.id, set } : d?.id === relation.id ? null : d))}
        />
      ) : (
        <ReceivedList key={relation.id} relationId={relation.id} />
      )}

      <Sheet visible={picking} onClose={() => setPicking(false)} title="권한을 적용할 관계">
        {relations.map((r, i) => (
          <PersonRow
            key={r.id}
            first={i === 0}
            icon={<RelationIcon relation={r} />}
            title={r.label}
            sub={r.sub}
            right={r.id === relation.id ? <Chip label="선택됨" variant="ink" /> : undefined}
            onPress={() => pick(r.id)}
          />
        ))}
      </Sheet>
    </Screen>
  );
}

function RelationIcon({ relation }: { relation: Relation }) {
  return relation.kind === 'friend' ? <Avatar initial={relation.initial} small /> : <GroupIcon label={relation.initial} small />;
}

// 내가 공유 — 스위치는 저장 전까지 draft에만, "변경사항 저장"을 눌러야 반영
function ShareEditor({
  relation,
  draft,
  onDraft,
}: {
  relation: Relation;
  draft: PermissionSet | null;
  onDraft: (set: PermissionSet | null) => void;
}) {
  const { data: saved, error, reload } = useLoad(() => getShareSettings(relation.id));
  const { busy, run } = useAction();
  if (!saved) return error ? <LoadError onRetry={reload} /> : null;
  const current = draft ?? saved;
  const changed = draft != null && PERMISSIONS.some(({ key }) => draft[key] !== saved[key]);

  // 바꾼 게 없으면(켰다가 다시 꺼도) 저장 버튼을 끔. 다시 읽기가 끝난 뒤 초안을 버려야 스위치가 예전 값으로 깜빡이지 않음
  // 다시 읽기에 실패하면 초안을 남겨 둠 — 저장된 값과 화면이 어긋나지 않게
  const save = () =>
    run(async () => {
      await saveShareSettings(relation.id, current);
      if (await reload()) {
        onDraft(null);
        toast(await savedMessage(relation));
      } else {
        toast('저장했어요. 바뀐 값을 다시 불러오지 못했어요');
      }
    });

  return (
    <>
      <Card>
        {PERMISSIONS.map(({ key, name, description }, i) => (
          <View key={key} style={[styles.toggleRow, i > 0 && styles.divider]}>
            <View style={styles.grow}>
              <Text variant="bodyStrong">{name}</Text>
              <Text variant="small" tone="sub" style={styles.description}>
                {description}
              </Text>
            </View>
            <Toggle value={current[key]} onChange={(next) => onDraft(togglePermission(current, key, next))} label={name} />
          </View>
        ))}
      </Card>
      <Card variant="dash">
        <Text variant="label" tone="sub" style={styles.label}>
          적용 방식
        </Text>
        <Text variant="small" tone="sub" style={styles.paragraph}>
          {relation.kind === 'group'
            ? '이 설정은 그룹 관계에서 주는 권한만 바꿔요. 멤버별 최종 권한은 친구 관계와 참여 중인 모든 그룹의 허용 권한을 합쳐 결정돼요.'
            : '이 설정은 친구 관계에서 주는 권한만 바꿔요. 같은 그룹에 있다면 그룹에서 준 권한은 그대로 남아요.'}
        </Text>
      </Card>
      <View style={styles.stack}>
        <Button label="변경사항 저장" onPress={save} disabled={!changed || busy} />
      </View>
    </>
  );
}

// 저장 뒤 토스트 — 한 관계를 바꿔도 최종 권한은 합집합이라는 걸 보여 줌
// 목업은 "수연님 최종 권한 n개"로 고정. 친구면 그 친구, 그룹이면 그 그룹에 있는 첫 친구 (작성자 판단)
async function savedMessage(relation: Relation) {
  const head = `${relation.label} 관계에 저장했어요`;
  const { kind, key } = parseRelation(relation.id);
  let personId: string | undefined = key;
  if (kind === 'group') {
    const [group, friends] = await Promise.all([getGroup(key), listFriends()]);
    const friendIds = new Set(friends.map((f) => f.person.id));
    personId = group?.members.find((m) => !m.isMe && friendIds.has(m.person.id))?.person.id;
  }
  const grant = personId ? await getFriendGrant(personId) : null;
  return grant ? `${head} · ${grant.person.short}님 최종 권한 ${grant.final.count}개` : head;
}

// 받은 권한 — 이 관계에서 상대(그룹이면 멤버마다)가 나에게 준 권한
function ReceivedList({ relationId }: { relationId: RelationId }) {
  const { data, error, reload } = useLoad(() => getReceived(relationId));
  if (!data) return error ? <LoadError onRetry={reload} /> : null;

  return (
    <Card>
      {data.length ? (
        data.map(({ person: p, permissions }, i) => {
          const names = permissionNames(permissions);
          return (
            <PersonRow
              key={p.id}
              first={i === 0}
              icon={<Avatar initial={p.initial} />}
              title={p.name}
              sub={names.length ? names.join(' · ') : '받은 권한 없음'}
            />
          );
        })
      ) : (
        <Text variant="note" tone="sub" style={styles.empty}>
          이 관계에서 받은 권한이 없어요.
        </Text>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  label: { marginBottom: 8 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  relation: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  description: { marginTop: 2 },
  paragraph: { lineHeight: 20 },
  stack: { gap: 10, marginTop: 16 },
  empty: { marginVertical: 6 },
});
