import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { EmptyState, LoadError, Loading, Sheet, Text } from '@/components/ui';
import { userMessage } from '@/lib/errors';
import { colors, radius, typeScale } from '@/theme';

import { noResultTitle, placeSubtitle, SEARCH_DELAY_MS } from '../placeSheet';
import type { Place } from '../types';

type Props = {
  visible: boolean;
  onClose: () => void;
  onPick: (place: Place) => void; // 장소 줄을 누르면 — 시트를 닫는 것은 부르는 쪽 (onClose)
  search: (query: string) => Promise<Place[]>; // 검색어가 비면 '최근 장소'를 돌려주는 함수 (api.ts listPlaces). 어디를 기준으로 가까운 순을 낼지는 부르는 쪽이 정함
  title?: string;
};

// 장소 검색 시트 — 맨 위 검색 칸, 아래로 결과 줄. 0.3초 입력이 멈추면 search를 부르고, 검색어가 비면 최근 장소
// <PlaceSearchSheet visible={open} onClose={…} onPick={…} search={(q) => listPlaces(q, home)} />
export function PlaceSearchSheet({ visible, onClose, onPick, search, title = '장소 찾기' }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <PlaceSearchBody search={search} onPick={onPick} />
    </Sheet>
  );
}

// 시트 안에서 그려지는 본문 — 시트가 열릴 때마다 새로 떠서 검색어 · 결과가 비워지고, 닫히면 사라짐
// (시트 내용은 루트에서 그려지므로 상태를 여기에 둠. 부모가 다시 그려져도 입력은 그대로)
type Result = { kind: 'loading' } | { kind: 'done'; query: string; places: Place[] } | { kind: 'error'; query: string; error: unknown };

function PlaceSearchBody({ search, onPick }: Pick<Props, 'search' | 'onPick'>) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [result, setResult] = useState<Result>({ kind: 'loading' });
  const searchRef = useRef(search); // 부모가 새 함수를 줘도(집 좌표가 늦게 읽힘 등) 다음 검색부터 그걸 씀
  const seq = useRef(0); // 마지막 요청 번호 — 늦게 온 옛 응답이 새 응답을 덮지 않게

  useEffect(() => {
    searchRef.current = search;
  });

  const run = useCallback((query: string) => {
    const id = ++seq.current;
    setResult({ kind: 'loading' });
    Promise.resolve()
      .then(() => searchRef.current(query))
      .then(
        (places) => {
          if (id === seq.current) setResult({ kind: 'done', query, places });
        },
        (error: unknown) => {
          if (id === seq.current) setResult({ kind: 'error', query, error });
        },
      );
  }, []);

  // 처음(빈 검색어 = 최근 장소)은 바로, 글자를 칠 때는 멈춘 뒤에. 앞뒤 공백만 달라진 것은 다시 찾지 않음
  const query = text.trim();
  useEffect(() => {
    const timer = setTimeout(() => run(query), query ? SEARCH_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [query, run]);

  // 시트를 닫으면 아직 오는 중인 응답은 버림
  useEffect(() => {
    const requests = seq;
    return () => {
      requests.current += 1;
    };
  }, []);

  return (
    <>
      <View style={[styles.box, focused && styles.focused]}>
        <Text variant="body" tone="sub" accessibilityElementsHidden importantForAccessibility="no">
          ⌕
        </Text>
        <TextInput
          value={text}
          onChangeText={setText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoFocus
          autoCorrect={false}
          maxLength={100}
          returnKeyType="search"
          placeholder="장소 이름으로 찾기"
          placeholderTextColor={colors.faint}
          accessibilityLabel="장소 검색"
          maxFontSizeMultiplier={1.3}
          style={styles.input}
        />
      </View>
      {result.kind === 'loading' ? <Loading /> : null}
      {result.kind === 'error' ? (
        // 못 읽은 이유(키 없음 · 잠시 안 됨 · 인터넷)를 보임 — UserError면 그 문구, 아니면 기본 문구
        <LoadError message={userMessage(result.error, '장소를 찾지 못했어요')} onRetry={() => run(result.query)} />
      ) : null}
      {result.kind === 'done' ? <Results query={result.query} places={result.places} onPick={onPick} /> : null}
    </>
  );
}

function Results({ query, places, onPick }: { query: string; places: Place[]; onPick: (place: Place) => void }) {
  if (!places.length) {
    return query ? (
      <EmptyState title={noResultTitle(query)} body="다른 이름으로 찾거나 동네 이름을 붙여 보세요" />
    ) : (
      <EmptyState title="최근 장소가 없어요" body="이름으로 찾아 보세요" />
    );
  }
  return (
    <>
      {query ? null : (
        <Text variant="label" tone="sub" style={styles.head}>
          최근 장소
        </Text>
      )}
      {places.map((place, i) => {
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
    minHeight: 48,
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
  head: { marginBottom: 2 },
  row: { paddingVertical: 12, minHeight: 52, justifyContent: 'center' },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.6 },
  sub: { marginTop: 2 },
});
