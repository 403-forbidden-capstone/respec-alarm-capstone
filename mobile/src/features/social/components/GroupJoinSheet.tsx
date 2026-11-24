import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, KeyValueRow, Loading, Sheet, Text } from '@/components/ui';
import { OptionGrid } from '@/features/alarm/components/OptionGrid';
import { TRANSPORT_OPTIONS, type JoinChoice, type JoinDefaults, type Transport } from '@/features/alarm/types';

import type { GroupAppointment } from '../types';

type Props = {
  appointment: GroupAppointment | null; // 열린 약속 — null이면 닫힘
  defaults: JoinDefaults | null; // 읽는 중이면 null
  busy: boolean;
  onJoin: (choice: JoinChoice) => void;
  onClose: () => void;
};

// [내 알람 만들기] 확인 시트: 사용자 입력은 온보딩/설정의 순수준비시간 하나뿐.
// 여기서는 다른 단위(기상→출발)로 다시 입력받지 않으며 서버가 내 AUTO 알람을 계산.
export function GroupJoinSheet({ appointment, defaults, busy, onJoin, onClose }: Props) {
  return (
    <Sheet visible={appointment != null} onClose={onClose} title={appointment ? `${appointment.title} · 내 알람 만들기` : undefined}>
      {appointment && defaults ? <Body key={appointment.id} defaults={defaults} busy={busy} onJoin={onJoin} /> : appointment ? <Loading /> : null}
    </Sheet>
  );
}

function Body({ defaults, busy, onJoin }: { defaults: JoinDefaults; busy: boolean; onJoin: (choice: JoinChoice) => void }) {
  const [transport, setTransport] = useState<Transport>(defaults.transport);
  // No legacy whole-window manual override is sent from this sheet.
  const choice: JoinChoice = { transport, prepareMinutes: null };

  return (
    <View>
      <KeyValueRow first label="출발지" value={defaults.homeName ?? '집 위치 미설정'} />
      <Text variant="rowLabel" tone="sub" style={styles.label}>
        이동 수단
      </Text>
      <OptionGrid<Transport> label="이동 수단" options={TRANSPORT_OPTIONS} value={transport} onChange={setTransport} />
      <KeyValueRow label="순수 외출 준비시간" value={defaults.purePrepMinutes == null ? '미설정 · 기존 방식 사용' : `${defaults.purePrepMinutes}분`} />
      <Text variant="small" tone="sub" style={styles.note}>
        준비시간은 온보딩·설정에서 입력한 값을 사용해요. 내 출발지·이동 수단과 개인 준비시간으로 알람을 계산하며 다른 참여자에게 표시되지 않아요.
      </Text>
      <Button label="내 알람 만들기" loading={busy} onPress={() => onJoin(choice)} />
    </View>
  );
}

const styles = StyleSheet.create({
  label: { marginTop: 12, marginBottom: 8 },
  note: { marginTop: 12, marginBottom: 14, lineHeight: 20 },
});
