import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Card, confirm, KeyValueRow, Screen, SectionHeader, Sheet, Text, toast, Toggle, TopBar } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { listPlaces, reverseAddress } from '@/features/alarm/api';
import { MapPlaceSheet } from '@/features/alarm/components/MapPlaceSheet';
import { homeOf } from '@/features/alarm/placeSheet';
import type { PickedPlace } from '@/features/alarm/mapPicker';
import { useAuth } from '@/features/auth/AuthProvider';
import { HOME_RADIUS_M } from '@/features/location/constants';
import { locateOnce } from '@/features/location/currentPosition';
import { HOME_RADIUS_PRESETS } from '@/features/location/radius';
import { FrequentPlacesSection } from '@/features/location/FrequentPlacesSection';
import { LocationAutoSection } from '@/features/location/LocationAutoSection';
import { deleteMyAccount, getDeleteSummary, isAccountGone } from '@/features/account/api';
import { ALREADY_DELETED_TOAST, DELETE_ACCOUNT_LABEL, DELETE_FAILED, DELETE_FIRST, DELETE_SECOND, DELETE_SUMMARY_FAILED, DELETED_TOAST } from '@/features/account/texts';
import { openAppNotificationSettings, turnOnNotifications, usePermissions } from '@/features/permissions';
import { homePatchOf } from '@/features/onboarding/home';
import { saveProfileFields } from '@/features/profile/api';
import { EditRow } from '@/features/profile/components/EditRow';
import { PrepareMlSurveyEditor } from '@/features/profile/components/PrepareMlSurveyEditor';
import { EMPTY_PREPARE_ML_SURVEY, prepareMlSurveySummary } from '@/features/profile/prepareMlSurvey';
import { VoiceBriefingSection } from '@/features/profile/components/VoiceBriefingSection';
import { useVoiceTone } from '@/features/profile/hooks/useVoiceTone';
import { ChangeHandleSheet } from '@/features/profile/components/ChangeHandleSheet';
import { NicknameEditor, PrepareEditor, SleepEditor } from '@/features/profile/components/ProfileEditors';
import { prepareValuesOf } from '@/features/profile/edit';
import { TRANSPORT_NAME, WAKE_MARGIN_NAME, WAKE_SENSITIVITY_NAME } from '@/features/profile/labels';
import type { ProfileFields } from '@/features/profile/types';
import { userMessage } from '@/lib/errors';
import { registerPushToken } from '@/lib/push/token';
import { canUseRealData } from '@/lib/mode';
import { backOrHome } from '@/lib/nav';
import { cleanupAfterAccountDelete, signOutAndCleanup } from '@/lib/session';
import { listBlocks } from '@/features/social/api';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';
import { colors, size } from '@/theme';

// 그 밖 카드의 누르는 줄 — 이름 · (값) · ›
function LinkRow({ label, value, onPress, first }: { label: string; value?: string; onPress: () => void; first?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.linkRow, !first && styles.linkDivider, pressed && styles.pressed]}
    >
      <Text variant="body">{label}</Text>
      <Text variant="body" tone="sub">
        {value ? `${value} ›` : '›'}
      </Text>
    </Pressable>
  );
}

const PROVIDER_NAME: Record<string, string> = { kakao: '카카오', google: 'Google' };

// 열려 있는 편집 시트 — 집은 지도 고르기 시트(placeOpen)가 따로 맡음
type Editing = 'nickname' | 'handle' | 'sleep' | 'prepare' | 'prepareMlSurvey' | null;

