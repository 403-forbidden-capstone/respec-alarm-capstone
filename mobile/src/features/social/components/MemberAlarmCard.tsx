import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AlarmCard, Button, Text, TopBarButton } from '@/components/ui';
import { addMinutes, formatDateShort, formatTime, timeParts } from '@/lib/format';

import { proposalLine } from '../proposalTexts';
import type { MemberAlarm } from '../types';

type Props = {
  alarm: MemberAlarm;
  busy?: boolean;
  onPropose?: (newAt: Date) => void; // 설정 권한이 있을 때만 — 고른 시각으로 [보내기] · [원래대로]
};

const STEP_MINUTES = 5;

// 친구 · 그룹원이 공유한 알람 카드 (목업 memberAlarmCard) — 그룹원 기상 상태(G03) · 공유받은 알람(G04)
// 강도 · 준비 값은 비어 있을 수 있음 — 실데이터에서 기상 상태 조회(G03)만 허용받으면 알람 강도 · 준비 시간은 못 읽음
// 설정 권한이 있으면 시각 고르기(5분씩) → [보내기] 한 번 (친구 10장): 바꾸는 게 아니라 제안이고, 끄기 · 삭제는 없음. 두 번째 줄에 내가 보낸 제안 상태('제안함' · '반영됨')
export function MemberAlarmCard({ alarm, busy, onPropose }: Props) {
  const first = alarm.chain[0];
  const [delta, setDelta] = useState(0); // 지금 시각에서 5분 단위로 움직인 값 (보내기 전 초안)
  const picked = addMinutes(first.at, delta);
  const original = alarm.originalAt ?? null;
  const canRevert = original != null && original.getTime() !== first.at.getTime();
  const line = proposalLine(alarm.proposal);

  return (
    <AlarmCard
      dateLabel={formatDateShort(alarm.date)}
      time={timeParts(first.at)}
      kindLabel={first.label}
      chain={alarm.chain.map((x) => `${formatTime(x.at)} ${x.label}`)}
      meta={[alarm.levelName ? `알람 강도 · ${alarm.levelName}` : '', alarm.note].filter(Boolean)}
      foot={alarm.appointmentLabel}
      enabled={alarm.enabled}
    >
      {line ? (
        <Text variant="small" tone="sub" style={styles.line} accessibilityLiveRegion="polite">
          {line}
        </Text>
      ) : null}
      {onPropose && alarm.enabled ? (
        <View style={styles.pick}>
          <View style={styles.shift}>
            <TopBarButton label={`${STEP_MINUTES}분 앞당기기`} onPress={() => setDelta((d) => d - STEP_MINUTES)} />
            <TopBarButton label={`${STEP_MINUTES}분 늦추기`} onPress={() => setDelta((d) => d + STEP_MINUTES)} />
          </View>
          {delta !== 0 ? (
            <Text variant="bodyStrong" style={styles.line}>
              {`${first.label} ${formatTime(first.at)} → ${formatTime(picked)}`}
            </Text>
          ) : null}
          <View style={styles.shift}>
            <Button
              small
              label="보내기"
              loading={busy}
              disabled={delta === 0}
              onPress={() => {
                onPropose(picked);
                setDelta(0);
              }}
            />
            {canRevert ? <Button small variant="ghost" label="원래대로" disabled={busy} onPress={() => onPropose(original)} /> : null}
          </View>
        </View>
      ) : null}
    </AlarmCard>
  );
}

const styles = StyleSheet.create({
  pick: { marginTop: 12, gap: 10 },
  shift: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  line: { marginTop: 8 },
});
