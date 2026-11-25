import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Field, Screen, Text, toast, TopBar } from '@/components/ui';
import { joinGroup, previewGroupByCode } from '@/features/social/api';
import { ConsentSheet } from '@/features/social/components/ConsentSheet';
import { GroupIcon } from '@/features/social/components/GroupIcon';
import { Note } from '@/features/social/components/Note';
import { cleanCode, expiresLabel, GROUP_ALREADY, GROUP_FULL, previewProblem } from '@/features/social/groupTexts';
import type { GroupPreview } from '@/features/social/types';
import { backOrHome, openGroupDetail } from '@/lib/nav';
import { useAction } from '@/lib/useAction';

// 코드 칸 최대 글자 수 — 코드는 8자. 붙여 넣을 때 공백이 섞여도 받게 여유를 둠
const CODE_MAX = 16;

// 초대 코드로 그룹 참여 — G01 그룹 탭 "그룹 참여하기"에서 옴 (친구 5장)
//   코드 입력 → [확인] 미리보기(그룹 이름 · 인원 · 이미 참여 · 만료 · 가득, 오류는 없는 · 만료 · 잠시 뒤 다시 세 가지) → [참여하기] → 기상 공유 동의 시트 → 그룹 상세
export default function JoinGroupScreen() {
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<{ code: string; result: GroupPreview } | null>(null); // 어느 코드로 물은 결과인지 같이 둠
  const [consent, setConsent] = useState(false);
  const { busy, run } = useAction();
  const cleaned = cleanCode(code);
  // 입력한 코드와 다른 코드로 물은 결과(늦게 온 응답)는 안 보임 — 코드를 고치면 미리보기가 사라지고 [확인]으로 돌아감
  const shown = preview && preview.code === cleaned ? preview.result : null;
  const found = shown?.status === 'FOUND' ? shown : null;

  const check = () =>
    run(async () => {
      if (!cleaned) return;
      const result = await previewGroupByCode(cleaned);
      setPreview({ code: cleaned, result });
    }, '코드를 확인하지 못했어요. 다시 해 주세요');

  // 이미 참여 중이면 같은 함수가 그 그룹 id만 돌려줌(상태 그대로) — 동의를 다시 묻지 않고 그룹 상세로
  const join = (share: boolean) =>
    run(async () => {
      try {
        const g = await joinGroup(cleaned, share);
        toast(g.already ? GROUP_ALREADY : '그룹에 참여했어요');
        openGroupDetail(g.id, 'stack');
      } catch (e) {
        setPreview(null); // 미리보기 뒤 코드가 바뀌었을 수 있음 — 다시 [확인]부터
        throw e;
      } finally {
        setConsent(false);
      }
    }, '그룹에 참여하지 못했어요. 다시 해 주세요');

  const problem = shown ? previewProblem(shown) : null;
  const primary = !found ? (
    <Button label="확인" onPress={check} disabled={!cleaned} loading={busy} />
  ) : found.alreadyJoined ? (
    <Button label="그룹으로 가기" onPress={() => join(false)} loading={busy} />
  ) : (
    <Button label="참여하기" onPress={() => setConsent(true)} disabled={found.full} loading={busy} />
  );

  return (
    <Screen footer={primary}>
      <ConsentSheet visible={consent} groupName={found?.name} busy={busy} onChoose={join} onClose={() => setConsent(false)} />
      <TopBar onBack={backOrHome} />
      <Text variant="title" style={styles.title}>
        그룹 참여하기
      </Text>
      <Text variant="lead" style={styles.lead}>
        친구에게 받은 초대 코드를 입력해요.
      </Text>

      <Card>
        <Field
          first
          label="초대 코드"
          value={code}
          onChangeText={(t) => setCode(t.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={CODE_MAX}
          placeholder="예: A2B3C4D5"
          returnKeyType="go"
          onSubmitEditing={check}
        />
      </Card>

      {problem ? (
        <Text variant="small" tone="warn" style={styles.problem} accessibilityLiveRegion="polite">
          {problem}
        </Text>
      ) : null}

      {found ? (
        <Card>
          <View style={styles.row}>
            <GroupIcon label={[...found.name][0] ?? ''} />
            <View style={styles.grow}>
              <Text variant="big" numberOfLines={2}>
                {found.name}
              </Text>
              <Text variant="small" tone="sub">
                {found.memberCount}명{found.expiresAt ? ` · ${expiresLabel(found.expiresAt)}` : ''}
              </Text>
            </View>
          </View>
          {found.alreadyJoined || found.full ? (
            <Text variant="small" tone="warn" style={styles.state}>
              {found.alreadyJoined ? GROUP_ALREADY : GROUP_FULL}
            </Text>
          ) : null}
        </Card>
      ) : null}
      <Note>내가 보여 줄 범위는 들어갈 때 정해요.</Note>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  problem: { marginTop: 10, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  state: { marginTop: 10 },
});
