import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button, EmptyState, LoadError, Loading, Sheet, Text, toast } from '@/components/ui';
import { userMessage } from '@/lib/errors';
import { colors, radius, size, typeScale } from '@/theme';

import { usePlaceSearch } from '../hooks/usePlaceSearch';
import {
  ADDRESS_FAILED,
  AREA_WARNING,
  DEFAULT_CENTER,
  isSamePin,
  namingPick,
  placeFromPin,
  REVERSE_DELAY_MS,
  REVERSE_TIMEOUT_MS,
  showsAreaWarning,
  type PickedPlace,
} from '../mapPicker';
import { noResultTitle, placeSubtitle } from '../placeSheet';
import type { LatLng, PinAddress, Place } from '../types';
import { MapView } from './MapView';

const DEFAULT_NAMES = ['집', '학교', '회사']; // 이름 칩 (suggestedNames를 안 주면)
const MAP_HEIGHT = 300;

type Props = {
  visible: boolean;
  onClose: () => void;
  onPick: (place: PickedPlace) => void; // [이 위치로 정하기] — Place와 같은 모양 (이름 · 주소 · 좌표). 시트를 닫는 것은 부르는 쪽 (onClose)
  search: (query: string) => Promise<Place[]>; // 장소 이름 검색 (api.ts listPlaces). 어디를 기준으로 가까운 순을 낼지는 부르는 쪽이 정함
  reverse: (lat: number, lng: number) => Promise<PinAddress | null>; // 핀 자리 주소 (api.ts reverseAddress). 못 구한 자리는 null, 실패는 던짐
  locate: () => Promise<LatLng | null>; // 지금 위치 한 번 (location/currentPosition locateOnce). 거절 · 실패는 null
  center?: LatLng; // 처음 중심 — 지금 집 같은 곳. 없으면 서울 시청에서 열고, 핀을 놓기 전에는 [이 위치로 정하기]가 막힘
  suggestedNames?: string[]; // 이름 칩 (기본 집 · 학교 · 회사)
  areaWarning?: string | null; // 캠퍼스 대표 좌표를 골랐을 때 문구 (기본은 캠퍼스 안내, null이면 안 보임). 캠퍼스가 아닌 곳(집)에서는 중립 문구나 null
  title?: string;
};

// 지도에서 위치 고르기 시트 — 맨 위 검색 칸, 가운데 카카오맵(핀 고정, 지도를 끌어 맞춤) + [현재 위치], 아래 핀 자리 주소 · 이름 · [이 위치로 정하기]
// 키가 없어 지도가 안 떠도 검색 결과를 누르면 그 좌표로 정할 수 있음
// <MapPlaceSheet visible={open} onClose={…} onPick={…} search={…} reverse={reverseAddress} locate={locateOnce} center={home} title="집 찾기" />
export function MapPlaceSheet({ visible, onClose, title = '지도에서 고르기', ...body }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <MapPlaceBody {...body} />
    </Sheet>
  );
}

// 핀 자리 주소 — 어느 좌표의 답인지 같이 들고 있어서, 핀이 옮겨졌으면(좌표가 다르면) 아직 찾는 중으로 봄
type PinResult = { lat: number; lng: number; address: PinAddress | null } | { lat: number; lng: number; failed: true };
type Pin = { kind: 'loading' } | { kind: 'done'; address: PinAddress | null } | { kind: 'failed' };

