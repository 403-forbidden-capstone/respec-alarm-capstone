// 시나리오 도우미 — 하루를 따라가며 "사건 하나 뒤에 같이 바뀌어야 할 곳이 다 바뀌었나"를 읽기 쉽게 적는 틀
//
//   const early = scenario('S04 먼저 깼어요').variant('정상').at('08:34').given(async () => { ... }).do(async () => { ... });
//   early.expect({ phoneAlarms: ['PREPARE@08:00', 'DEPARTURE@08:40'], tray: [], writes: ['alarm_events.upsert(WAKE_CONFIRMED/BUTTON)'] });
//   early.gap('G3').expect({ ... })          // 알려진 빈틈: 정답지가 요구하는 값을 적되, 지금은 틀려서 it.failing — 고치면 뒤집힘
//   early.limit('앱 열림만').expect({ ... })  // 알려진 한계: 앱이 꺼진 상태에서는 그 칸이 안 바뀐다는 것을 확인
//   early.news(1).expect({ ... })            // 정답지에 없던 새 빈틈
//   빌더는 호출할 때마다 새 값을 돌려줘서 같은 사건에 여러 번 expect를 붙일 수 있음 (정상 칸 / 빈틈 칸을 나눠 적어 서로 가리지 않게)
import { afterAll, afterEach, beforeEach, expect as jestExpect, it, jest } from '@jest/globals';

import { db } from './fakeDb';
import { phone } from './phone';
import { endWorld, nativeWriteLines, phoneAlarms, resetWorld, rpcLines, writeLines, clock } from './world';

export type Expectation = {
  phoneAlarms?: string[]; // 폰 알람 예약 — 'WAKE@07:20' 시각 순 그대로, 정확히 같아야 함
  tray?: string[]; // 알림창에 떠 있는 알림 id (notice:<알람 id> · wakeprompt:<알람 id> · expo:<번호>) — 정확히 같아야 함
  writes?: (string | RegExp)[]; // 앱이 서버에 쓴 줄 — 모두 있어야 함
  noWrites?: (string | RegExp)[]; // 앱이 서버에 쓴 줄 — 하나도 없어야 함
  nativeWrites?: (string | RegExp)[]; // 폰 네이티브가 앱 없이 서버에 쓴 줄 — 모두 있어야 함
  noNativeWrites?: (string | RegExp)[];
  rpcs?: string[]; // 앱이 부른 서버 RPC 이름 — 모두 있어야 함
  nativeLog?: (string | RegExp)[]; // 네이티브가 한 일 — 모두 있어야 함
  noNativeLog?: (string | RegExp)[];
  check?: () => void | Promise<void>; // 그 밖의 확인 (jest expect를 그대로)
};

const has = (lines: string[], token: string | RegExp) => lines.some((line) => (typeof token === 'string' ? line === token || line.startsWith(token) : token.test(line)));

async function verify(exp: Expectation) {
  if (exp.phoneAlarms) jestExpect(await phoneAlarms()).toEqual(exp.phoneAlarms);
  if (exp.tray) jestExpect(phone.trayIds()).toEqual([...exp.tray].sort());
  const lines = writeLines();
  for (const token of exp.writes ?? []) jestExpect({ token: String(token), found: has(lines, token), lines }).toMatchObject({ found: true });
  for (const token of exp.noWrites ?? []) jestExpect({ token: String(token), found: has(lines, token), lines }).toMatchObject({ found: false });
  const native = nativeWriteLines();
  for (const token of exp.nativeWrites ?? []) jestExpect({ token: String(token), found: has(native, token), native }).toMatchObject({ found: true });
  for (const token of exp.noNativeWrites ?? []) jestExpect({ token: String(token), found: has(native, token), native }).toMatchObject({ found: false });
  const rpcs = rpcLines();
  for (const name of exp.rpcs ?? []) jestExpect(rpcs).toContain(name);
  for (const token of exp.nativeLog ?? []) jestExpect({ token: String(token), found: has(phone.nativeLog, token), log: phone.nativeLog }).toMatchObject({ found: true });
  for (const token of exp.noNativeLog ?? []) jestExpect({ token: String(token), found: has(phone.nativeLog, token), log: phone.nativeLog }).toMatchObject({ found: false });
  await exp.check?.();
}

type Step = () => unknown; // 값을 돌려줘도 쓰지 않음 (await만)
type Tag = { kind: 'gap' | 'new' | 'limit'; label: string } | null;

class Scenario {
  constructor(
    private readonly title: string,
    private readonly variantLabel: string | null = null,
    private readonly startAt: string | null = null,
    private readonly givens: readonly Step[] = [],
    private readonly steps: readonly Step[] = [],
    private readonly tag: Tag = null,
  ) {}

  private next(patch: Partial<{ variantLabel: string | null; startAt: string | null; givens: readonly Step[]; steps: readonly Step[]; tag: Tag }>) {
    return new Scenario(this.title, patch.variantLabel ?? this.variantLabel, patch.startAt ?? this.startAt, patch.givens ?? this.givens, patch.steps ?? this.steps, patch.tag === undefined ? this.tag : patch.tag);
  }

  variant(label: string) {
    return this.next({ variantLabel: label });
  }
  // 이 시각에서 시작 — 한국 시각 'HH:mm'
  at(time: string) {
    return this.next({ startAt: time });
  }
  // 사건 전에 이미 그런 상태 (서버 시드 · 폰에 걸린 알람 · 앱 상태)
  given(step: Step) {
    return this.next({ givens: [...this.givens, step] });
  }
  // 사건 — 여러 번 이어 붙이면 순서대로
  do(step: Step) {
    return this.next({ steps: [...this.steps, step] });
  }
  gap(id: string) {
    return this.next({ tag: { kind: 'gap', label: id } });
  }
  news(n: number) {
    return this.next({ tag: { kind: 'new', label: `NEW-${n}` } });
  }
  limit(label: string) {
    return this.next({ tag: { kind: 'limit', label } });
  }

  expect(exp: Expectation) {
    const name = [this.title, this.variantLabel].filter(Boolean).join(' · ') + (this.tag ? ` [${this.tag.kind === 'limit' ? `한계 ${this.tag.label}` : this.tag.label}]` : '');
    const body = async () => {
      if (this.startAt) clock.set(this.startAt);
      for (const step of this.givens) await step();
      for (const step of this.steps) await step();
      await verify(exp);
    };
    // 알려진 빈틈(G · NEW)은 정답지 값을 적은 시험이 지금은 틀려야 함 — 고쳐져서 통과하면 it.failing이 실패해 뒤집으라고 알려 줌
    //   SCENARIO_GAPS=show 로 돌리면 빈틈 시험도 보통 시험으로 돌아 왜 틀리는지(실패 메시지)를 볼 수 있음
    if (this.tag && (this.tag.kind === 'gap' || this.tag.kind === 'new') && process.env.SCENARIO_GAPS !== 'show') it.failing(name, body);
    else it(name, body);
    return this;
  }
}

export function scenario(title: string) {
  return new Scenario(title);
}

// 시험 파일 맨 위(describe 안)에서 한 번 부름 — 시험마다 세계를 처음 상태로
export function useWorld() {
  beforeEach(async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {}); // 오프라인 시험의 개발용 경고 로그를 조용히
    await resetWorld();
  });
  afterEach(async () => {
    await endWorld();
    jest.restoreAllMocks();
  });
  afterAll(() => {
    db.reset();
  });
}