// 설정 — 계정 · 아침 준비 기본값 · 알람 · 로그아웃
// 값 줄을 누르면 편집 시트가 열리고 [저장]하면 profiles에 씀 (실데이터 + 로그인일 때만, 가짜 모드는 보기만)
export default function SettingsScreen() {
  const { session, profile, enabled, refreshProfile } = useAuth();
  const { run } = useAction();
  const blocks = useLoad(listBlocks); // 차단 목록 줄의 사람 수 — 못 읽으면 수 없이 줄만 보임
  const remove = useAction(); // 계정 삭제 연타 막기
  const { snapshot: phone } = usePermissions();
  const notifyOff = phone?.supported === true && phone.notifications === 'off'; // 폰의 알림 권한이 꺼져 있음 — 친구 알림 · 알람 안내가 안 뜸
  const logout = useAction(); // 로그아웃 연타 막기 · 돌아가는 표시 — 프로필 저장 중에 로그아웃 버튼이 같이 돌지 않게 따로
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [purePrepChanged, setPurePrepChanged] = useState(false);
  const [placeOpen, setPlaceOpen] = useState(false);
  const user = session?.user;
  const provider = (user?.app_metadata?.provider as string | undefined) ?? '';
  const userId = enabled ? user?.id : undefined;
  const canEdit = userId != null && profile != null;
  const voiceTone = useVoiceTone(userId, profile?.preferred_voice_tone, refreshProfile); // 말소리 — 누르면 바로 표시 · 미리 듣기 · 저장(실패하면 되돌림)

  const closeEditor = () => setEditing(null);
  const open = (which: Exclude<Editing, null>) => (canEdit ? () => setEditing(which) : undefined);

  // 편집기의 [저장] — 쓰고, 프로필을 다시 읽고, 시트를 닫고, 토스트. 실패하면 시트를 열어 둔 채 토스트 (useAction)
  const saveEdit = (fields: ProfileFields) =>
    run(async () => {
      if (!userId) return;
      const changedPure = fields.default_outing_prep_minutes !== undefined &&
        fields.default_outing_prep_minutes !== profile?.default_outing_prep_minutes;
      await saveProfileFields(userId, fields);
      if (changedPure) setPurePrepChanged(true);
      let note = changedPure ? '순수준비시간을 바꿨어요 · 새 자동 알람에 반영돼요' : '바꿨어요';
      try {
        await refreshProfile();
      } catch {
        note = '바꿨어요 · 화면을 새로 불러오지 못했어요'; // 저장은 됐음 — 실패로 보이지 않게
      }
      closeEditor();
      setPlaceOpen(false);
      toast(note);
    }, '저장하지 못했어요');

  // This editor must receive the real write result. useAction swallows errors, so
  // using saveEdit here could falsely report a consent/save or revocation success.
  const saveMlSurvey = async (fields: ProfileFields) => {
    if (!userId) throw new Error('로그인이 필요해요');
    await saveProfileFields(userId, fields);
    try {
      await refreshProfile();
      toast('바꿨어요');
    } catch {
      toast('저장은 완료됐지만 화면 정보를 다시 읽지 못했어요');
    }
    closeEditor();
  };

  // 계정 삭제 (친구 12장) — 영향 요약을 읽어 확인 두 번, 유예 없이 바로. 확인 창은 한 번에 하나 가드(run) 밖에서
  //   서버가 먼저 지우고(실패하면 이 기기는 그대로, 다시 누르면 이어서 끝냄) 성공하거나 로그인 거절(AUTH_REQUIRED = 이미 지워짐)이면 이 기기를 비우고 로그아웃 → 로그인 화면
  const revokeMlSurvey = async () => {
    if (!(await confirm({
      title: '예측용 프로필 정보를 삭제할까요?',
      message: '입력한 만 나이와 평소 휴무 형태, 예측용 정보 동의를 삭제합니다. 기존 알람에는 영향을 주지 않아요.',
      okLabel: '삭제',
      destructive: true,
    }))) return;
    await saveMlSurvey(EMPTY_PREPARE_ML_SURVEY);
  };

  const deleteAccount = async () => {
    setError(null);
    let summary;
    try {
      summary = await getDeleteSummary();
    } catch {
      setError(DELETE_SUMMARY_FAILED);
      return;
    }
    if (!(await confirm({ ...DELETE_FIRST(summary), destructive: true }))) return;
    if (!(await confirm({ ...DELETE_SECOND, destructive: true }))) return;
    await remove.run(async () => {
      try {
        await deleteMyAccount();
        toast(DELETED_TOAST);
      } catch (e) {
        if (!isAccountGone(e)) throw e;
        toast(ALREADY_DELETED_TOAST); // 서버가 이미 지웠거나 로그인이 끝남 — 이 기기를 비우고 로그인 화면으로
      }
      await cleanupAfterAccountDelete();
    }, DELETE_FAILED);
  };

  const pickHome = (place: PickedPlace) => {
    const patch = homePatchOf(place);
    // 좌표가 없는 장소는 집으로 못 정함 — 이름만 바꾸면 이전 좌표와 어긋나고, 지우면 새 일정의 이동시간 계산이 막힘 (시트는 열어 둠)
    if (!patch) {
      toast('이 장소는 위치를 몰라 집으로 정할 수 없어요. 다른 장소를 골라 주세요');
      return;
    }
    void saveEdit(patch);
  };

  return (
    <Screen>
      <TopBar onBack={backOrHome} screenId="L03" />
      <Text variant="title">설정</Text>

      <SectionHeader title="계정" />
      <Card>
        <KeyValueRow first label="로그인" value={enabled ? (PROVIDER_NAME[provider] ?? (provider || '-')) : '가짜 데이터 모드'} />
        <EditRow label="닉네임" value={profile?.nickname ?? '-'} onPress={open('nickname')} />
        <EditRow label="아이디" value={profile?.handle ? `@${profile.handle}` : '-'} onPress={open('handle')} />
      </Card>

      <LocationAutoSection />

      {profile ? (
        <>
          <SectionHeader title="준비 기본값" />
          <Card>
            <EditRow first label="순수 외출 준비시간" value={profile.default_outing_prep_minutes == null ? '미설정' : `${profile.default_outing_prep_minutes}분`} onPress={open('prepare')} />
            <EditRow label="여유 시간" value={`${profile.default_buffer_minutes}분`} onPress={open('prepare')} />
            <EditRow label="이동 수단" value={TRANSPORT_NAME[profile.default_transport]} onPress={open('prepare')} />
            <EditRow label="집(출발지)" value={profile.home_name ?? '정하지 않았어요'} onPress={canEdit ? () => setPlaceOpen(true) : undefined} />
            {/* 연구용 정보는 한 줄로 합침 (이름 · 안내 문구는 main의 #638 문구) */}
            <EditRow label="준비시간 연구 정보(선택)" value={prepareMlSurveySummary(profile)} onPress={open('prepareMlSurvey')} />
            <Text variant="small" tone="sub">
              선택으로 받는 정보예요. 지금은 알람 계산에 쓰지 않아요.
            </Text>
          </Card>
          {purePrepChanged ? (
            <Card>
              <Text variant="small" tone="sub">
                변경한 순수준비시간은 새 자동 일정의 알람 계산에 반영돼요.
                기존 자동 알람은 자동 변경되지 않으니 알람 상세에서 {"'최신 기본값으로 알람 다시 계산'"}을 눌러 주세요.
                직접 고른 시각과 그룹 일정은 이 동작에서 제외돼요.
              </Text>
              <Button label="기존 자동 알람 재계산하러 가기" onPress={() => router.push('/(tabs)/alarms')} />
            </Card>
          ) : null}

          <SectionHeader title="알람 · 음성" />
          <Card>
            <EditRow first label="잠귀" value={WAKE_SENSITIVITY_NAME[profile.wake_sensitivity]} onPress={open('sleep')} />
            <EditRow label="깨우는 여유" value={WAKE_MARGIN_NAME[profile.wake_margin]} onPress={open('prepare')} />
            <VoiceBriefingSection value={profile.alarm_voice_prefs} tone={voiceTone.tone} onSave={(next) => void saveEdit(next)} onPickTone={voiceTone.pick} disabled={!canEdit} toneDisabled={enabled && !canEdit} />
            {/* 친구가 안 일어났을 때 깨울 수 있게 (친구 8장) — 기본 켬, 꺼 둬도 보낸 쪽에는 '지금은 깨울 수 없어요'만 보임 */}
            {canEdit ? (
              <View style={[styles.pingRow, styles.linkDivider]}>
                <View style={styles.pingText}>
                  <Text variant="body">깨우기 받기</Text>
                  <Text variant="small" tone="sub">
                    같은 그룹 친구가 깨울 수 있어요
                  </Text>
                </View>
                <Toggle value={profile.wake_ping_enabled} onChange={(on) => void saveEdit({ wake_ping_enabled: on })} label="깨우기 받기" />
              </View>
            ) : null}
          </Card>
        </>
      ) : null}

      {profile ? <FrequentPlacesSection center={homeOf(profile)} /> : null}

      {/* 그 밖 — 알람이 잘 울리게 하는 폰 설정 · 차단 목록. 가짜 모드에서도 보임 */}
      <SectionHeader title="그 밖" />
      <Card>
        {profile && notifyOff ? (
          <View style={styles.linkRow}>
            <Text variant="body">알림이 꺼져 있어요</Text>
            <TextLink
              label="켜기"
              onPress={() =>
                void turnOnNotifications('settings').then((result) => {
                  if (result === 'granted') void registerPushToken();
                })
              }
            />
          </View>
        ) : profile ? (
          <LinkRow first label="알림 설정 열기" onPress={() => void openAppNotificationSettings()} />
        ) : null}
        <Pressable
          onPress={() => router.push('/ring-check')}
          accessibilityRole="button"
          accessibilityLabel="알람 권한 점검"
          style={({ pressed }) => [styles.linkRow, profile && styles.linkDivider, pressed && styles.pressed]}
        >
          <View style={styles.pingText}>
            <Text variant="body">알람 권한 점검</Text>
            <Text variant="small" tone="sub">
              알림 · 전체 화면 · 배터리
            </Text>
          </View>
          <Text variant="body" tone="sub">
            ›
          </Text>
        </Pressable>
        <LinkRow label="차단한 사람" value={blocks.data ? `${blocks.data.length}명` : undefined} onPress={() => router.push('/blocks')} />
      </Card>

      {enabled && user ? (
        <View style={styles.stack}>
          <Button
            label="로그아웃"
            variant="ghost"
            loading={logout.busy}
            onPress={() =>
              logout.run(async () => {
                setError(null);
                await signOutAndCleanup().catch((e) => setError(userMessage(e, '로그아웃하지 못했어요')));
              })
            }
          />
          <Button label={DELETE_ACCOUNT_LABEL} variant="danger" loading={remove.busy} onPress={() => void deleteAccount()} />
          {error ? (
            <Text variant="small" tone="warn">
              {error}
            </Text>
          ) : null}
        </View>
      ) : canUseRealData ? null : (
        <Text variant="small">이 빌드에서는 실데이터를 쓸 수 없어 로그인 정보가 없어요.</Text>
      )}

      {/* 편집 시트 — 내용은 루트에서 그려지므로 편집기가 자기 draft를 가짐. 한 번에 하나만 열림 */}
      {profile ? (
        <>
          <Sheet visible={editing === 'nickname'} onClose={closeEditor} title="닉네임">
            <NicknameEditor initial={profile.nickname} onSave={saveEdit} onCancel={closeEditor} />
          </Sheet>
          <ChangeHandleSheet visible={editing === 'handle'} onClose={closeEditor} />
          <Sheet visible={editing === 'sleep'} onClose={closeEditor} title="잠귀">
            <SleepEditor initial={profile.wake_sensitivity} onSave={saveEdit} onCancel={closeEditor} />
          </Sheet>
          <Sheet visible={editing === 'prepare'} onClose={closeEditor} title="아침 준비">
            <PrepareEditor initial={prepareValuesOf(profile)} onSave={saveEdit} onCancel={closeEditor} />
          </Sheet>
          <Sheet visible={editing === 'prepareMlSurvey'} onClose={closeEditor} title="준비시간 예측 연구정보">
            <PrepareMlSurveyEditor
              initial={profile}
              onSave={saveMlSurvey}
              onRevoke={revokeMlSurvey}
              onCancel={closeEditor}
            />
          </Sheet>
        </>
      ) : null}
      {/* 집 — 지도에서 핀으로 고름 (검색 · 현재 위치도 됨). 첫 중심은 지금 집, 없으면 서울 시청 */}
      <MapPlaceSheet
        visible={placeOpen}
        onClose={() => setPlaceOpen(false)}
        onPick={pickHome}
        search={(query) => listPlaces(query, homeOf(profile))}
        reverse={reverseAddress}
        locate={locateOnce}
        center={homeOf(profile)}
        suggestedNames={['집']}
        radius={{ initial: profile?.home_radius_m ?? HOME_RADIUS_M, presets: HOME_RADIUS_PRESETS, hint: '이 원을 벗어나면 집에서 출발한 것으로 기록해요', followPlace: false }}
        areaWarning="캠퍼스 대표 위치예요. 건물을 고르면 더 정확해요"
        title="집 찾기"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 8, marginTop: 16 },
  pingRow: { minHeight: size.touch, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  pingText: { flex: 1, minWidth: 0 },
  linkRow: { minHeight: size.touch, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  linkDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.6 },
});
