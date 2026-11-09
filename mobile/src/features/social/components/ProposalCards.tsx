import { StyleSheet, View } from 'react-native';

import { Button, Card, Text, toast } from '@/components/ui';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';

import { listAlarmProposals, respondAlarmProposal } from '../api';
import { PROPOSAL_APPLIED, PROPOSAL_DISMISSED, PROPOSAL_EXPIRED, PROPOSAL_FAILED, proposalChange } from '../proposalTexts';

// 받은 알람 제안 카드 (친구 10장) — '수연 제안 / 기상 알람 7:30 → 7:00 [적용] [무시]'. 홈 · 알람 목록 위에 붙음
//   [적용]해야 내 알람이 바뀜(자는 동안엔 앞당김도 안 들어감), [무시]는 보낸 친구에게 알리지 않음. 알람 시각이 지났거나 내가 그사이 직접 고쳤으면 '이미 지나간 제안'
//   제안이 없거나 못 읽으면 아무것도 안 그림(덤 정보). 화면에 들어올 때마다 다시 읽음. onChanged = 적용한 뒤 부르는 화면이 자기 알람 카드를 다시 읽는 콜백
export function ProposalCards({ onChanged }: { onChanged?: () => void }) {
  const { data, reload } = useLoad(listAlarmProposals);
  const { busy, run } = useAction();
  if (!data?.length) return null;

  const respond = (id: string, apply: boolean) =>
    run(async () => {
      let result;
      try {
        result = await respondAlarmProposal(id, apply);
      } catch (e) {
        await reload(); // 이미 처리됐거나 범위를 넘은 제안은 서버가 끝낸 것 — 죽은 카드가 남지 않게 목록을 다시 읽음
        throw e;
      }
      toast(result === 'APPLIED' ? PROPOSAL_APPLIED : result === 'DISMISSED' ? PROPOSAL_DISMISSED : PROPOSAL_EXPIRED);
      await reload();
      if (result === 'APPLIED') onChanged?.(); // 적용하면 이 화면의 알람 카드도 새 시각으로 다시 읽음 (친구 10-29)
    }, PROPOSAL_FAILED);

  return (
    <>
      {data.map((p) => (
        <Card key={p.id}>
          <Text variant="bodyStrong">{`${p.proposerName}님의 제안`}</Text>
          <Text variant="body" style={styles.change}>
            {proposalChange(p.kindLabel, p.fromAt, p.toAt)}
          </Text>
          <View style={styles.buttons}>
            <Button small label="적용" loading={busy} onPress={() => respond(p.id, true)} />
            <Button small variant="ghost" label="무시" disabled={busy} onPress={() => respond(p.id, false)} />
          </View>
        </Card>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  change: { marginTop: 4 },
  buttons: { flexDirection: 'row', gap: 8, marginTop: 12 },
});
