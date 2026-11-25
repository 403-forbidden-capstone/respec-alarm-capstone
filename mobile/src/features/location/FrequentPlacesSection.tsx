import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, confirm, LoadError, Loading, SectionHeader, Sheet, Text, toast } from '@/components/ui';
import { listPlaces, reverseAddress } from '@/features/alarm/api';
import { TextLink } from '@/features/alarm/components/TextLink';
import { MapPlaceSheet } from '@/features/alarm/components/MapPlaceSheet';
import type { PickedPlace } from '@/features/alarm/mapPicker';
import type { LatLng } from '@/features/alarm/types';
import { EditRow } from '@/features/profile/components/EditRow';
import { josa } from '@/lib/format';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';

import { BUILDING_RADIUS_M } from './constants';
import { deleteUserPlace, listUserPlaces, saveUserPlace } from './api';
import { locateOnce } from './currentPosition';
import { DESTINATION_RADIUS_PRESETS } from './radius';
import { cleanLabel, inputFromPick, MAX_USER_PLACES, unusedLabels } from './userPlaces';

type Props = {
  center?: LatLng; // 지도를 처음 열 중심이자 검색 기준점 — 보통 집 (없으면 서울 시청)
};

// 새로 추가할 때 감지 범위의 처음 값(m) — 건물 · 가게 기본값 (area.ts BUILDING_RADIUS_M). 바꾸기는 저장돼 있던 값에서 시작
const PLACE_RADIUS_M = BUILDING_RADIUS_M;

// 지도 시트의 용도 — 새로 추가(replacing 없음) · 이미 있는 곳의 위치 바꾸기(replacing = 그 이름표)
type MapFor = { replacing?: string };

// 설정 "자주 가는 곳" 절 — 학교 · 회사 · 알바 등 최대 5개. 집은 위 "아침 준비 기본값"에서 따로 바꿈
// 줄을 누르면 [바꾸기] [지우기], [+ 추가]는 지도 시트(MapPlaceSheet)에서 고름. 저장 규칙은 userPlaces.ts inputFromPick
// <FrequentPlacesSection center={homeOf(profile)} />
export function FrequentPlacesSection({ center }: Props) {
  const { data, error, reload } = useLoad(listUserPlaces);
  const { run } = useAction();
  const [acting, setActing] = useState<string | null>(null); // 줄을 눌러 [바꾸기] [지우기]를 보는 이름표
  const [mapFor, setMapFor] = useState<MapFor | null>(null);
  const places = data ?? [];
  const full = places.length >= MAX_USER_PLACES;
  const target = places.find((p) => p.label === acting);
  const replacing = mapFor?.replacing;
  const replacingPlace = replacing ? places.find((p) => p.label === replacing) : undefined;
  const mapCenter = replacingPlace ?? center; // 바꾸기는 지금 그 곳에서 열림

  const pick = (picked: PickedPlace) => {
    const input = inputFromPick(picked, replacing);
    // 좌표가 없는 장소는 저장 못 함 — 시트는 열어 둠
    if (!input) {
      toast('이 장소는 위치를 몰라 저장할 수 없어요. 다른 장소를 골라 주세요');
      return;
    }
    const existed = places.some((p) => p.label === cleanLabel(input.label));
    void run(async () => {
      await saveUserPlace(input);
      let note = existed ? '바꿨어요' : '저장했어요';
      if (!(await reload())) note += ' · 목록을 새로 불러오지 못했어요'; // 저장은 됐음 — 실패로 보이지 않게
      setMapFor(null);
      toast(note);
    }, '저장하지 못했어요');
  };

  const remove = async () => {
    if (!target) return;
    const label = target.label;
    if (!(await confirm({ title: `${josa(label, '을', '를')} 지울까요?`, okLabel: '지우기', destructive: true }))) return;
    void run(async () => {
      await deleteUserPlace(label);
      const fresh = await reload();
      setActing(null);
      toast(fresh ? '지웠어요' : '지웠어요 · 목록을 새로 불러오지 못했어요'); // 지우기는 됐음 — 실패로 보이지 않게
    }, '지우지 못했어요');
  };

  return (
    <>
      <SectionHeader title="자주 가는 곳" right={data ? `${places.length}/${MAX_USER_PLACES}` : undefined} />
      {error && !data ? (
        <LoadError onRetry={() => void reload()} />
      ) : !data ? (
        <Loading />
      ) : (
        <Card>
          {places.length ? (
            places.map((p, i) => <EditRow key={p.label} first={i === 0} label={p.label} value={p.name} onPress={() => setActing(p.label)} />)
          ) : (
            <Text variant="body" tone="sub">
              학교나 회사를 지도에서 골라 저장해 두세요
            </Text>
          )}
          <View style={styles.add}>
            <TextLink label="+ 추가" disabled={full} onPress={() => setMapFor({})} />
            {full ? (
              <Text variant="small" tone="sub">
                {MAX_USER_PLACES}개까지 저장할 수 있어요
              </Text>
            ) : null}
          </View>
        </Card>
      )}

      <Sheet visible={target != null} onClose={() => setActing(null)} title={target?.label}>
        <Text variant="body" tone="sub" style={styles.sheetName}>
          {target?.name}
        </Text>
        <View style={styles.actions}>
          <Button
            label="위치 바꾸기"
            variant="ghost"
            onPress={() => {
              setMapFor({ replacing: target?.label });
              setActing(null);
            }}
          />
          <Button label="지우기" variant="danger" onPress={() => void remove()} />
        </View>
      </Sheet>

      {/* 지도에서 고름 — 이름 칸이 이름표. 바꾸기는 이름표를 그대로 두고 위치만 바꿈 */}
      <MapPlaceSheet
        visible={mapFor != null}
        onClose={() => setMapFor(null)}
        onPick={pick}
        search={(query) => listPlaces(query, center)}
        reverse={reverseAddress}
        locate={locateOnce}
        center={mapCenter}
        suggestedNames={replacing ? [replacing] : unusedLabels(places)}
        radius={{ initial: replacingPlace?.radiusM ?? PLACE_RADIUS_M, presets: DESTINATION_RADIUS_PRESETS, hint: '이 원 안에 들어오면 도착으로 기록해요' }}
        areaWarning="캠퍼스 대표 위치예요. 건물을 고르면 더 정확해요"
        title={replacing ? `${replacing} 위치 바꾸기` : '자주 가는 곳 추가'}
      />
    </>
  );
}

const styles = StyleSheet.create({
  add: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  sheetName: { marginBottom: 12 },
  actions: { gap: 8, marginBottom: 8 },
});
