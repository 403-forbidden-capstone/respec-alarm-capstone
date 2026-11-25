import { useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Avatar,
  Button,
  Card,
  Chip,
  confirm,
  EmptyState,
  LoadError,
  Loading,
  Screen,
  Segmented,
  Sheet,
  Text,
  toast,
  Toggle,
  TopBar,
} from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { getReceived, getShareSettings, listRelations, saveShareSettings } from '@/features/social/api';
import { GroupIcon } from '@/features/social/components/GroupIcon';
import { PersonRow } from '@/features/social/components/PersonRow';
import { permissionNames, togglePermission } from '@/features/social/permissions';
import { permissionsFor, TRIP_NEEDS_WAKE, type PermissionSet, type Relation, type RelationId } from '@/features/social/types';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';
import { useAction } from '@/lib/useAction';
import { useLeaveGuard } from '@/lib/useLeaveGuard';
import { backOrHome } from '@/lib/nav';

// 그룹 관계의 기상 상태 스위치 = 이 그룹에 내 기상 공유 동의 (친구 6장 — 기상은 권한 행이 아니라 그룹 동의 하나)
const WAKE_CONSENT_DESCRIPTION = '기상 확인 여부와 시각이 이 그룹에 보여요.';

// 알람 조회 · 설정이 엮인 규칙 — 항목마다 풀어 쓰지 않고 한 번만
const ALARM_RULE = '알람 설정을 켜면 알람 조회도 같이 켜져요. 집 · 출발지는 안 보여요.';

type Side = 'give' | 'recv';

const SIDES = [
  ['give', '내가 공유'],
  ['recv', '받은 권한'],
] as const;

// F03 공유 권한 설정 — 관계(친구 한 명 · 그룹 하나)를 골라 내가 주는 권한을 바꾸고, 그 관계에서 받은 권한을 봄
// 주소: /permissions?relation=group:cap · friend:sy. 관계 없이 열면(친구와 그룹의 "권한 관리") 먼저 관계를 고르게 함
export default function PermissionSettingsScreen() {
  const { relation: param } = useLocalSearchParams<{ relation?: string }>();
  const { data: relations, error, reload } = useLoad(listRelations);
  const [picked, setPicked] = useState<RelationId | null>(null);

  const head = (
    <>
      <TopBar onBack={backOrHome} screenId="F03" />
      <Text variant="title" style={styles.title}>
        공유 권한 설정
      </Text>
      <Text variant="lead" style={styles.lead}>
        관계별로 내가 공유할 정보와 허용할 행동을 정해요.
      </Text>
    </>
  );

  if (!relations) return <Screen>{head}{error ? <LoadError onRetry={reload} /> : <Loading />}</Screen>;
  if (!relations.length) {
    return (
      <Screen>
        {head}
        <EmptyState title="공유할 친구나 그룹이 없어요" body="친구를 추가하거나 그룹에 참여하면 여기서 공유 범위를 정할 수 있어요." />
      </Screen>
    );
  }

  const wanted = picked ?? param;
  const relation = relations.find((r) => r.id === wanted);
  // 관계 없이 열었거나 없는 관계면 먼저 고르게 함
  if (!relation) {
    return (
      <Screen>
        {head}
        <Text variant="label" tone="sub" style={styles.label}>
          누구와의 공유인지 골라 주세요
        </Text>
        <Card>
          <RelationList relations={relations} onPick={setPicked} />
        </Card>
      </Screen>
    );
  }

  // 관계를 바꾸면 초안 · 보던 칸이 새로 시작되게 key로 나눔
  return <Editor key={relation.id} relation={relation} relations={relations} head={head} onPick={setPicked} />;
}

