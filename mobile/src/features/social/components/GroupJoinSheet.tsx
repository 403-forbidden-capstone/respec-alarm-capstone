import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, KeyValueRow, Loading, Sheet, Stepper, Text } from '@/components/ui';
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

// [내 알람 만들기] 확인 시트 (친구 9장) — 출발지는 내 집, 수단 · 준비 시간은 프로필 기본값에서 고침. 알람 시각은 각자 조건으로 서버가 계산
//   출발지 · 수단 · 준비는 다른 참여자에게 안 보임 (9-너)
export function GroupJoinSheet({ appointment, defaults, busy, onJoin, onClose }: Props) {
  return (
    <Sheet visible={appointment != null} onClose={onClose} title={appointment ? `${appointment.title} · 내 알람 만들기` : undefined}>
      {appointment && defaults ? <Body key={appointment.id} defaults={defaults} busy={busy} onJoin={onJoin} /> : appointment ? <Loading /> : null}
    </Sheet>
  );
}

function Body({ defaults, busy, onJoin }: { defaults: JoinDefaults; busy: boolean; onJoin: (choice: JoinChoice) => void }) {
  const [transport, setTransport] = useState<Transport>(defaults.transport);
  const [prepare, setPrepare] = useState(defaults.prepareMinutes);
  // 준비 시간을 안 고쳤으면 보내지 않음 — 서버가 내 기록으로 계산(개인 보정)
  const choice: JoinChoice = { transport, prepareMinutes: prepare === defaults.prepareMinutes ? null : prepare };

  return (
    <View>
      <KeyValueRow first label="출발지" value={defaults.homeName ?? '집 위치 미설정'} />
      <Text variant="rowLabel" tone="sub" style={styles.label}>
        이동 수단
      </Text>
      <OptionGrid<Transport> label="이동 수단" options={TRANSPORT_OPTIONS} value={transport} onChange={setTransport} />
      <Stepper label="준비 시간" value={prepare} onChange={setPrepare} step={5} min={10} max={240} unit="분" />
      <Text variant="small" tone="sub" style={styles.note}>
        내 출발지 · 이동 수단 · 준비 시간으로 알람을 계산해요. 이 값은 다른 참여자에게 보이지 않아요.
      </Text>
      <Button label="내 알람 만들기" loading={busy} onPress={() => onJoin(choice)} />
    </View>
  );
}

const styles = StyleSheet.create({
  label: { marginTop: 12, marginBottom: 8 },
  note: { marginTop: 12, marginBottom: 14, lineHeight: 20 },
});
