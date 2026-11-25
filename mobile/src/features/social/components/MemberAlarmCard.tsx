import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AlarmCard, Button, Text } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { addMinutes, formatDateShort, formatTime, timeParts } from '@/lib/format';

import { proposalLine } from '../proposalTexts';
import type { MemberAlarm } from '../types';

type Props = {
  alarm: MemberAlarm;
  busy?: boolean;
  onPropose?: (newAt: Date) => Promise<boolean>; // 설정 권한이 있을 때만 — 고른 시각으로 [보내기] · [원래대로], 보냈으면 true (실패하면 고른 시각을 남겨 다시 보내게)
};

const STEP_MINUTES = 5;

// 친구 · 그룹원이 공유한 알람 카드 (목업 memberAlarmCard) — 공유받은 알람(G04). 알람 탭과 같은 세 줄 카드(시각 · 체인 · 약속, 날짜는 약속 줄 앞)
// 설정 권한이 있으면 시각 고르기(5분씩) → [보내기] 한 번 (친구 10장): 바꾸는 게 아니라 제안이고, 끄기 · 삭제는 없음. 두 번째 줄에 내가 보낸 제안 상태('제안함' · '반영됨')
export function MemberAlarmCard({ alarm, busy, onPropose }: Props) {
  const first = alarm.chain[0];
  const baseAt = alarm.proposeAt ?? first.at; // 제안을 보낼 알람(켜져 있고 아직 안 울린 가장 이른 것)의 지금 시각
  const target = alarm.chain.find((x) => x.at.getTime() === baseAt.getTime()) ?? first;
  const [delta, setDelta] = useState(0); // 지금 시각에서 5분 단위로 움직인 값 (보내기 전 초안)
  const picked = addMinutes(baseAt, delta);
  const original = alarm.originalAt ?? null;
  const canRevert = original != null && original.getTime() !== baseAt.getTime();
  const line = proposalLine(alarm.proposal);

  return (
    <AlarmCard
      variant="compact"
      dateLabel={formatDateShort(alarm.date)}
      time={timeParts(first.at)}
      kindLabel={first.label}
      chain={alarm.chain.map((x) => `${formatTime(x.at)} ${x.label}`)}
      meta={[]}
      foot={`${formatDateShort(alarm.date)} · ${alarm.appointmentLabel}`}
      enabled={alarm.enabled}
    >
      {line ? (
        <Text variant="small" tone="sub" style={styles.line} accessibilityLiveRegion="polite">
          {line}
        </Text>
      ) : null}
      {onPropose && alarm.enabled && alarm.firstAlarmId ? (
        <View style={styles.pick}>
          <View style={styles.shift}>
            <TextLink label={`${STEP_MINUTES}분 앞당기기`} onPress={() => setDelta((d) => d - STEP_MINUTES)} />
            <TextLink label={`${STEP_MINUTES}분 늦추기`} onPress={() => setDelta((d) => d + STEP_MINUTES)} />
          </View>
          {delta !== 0 ? (
            <Text variant="bodyStrong" style={styles.line}>
              {`${target.label} ${formatTime(baseAt)} → ${formatTime(picked)}`}
            </Text>
          ) : null}
          <View style={styles.shift}>
            <Button
              small
              variant={delta === 0 ? 'ghost' : 'primary'}
              label="보내기"
              loading={busy}
              disabled={delta === 0}
              onPress={() => {
                void onPropose(picked).then((sent) => {
                  if (sent) setDelta(0); // 실패(오프라인 · 범위 밖)면 고른 시각을 남김 (친구 10-31)
                });
              }}
            />
            {canRevert ? <Button small variant="ghost" label="원래대로" disabled={busy} onPress={() => {
                  void onPropose(original).then((sent) => {
                    if (sent) setDelta(0);
                  });
                }}
              /> : null}
          </View>
        </View>
      ) : null}
    </AlarmCard>
  );
}

const styles = StyleSheet.create({
  pick: { marginTop: 12, gap: 10 },
  shift: { flexDirection: 'row', gap: 16, alignItems: 'center' },
  line: { marginTop: 8 },
});
