import { StyleSheet, View } from 'react-native';

import { Button, Card, KeyValueRow, Text, Toggle } from '@/components/ui';

import type { LocationStatus } from '../permissions';

type Props = {
  status: LocationStatus;
  auto: boolean; // 자동 기록 스위치
  busy?: boolean; // 바꾸는 중 — 스위치 · 버튼을 잠금
  onToggle: (on: boolean) => void;
  onEnable: () => void; // [위치 허용하기] — 앞 권한 창 → 항상 허용 설정 화면
  onOpenSettings: () => void;
};

export type Hint = { text: string; action: 'enable' | 'settings' };

// 상태별 안내 한 줄 + 버튼 종류. 켜짐 · 지원 안 함이면 안내 없음
export function hintFor(status: LocationStatus): Hint | null {
  switch (status) {
    case 'off':
      return { text: '위치를 아직 허용하지 않았어요. 온보딩에서 켜지 못했다면 여기서 켤 수 있어요', action: 'enable' };
    case 'foreground-only':
      return { text: "'항상 허용'으로 바꿔 주세요: 설정 → 위치 → 항상 허용", action: 'settings' };
    case 'coarse':
      return { text: '정확한 위치를 켜 주세요', action: 'settings' };
    default:
      return null;
  }
}

const STATUS_TEXT: Record<Exclude<LocationStatus, 'unsupported'>, string> = {
  on: '켜짐',
  off: '위치 꺼짐',
  'foreground-only': '앱 사용 중에만',
  coarse: '정확한 위치 꺼짐',
};

// 설정 카드 "출발 · 도착 자동 기록" — 값 · 콜백만 받음 (저장은 hooks/useLocationAuto)
//   스위치는 권한이 모자라도 켤 수 있음 (권한이 생기면 바로 등록됨) — 대신 모자란 걸 안내하고 설정 열기 버튼을 둠
//   지원 안 하는 기기(웹 · 가짜 데이터 · 안드로이드 아님)에서는 그리지 않음
export function LocationAutoCard({ status, auto, busy, onToggle, onEnable, onOpenSettings }: Props) {
  if (status === 'unsupported') return null;
  const hint = auto ? hintFor(status) : null;
  return (
    <Card>
      <View style={styles.head}>
        <Text variant="bodyStrong" style={styles.title}>
          출발 · 도착 자동 기록
        </Text>
        <Toggle value={auto} onChange={onToggle} label="출발 · 도착 자동 기록" disabled={busy} />
      </View>
      <Text variant="small" style={styles.desc}>
        집을 나서고 약속 장소에 도착하면 시각을 자동으로 기록해요. 위치는 이 폰에만 있고 누구에게도 공유되지 않아요.
      </Text>
      <KeyValueRow label="위치 권한" value={STATUS_TEXT[status]} />
      {hint ? (
        <View style={styles.guide}>
          <Text variant="small" tone="warn">
            {hint.text}
          </Text>
          {hint.action === 'enable' ? (
            <Button label="위치 허용하기" variant="ghost" small disabled={busy} onPress={onEnable} />
          ) : (
            <Button label="설정 열기" variant="ghost" small disabled={busy} onPress={onOpenSettings} />
          )}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { flexShrink: 1 },
  desc: { marginTop: 6, marginBottom: 6 },
  guide: { gap: 8, paddingTop: 4, paddingBottom: 2 },
});
