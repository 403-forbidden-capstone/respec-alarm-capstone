import { StyleSheet, View } from 'react-native';

import { Button, Card, Screen, Text, toast, TopBar } from '@/components/ui';
import {
  askNotifications,
  openBatterySettings,
  openExactAlarmSettings,
  openFullScreenSettings,
  openUsageAccessSettings,
  usePermissions,
} from '@/features/permissions';
import { CheckRow } from '@/features/permissions/components/CheckRow';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';

// L04 알람이 안 울릴 때 — 점검표. 홈 빨간 줄 · 설정에서 들어옴 (목업에는 없는 화면)
// 폰이 앱에 준 권한 상태를 읽어 보여 주고 설정 화면을 열어 줌. 설정에서 돌아오면 usePermissions가 다시 읽음
export default function RingCheckScreen() {
  const { snapshot, refresh } = usePermissions();
  const { busy: turningOn, run: runTurnOn } = useAction(); // 시스템 창이 도는 동안 다시 누르지 않게
  const { busy: rechecking, run: runRecheck } = useAction();
  // 웹 · 가짜 · 옛 APK는 상태를 못 읽음 — 상태 칩 · 버튼 없이 설명만 보임 (처음 읽는 동안은 snapshot이 없어 안내도 아직 안 띄움)
  const live = snapshot?.supported ? snapshot : null;

  return (
    <Screen>
      <TopBar onBack={backOrHome} screenId="L04" />
      <Text variant="title" style={styles.title}>
        알람이 안 울릴 때
      </Text>
      <Text variant="lead" style={styles.lead}>
        알람이 안 울리거나 늦게 울리면 아래를 확인해 주세요.
      </Text>

      {snapshot && !live ? (
        <Card variant="dash">
          <Text variant="small" tone="sub">
            폰에서 확인해요 — 웹 미리 보기에서는 권한 상태를 읽지 못해요
          </Text>
        </Card>
      ) : null}

      <Card>
        <CheckRow
          first
          name="알림"
          reason="알람 화면과 준비 · 출발 알림이 뜨려면 필요해요"
          state={live?.notifications}
          actionLabel={live?.notifications === 'off' ? '켜기' : undefined}
          onAction={() => void runTurnOn(async () => void (await askNotifications('settings')))}
          busy={turningOn}
        />
        <CheckRow
          name="전체화면 알림"
          reason="잠금화면 위에 알람 화면을 띄워요"
          state={live?.fullScreen}
          actionLabel={live ? '설정 열기' : undefined}
          onAction={() => void openFullScreenSettings()}
        />
        {/* 정확한 알람은 안드로이드 12에서 꺼질 수 있음 — 꺼졌을 때만 줄을 보임 */}
        {live?.exactAlarm === 'off' ? (
          <CheckRow
            name="정확한 알람"
            reason="정해진 시각에 정확히 울리게 해요 (안드로이드 12)"
            state="off"
            actionLabel="설정 열기"
            onAction={() => void openExactAlarmSettings()}
          />
        ) : null}
        <CheckRow
          name="사용 정보 접근"
          reason="알람을 끈 뒤 폰을 쓰는지로 기상을 자동 확인해요 (안 켜면 직접 눌러요)"
          state={live?.usageAccess}
          actionLabel={live ? '설정 열기' : undefined}
          onAction={() => void openUsageAccessSettings()}
        />
        <CheckRow
          name={'배터리 사용 "제한 없음"'}
          reason={"배터리 절약이 알람 앱을 멈추지 않게 해요. 목록에서 Re:Spec 알람을 찾아 '최적화 안 함'으로"}
          actionLabel={live ? '설정 열기' : undefined}
          onAction={() => void openBatterySettings()}
        />
        <CheckRow
          name="삼성 폰: 절전 예외"
          reason="설정 › 배터리 › 백그라운드 사용 제한 › '사용하지 않는 앱 절전'에서 빼고 '절전 예외 앱'에 추가해 주세요"
        />
        <CheckRow
          name="알림 음량 · 방해 금지"
          reason="준비 · 출발 알림은 알림 음량을 따라요. 방해 금지 중이면 소리 없이 와요. 기상 알람은 앱이 음량을 직접 맞춰요"
        />
      </Card>

      <View style={styles.recheck}>
        <Button
          variant="ghost"
          label="다시 확인"
          loading={rechecking}
          onPress={() =>
            void runRecheck(async () => {
              await refresh();
              toast('다시 확인했어요');
            })
          }
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8 },
  lead: { marginTop: 4, marginBottom: 16 },
  recheck: { marginTop: 4 },
});
