import { StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';

type Props = {
  onPhoto?: () => void; // 없으면 사진 버튼을 안 그림 (길 flag가 꺼진 것)
  onCalendar?: () => void; // 없으면 캘린더 버튼을 안 그림
  busy?: boolean; // 읽는 중 — 버튼을 막고 사진 버튼에 처리 중 표시
  reading?: 'photo' | 'calendar' | null;
  onManual?: () => void; // 있으면 [직접 넣기]를 같은 줄에 더함 (수업이 하나도 없을 때)
};

// 수업을 한 줄씩 넣는 대신 한 번에 가져오는 입구 — 온보딩 시간표 단계 위 · 학교 시간표 화면에서 같이 씀. 값 · 콜백만 받음
export function ImportEntryCard({ onPhoto, onCalendar, busy, reading, onManual }: Props) {
  if (!onPhoto && !onCalendar && !onManual) return null;
  const imports = onPhoto || onCalendar;
  return (
    <Card style={styles.card}>
      {imports ? (
        <Text variant="rowLabel" weight={600}>
          한 번에 가져오기
        </Text>
      ) : null}
      {onPhoto ? (
        <Text variant="small" tone="sub" style={styles.note}>
          시간표 사진은 AI(Claude)가 읽고, 우리 서버에는 저장하지 않아요
        </Text>
      ) : null}
      {onCalendar ? (
        <Text variant="small" tone="sub" style={styles.note}>
          캘린더는 폰에서 읽고, 확인한 수업만 저장해요
        </Text>
      ) : null}
      <View style={[styles.buttons, !imports && styles.buttonsAlone]}>
        {onPhoto ? <Button variant="ghost" small label="시간표 사진으로 넣기" onPress={onPhoto} disabled={busy} loading={reading === 'photo'} /> : null}
        {onCalendar ? <Button variant="ghost" small label="폰 캘린더에서 가져오기" onPress={onCalendar} disabled={busy} loading={reading === 'calendar'} /> : null}
        {onManual ? <Button variant="ghost" small label="직접 넣기" onPress={onManual} disabled={busy} /> : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12 },
  note: { marginTop: 4 },
  buttons: { marginTop: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  buttonsAlone: { marginTop: 0 },
});