// 시트 안에서 그려지는 본문 — 시트가 열릴 때마다 새로 떠서 상태가 초기화됨 (시트 내용은 루트에서 그려지므로 상태를 여기에 둠)
function MapPlaceBody({ onPick, search, reverse, locate, center, suggestedNames, areaWarning = AREA_WARNING }: Omit<Props, 'visible' | 'onClose' | 'title'>) {
  const [text, setText] = useState(''); // 검색 칸
  const [listOpen, setListOpen] = useState(false); // 검색 결과 목록이 지도 위에 뜸 (글자를 칠 때 열리고, 결과를 고르면 닫힘)
  const [point, setPoint] = useState<LatLng | null>(center ?? null); // 핀이 놓인 자리
  const [picked, setPicked] = useState<Place | null>(null); // 검색 결과로 고른 장소
  const [moveTo, setMoveTo] = useState<{ lat: number; lng: number; nonce: number }>();
  const [mapStatus, setMapStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pinResult, setPinResult] = useState<PinResult | null>(null);
  const [name, setName] = useState(''); // 직접 쓴 이름 · 칩
  const [locating, setLocating] = useState(false);
  const [locateFailed, setLocateFailed] = useState(false);
  const nonce = useRef(0);
  const reverseRef = useRef(reverse);
  const query = text.trim();
  const { result, retry } = usePlaceSearch(search, listOpen ? query : '');

  useEffect(() => {
    reverseRef.current = reverse;
  });

  // 핀이 멈춘 0.4초 뒤에 주소를 찾음 — 핀을 또 움직이면 앞 요청은 취소하고, 늦게 온 옛 응답은 버림
  const lat = point?.lat;
  const lng = point?.lng;
  useEffect(() => {
    if (lat == null || lng == null) return;
    let stale = false;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      // 응답이 영영 안 와도 [이 위치로 정하기]가 막혀 있지 않게 — 시간이 지나면 못 구한 것으로 처리
      giveUp = setTimeout(() => {
        if (!stale) setPinResult({ lat, lng, failed: true });
      }, REVERSE_TIMEOUT_MS);
      Promise.resolve()
        .then(() => reverseRef.current(lat, lng))
        .then(
          (address) => {
            if (!stale) setPinResult({ lat, lng, address });
          },
          () => {
            if (!stale) setPinResult({ lat, lng, failed: true });
          },
        );
    }, REVERSE_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
      clearTimeout(giveUp);
    };
  }, [lat, lng]);

  const goTo = useCallback((to: LatLng) => {
    setPoint({ lat: to.lat, lng: to.lng });
    setMoveTo({ lat: to.lat, lng: to.lng, nonce: ++nonce.current });
  }, []);

  // 지도를 끌어 멈춤 — 핀 자리가 바뀜. 5m 안이면 같은 자리(검색 결과로 옮긴 뒤 지도가 알려 주는 좌표가 소수점 끝만 다른 경우)라 그대로 둠 → 주소를 다시 찾지 않음
  const onCenter = useCallback(
    (la: number, ln: number) => setPoint((prev) => (prev && isSamePin(prev, { lat: la, lng: ln }) ? prev : { lat: la, lng: ln })),
    [],
  );

  const clearSearch = () => {
    setText('');
    setListOpen(false);
  };

  const pickResult = (place: Place) => {
    if (typeof place.lat !== 'number' || typeof place.lng !== 'number') {
      toast('이 장소는 위치를 몰라 지도에 놓을 수 없어요. 다른 장소를 골라 주세요');
      return;
    }
    Keyboard.dismiss();
    setText(place.name);
    setListOpen(false);
    setPicked(place);
    goTo({ lat: place.lat, lng: place.lng });
  };

  const onLocate = async () => {
    if (locating) return;
    setLocating(true);
    let here: LatLng | null = null;
    try {
      here = await locate();
    } catch {
      here = null;
    }
    setLocating(false);
    if (!here) {
      setLocateFailed(true);
      toast('현재 위치를 가져오지 못했어요. 위치 권한을 확인해 주세요');
      return;
    }
    setLocateFailed(false);
    setPicked(null);
    goTo(here);
  };

  const pin: Pin =
    !pinResult || pinResult.lat !== lat || pinResult.lng !== lng ? { kind: 'loading' } : 'failed' in pinResult ? { kind: 'failed' } : { kind: 'done', address: pinResult.address };
  const pinAddress = pin.kind === 'done' ? pin.address : null;
  const naming = namingPick(picked, point);
  // 핀 자리 주소를 찾는 중이면 정하기를 막음 (이름이 주소로 정해질 수 있어서). 검색 결과를 눌러 정한 자리(naming)는 그 이름 · 주소를 쓰므로 기다리지 않음. 실패 · 못 구함은 막지 않음
  const waitingAddress = pin.kind === 'loading' && !naming;
  const confirm = () => {
    if (!point || waitingAddress) return;
    onPick(placeFromPin({ point, typedName: name, picked: naming, pinAddress }));
  };

  const names = suggestedNames ?? DEFAULT_NAMES;
  const canLocate = Platform.OS !== 'web'; // 웹 미리보기는 위치를 못 읽음 — 눌러서 실패하게 하지 않고 처음부터 흐리게
  return (
    <>
      <View style={[styles.box, listOpen && styles.focused]}>
        <Text variant="body" tone="sub" accessibilityElementsHidden importantForAccessibility="no">
          ⌕
        </Text>
        <TextInput
          value={text}
          onChangeText={(next) => {
            setText(next);
            setListOpen(true);
          }}
          onFocus={() => text.trim() && setListOpen(true)}
          autoCorrect={false}
          maxLength={100}
          returnKeyType="search"
          placeholder="장소 이름으로 찾기"
          placeholderTextColor={colors.faint}
          accessibilityLabel="장소 검색"
          style={styles.input}
        />
        {text ? (
          <Pressable onPress={clearSearch} accessibilityRole="button" accessibilityLabel="검색어 지우기" hitSlop={10} style={({ pressed }) => pressed && styles.pressed}>
            <Text variant="body" tone="sub">
              ✕
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.map}>
        <MapView center={center ?? DEFAULT_CENTER} onCenter={onCenter} moveTo={moveTo} onStatus={setMapStatus} />
        {listOpen && query ? (
          <View style={styles.results}>
            <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={styles.resultList}>
              <SearchResults result={result} onPick={pickResult} onRetry={retry} />
            </ScrollView>
            {/* 목록 아래 빈 자리를 누르면 목록을 닫고 지도를 보여 줌 */}
            <Pressable
              onPress={() => {
                Keyboard.dismiss();
                setListOpen(false);
              }}
              accessibilityElementsHidden
              importantForAccessibility="no"
              style={styles.resultsRest}
            />
          </View>
        ) : (
          <Pressable
            onPress={onLocate}
            disabled={locating || !canLocate}
            accessibilityRole="button"
            accessibilityLabel="현재 위치"
            accessibilityState={{ disabled: locating || locateFailed || !canLocate, busy: locating }}
            style={({ pressed }) => [styles.locate, (locateFailed || locating || !canLocate) && styles.dim, pressed && styles.pressed]}
          >
            <Text variant="label" tone="ink">
              ◎ 현재 위치
            </Text>
          </Pressable>
        )}
      </View>

      <View style={styles.pin} accessibilityLiveRegion="polite">
        <Text variant="label">핀 자리</Text>
        {point == null ? (
          <Text variant="body" tone="sub">
            {mapStatus === 'error' ? '위에서 장소를 검색해 골라 주세요' : '지도를 움직여 핀을 놓아 주세요'}
          </Text>
        ) : pin.kind === 'failed' || (pin.kind === 'done' && !pin.address) ? (
          <Text variant="body" tone="sub">
            {ADDRESS_FAILED}
          </Text>
        ) : pin.kind === 'done' ? (
          <>
            {pin.address?.name ? <Text variant="bodyStrong">{pin.address.name}</Text> : null}
            <Text variant={pin.address?.name ? 'small' : 'bodyStrong'} numberOfLines={2}>
              {pin.address?.address}
            </Text>
          </>
        ) : (
          <Text variant="body" tone="sub">
            {naming?.address ?? '주소 찾는 중…'}
          </Text>
        )}
        {areaWarning && showsAreaWarning(picked, point) ? (
          <Text variant="small" tone="warn" style={styles.warn}>
            {areaWarning}
          </Text>
        ) : null}
      </View>

      <Text variant="label" style={styles.nameLabel}>
        이름
      </Text>
      <View style={styles.chips}>
        {names.map((label) => {
          const on = name === label;
          return (
            <Pressable
              key={label}
              onPress={() => setName(on ? '' : label)}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: on }}
              hitSlop={{ top: 8, bottom: 8 }}
              style={[styles.nameChip, on && styles.nameChipOn]}
            >
              <Text variant="label" tone={on ? 'inverse' : 'ink'}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.nameBox}>
        <TextInput
          value={name}
          onChangeText={setName}
          maxLength={40}
          returnKeyType="done"
          placeholder="이름 (비우면 검색한 이름이나 주소로 저장)"
          placeholderTextColor={colors.faint}
          accessibilityLabel="장소 이름"
          style={styles.input}
        />
      </View>

      <Button label={waitingAddress ? '주소 찾는 중…' : '이 위치로 정하기'} onPress={confirm} disabled={!point || waitingAddress} />
    </>
  );
}

function SearchResults({ result, onPick, onRetry }: { result: ReturnType<typeof usePlaceSearch>['result']; onPick: (place: Place) => void; onRetry: () => void }) {
  if (result.kind === 'idle' || result.kind === 'loading') return <Loading />;
  if (result.kind === 'error') return <LoadError message={userMessage(result.error, '장소를 찾지 못했어요')} onRetry={onRetry} />;
  if (!result.places.length) return <EmptyState title={noResultTitle(result.query)} body="다른 이름으로 찾거나 동네 이름을 붙여 보세요" />;
  return (
    <>
      {result.places.map((place, i) => {
        const sub = placeSubtitle(place);
        return (
          <Pressable
            key={`${place.name}-${i}`}
            onPress={() => onPick(place)}
            accessibilityRole="button"
            accessibilityLabel={sub ? `${place.name}, ${sub}` : place.name}
            style={({ pressed }) => [styles.row, i > 0 && styles.divider, pressed && styles.pressed]}
          >
            <Text variant="bodyStrong" numberOfLines={2}>
              {place.name}
            </Text>
            {sub ? (
              <Text variant="label" tone="sub" numberOfLines={2} style={styles.sub}>
                {sub}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 48,
    paddingHorizontal: 14,
    borderRadius: radius.field,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    marginTop: 6,
    marginBottom: 10,
  },
  focused: { borderColor: colors.ink },
  input: { ...typeScale.body, flex: 1, minWidth: 0, color: colors.ink, paddingVertical: 0 },
  map: { height: MAP_HEIGHT, borderRadius: radius.card, overflow: 'hidden', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.chip },
  results: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.card },
  resultList: { flexGrow: 0, flexShrink: 1, paddingHorizontal: 14 },
  resultsRest: { flex: 1, minHeight: 0 },
  row: { paddingVertical: 12, minHeight: 52, justifyContent: 'center' },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  sub: { marginTop: 2 },
  locate: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    minHeight: size.touch,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.shadow,
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  dim: { opacity: 0.5 },
  pressed: { opacity: 0.6 },
  pin: { marginTop: 12, gap: 2 },
  warn: { marginTop: 4 },
  nameLabel: { marginTop: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6, marginBottom: 8 },
  nameChip: {
    height: size.chip + 6,
    paddingHorizontal: 14,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameChipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  nameBox: {
    height: 48,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radius.field,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    marginBottom: 14,
  },
});