function Editor({
  relation,
  relations,
  head,
  onPick,
}: {
  relation: Relation;
  relations: Relation[];
  head: ReactNode;
  onPick: (id: RelationId) => void;
}) {
  const { data: saved, error, reload } = useLoad(() => getShareSettings(relation.id));
  const { busy, run } = useAction();
  const [side, setSide] = useState<Side>('give');
  const [picking, setPicking] = useState(false);
  // 저장 전 스위치 값 — 내가 공유 · 받은 권한을 오가도 남음 (목업 pDraft)
  const [draft, setDraft] = useState<PermissionSet | null>(null);
  const current = draft ?? saved;
  // 바꾼 게 없으면(켰다가 다시 꺼도) 저장 버튼을 끄고 나갈 때 묻지 않음
  const changed = saved != null && draft != null && permissionsFor(relation.kind).some(({ key }) => !!draft[key] !== !!saved[key]);
  useLeaveGuard(changed);

  // 다시 읽기가 끝난 뒤 초안을 버려야 스위치가 예전 값으로 깜빡이지 않음
  // 다시 읽기에 실패하면 초안을 남겨 둠 — 저장된 값과 화면이 어긋나지 않게
  const save = () =>
    run(async () => {
      const values = draft ?? saved; // 그룹 관계는 값이 그대로여도 저장 (아래 canSave)
      if (!values) return;
      await saveShareSettings(relation.id, values);
      if (await reload()) {
        setDraft(null);
        toast(savedMessage(relation));
      } else {
        toast('저장했어요. 바뀐 값을 다시 불러오지 못했어요');
      }
    }, '공유 권한을 저장하지 못했어요');

  // 다른 관계로 바꿀 때 고친 스위치가 있으면 물어봄 (취소하면 목록이 그대로 열려 있음)
  async function pick(id: RelationId) {
    const same = id === relation.id;
    if (!same && changed && !(await confirm({ title: '저장하지 않고 바꿀까요?', message: '고친 스위치 값이 사라져요.', okLabel: '바꾸기', destructive: true }))) return;
    setPicking(false);
    if (!same) onPick(id);
  }

  // 그룹 관계는 값이 그대로여도 저장할 수 있음 — 권한을 준 뒤 들어온 멤버는 조회만 자동으로 받으므로 설정은 다시 저장해야 그 사람 몫 행이 생김 (친구 6-15). 친구 관계는 바꾼 게 있을 때만
  const canSave = changed || relation.kind === 'group';
  const footer = current && (side === 'give' || changed) ? <Button label="변경사항 저장" onPress={save} disabled={!canSave} loading={busy} /> : undefined;

  return (
    <Screen footer={footer}>
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
          <TextLink label="변경 ⌄" accessibilityLabel="관계 변경" onPress={() => setPicking(true)} />
        </View>
      </Card>

      <Segmented options={SIDES} value={side} onChange={setSide} />
      {side === 'give' ? (
        !current ? (
          error ? <LoadError onRetry={reload} /> : <Loading />
        ) : (
          <>
            <Card>
              {permissionsFor(relation.kind).map(({ key, name, description }, i) => (
                <View key={key} style={[styles.toggleRow, i > 0 && styles.divider]}>
                  <View style={styles.grow}>
                    <Text variant="bodyStrong">{name}</Text>
                    <Text variant="small" tone="sub" style={styles.description}>
                      {key === 'viewWake' ? WAKE_CONSENT_DESCRIPTION : description}
                    </Text>
                    {key === 'viewTrip' && !current.viewWake ? (
                      <Text variant="label" tone="sub" style={styles.description}>
                        {TRIP_NEEDS_WAKE}
                      </Text>
                    ) : null}
                  </View>
                  <Toggle
                    value={!!current[key]}
                    onChange={(next) => setDraft(togglePermission(current, key, next))}
                    label={name}
                    disabled={busy || (key === 'viewTrip' && !current.viewWake)} // 출발 · 도착 공유는 기상 공유를 켠 사람만
                  />
                </View>
              ))}
            </Card>
            <Card variant="dash">
              <Text variant="label" tone="sub" style={styles.label}>
                적용 방식
              </Text>
              <Text variant="small" tone="sub" style={styles.paragraph}>
                {ALARM_RULE}{' '}
                {relation.kind === 'group'
                  ? '이 설정은 그룹에서 주는 권한만 바꿔요. 멤버별 최종 권한은 친구와 모든 그룹의 허용을 합쳐 정해져요.'
                  : '이 설정은 친구에게 주는 권한만 바꿔요. 같은 그룹에서 준 권한은 그대로 남아요.'}
              </Text>
            </Card>
          </>
        )
      ) : (
        <ReceivedList relationId={relation.id} />
      )}

      <Sheet visible={picking} onClose={() => setPicking(false)} title="권한을 적용할 관계">
        <RelationList relations={relations} selectedId={relation.id} onPick={pick} />
      </Sheet>
    </Screen>
  );
}

// 저장 뒤 토스트 — 무엇을 저장했는지 (그룹은 이름, 친구는 이름님과의 공유 권한)
function savedMessage(relation: Relation) {
  return relation.kind === 'group' ? `${relation.label} 공유 권한을 저장했어요` : `${relation.label}님과의 공유 권한을 저장했어요`;
}

function RelationIcon({ relation }: { relation: Relation }) {
  return relation.kind === 'friend' ? <Avatar initial={relation.initial} small /> : <GroupIcon label={relation.initial} small />;
}

// 관계 고르기 목록 — 관계 없이 열었을 때 화면에, "변경"을 눌렀을 때 시트에
function RelationList({ relations, selectedId, onPick }: { relations: Relation[]; selectedId?: RelationId; onPick: (id: RelationId) => void }) {
  return (
    <>
      {relations.map((r, i) => (
        <PersonRow
          key={r.id}
          first={i === 0}
          icon={<RelationIcon relation={r} />}
          title={r.label}
          sub={r.sub}
          right={r.id === selectedId ? <Chip label="선택됨" variant="ink" /> : undefined}
          onPress={() => onPick(r.id)}
        />
      ))}
    </>
  );
}

// 받은 권한 — 이 관계에서 상대(그룹이면 멤버마다)가 나에게 준 권한
function ReceivedList({ relationId }: { relationId: RelationId }) {
  const { data, error, reload } = useLoad(() => getReceived(relationId));
  if (!data) return error ? <LoadError onRetry={reload} /> : <Loading />;

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
  empty: { marginVertical: 6 },
});
