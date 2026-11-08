// 가상 유저 일주일 시험 — 친구 · 그룹 · 권한 (모델 호출 0회, 로컬 Supabase만)
//   node run.mjs [--users 6] [--days 7] [--actions 8] [--seed 글자] [--report 경로]
//   필요: 로컬 스택 + 시드 .env (E2E_SEED_ENV). 127.0.0.1이 아니면 멈춤. 시드 데모 계정은 안 건드리고 임시 계정만 만들고 지움
//   끝나는 조건: 위반(VIOLATION) 0 · 이상(ANOMALY) 0 → 종료 코드 0
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import { readCaps } from '../../friend-e2e/caps.mjs';
import { loadEnv } from '../../friend-e2e/env.mjs';
import { RPC as E2E_RPC } from '../../friend-e2e/rpc-map.mjs';
import { ACTIONS } from './actions.mjs';
import { checkGroupVisibility, checkSharedRead, checkState } from './oracle.mjs';
import { makeRng } from './rng.mjs';
import { cleanup, createWorld } from './world.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 함수 이름: friend-e2e의 스위치판 + 세션약속 1절의 3장 이름(스위치판이 아직 비어 있어도 쓰도록). DB에 없으면 그 행동은 빠짐
const RPC = {
  friend_request: 'send_friend_request',
  friend_accept: 'accept_friend_request',
  friend_decline: 'decline_friend_request',
  friend_cancel: 'cancel_friend_request',
  friend_remove: 'remove_friend',
  ...Object.fromEntries(Object.entries(E2E_RPC).filter(([, v]) => v)),
};
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const N = Number(opt('users', 6));
const DAYS = Number(opt('days', 7));
const PER_DAY = Number(opt('actions', 8));
const SEED = opt('seed', 'friend-week-1');

// 가상 유저 것만 서버에서 거름 (로컬 max_rows 1000에 잘리지 않게). keys 중 하나라도 가상 유저면 가져옴
async function readOf(admin, table, keys, ids, cols = '*') {
  const rows = new Map();
  for (const key of keys) {
    const { data, error } = await admin.from(table).select(cols).in(key, ids).limit(1000);
    if (error) throw new Error(`${table} 읽기 실패: ${error.message}`);
    if (data.length >= 1000) throw new Error(`${table}에서 ${key} 기준 1000행이 넘어 잘림 — 가상 유저 수나 일수를 줄여 주세요`);
    for (const r of data) rows.set(JSON.stringify(r), r);
  }
  return [...rows.values()];
}

// 하루가 끝났을 때 DB 전체 + 사람 눈으로 본 결과를 규칙과 맞춰 봄
async function endOfDay({ admin, users, caps, fn }) {
  const ids = users.map((u) => u.id);
  const inSim = (r, ...keys) => keys.every((k) => ids.includes(r[k]));
  const friends = (await readOf(admin, 'friends', ['requester_id', 'addressee_id'], ids)).filter((f) => inSim(f, 'requester_id', 'addressee_id'));
  const hasBlocks = caps.hasTable('user_blocks');
  const blocks = hasBlocks ? (await readOf(admin, 'user_blocks', ['blocker_id', 'blocked_id'], ids)).filter((b) => inSim(b, 'blocker_id', 'blocked_id')) : [];
  const perms = (await readOf(admin, 'sharing_permissions', ['owner_id', 'grantee_id'], ids)).filter((p) => inSim(p, 'owner_id', 'grantee_id'));
  const members = caps.hasTable('group_members') ? await readOf(admin, 'group_members', ['user_id'], ids) : [];
  // 검색 제한(1분 10회)에 걸려 검사가 비지 않게, 하루 끝 검사 전에 가상 유저의 제한 기록을 비움 (가상 유저 것만)
  if (caps.hasTable('rate_limit_events')) await admin.from('rate_limit_events').delete().in('user_id', ids);
  const cover = { visible: 0, hidden: 0, searchChecked: 0, searchLimited: 0, control: 0 };

  const found = checkState({ friends, blocks, perms, hasBlocksTable: hasBlocks });

  // 공유 알람 조회: 모든 순서쌍
  if (caps.hasRpc(fn.shared_alarms)) {
    for (const g of users) {
      for (const o of users) {
        if (g.id === o.id) continue;
        const res = await g.client.rpc(fn.shared_alarms, { p_owner_id: o.id });
        if (res.error) {
          found.push({ kind: 'ANOMALY', rule: '공유 알람 조회가 오류', detail: `${g.name} → ${o.name}: ${res.error.code}` });
          continue;
        }
        const rows = res.data ?? [];
        cover[rows.length ? 'visible' : 'hidden'] += 1;
        found.push(...checkSharedRead({ owner: o.id, grantee: g.id, rows, perms, friends, blocks }));
      }
    }
  }

  // 그룹 노출: 내가 볼 수 있는 그룹은 내 멤버 행이 있는 곳뿐 (SIM 그룹만)
  if (caps.hasTable('groups')) {
    const groupRows = (await admin.from('groups').select('*').like('group_name', 'SIM %').limit(1000)).data ?? [];
    const simGroups = new Set(groupRows.map((g) => g.group_id));
    cover.groups = groupRows.length;
    for (const u of users) {
      const res = await u.client.from('groups').select('group_id');
      if (res.error) {
        found.push({ kind: 'ANOMALY', rule: '그룹 조회가 오류', detail: `${u.name}: ${res.error.code}` });
        continue;
      }
      const visible = res.data.map((g) => g.group_id).filter((g) => simGroups.has(g));
      found.push(...checkGroupVisibility({ me: u.id, visibleGroupIds: visible, members, groups: groupRows }));
    }
  }

  // 차단: 서로 검색이 안 되고, 상대의 내 차단 목록에 내가 안 보임
  for (const b of blocks) {
    const [x, y] = [users.find((u) => u.id === b.blocker_id), users.find((u) => u.id === b.blocked_id)];
    if (caps.hasRpc(fn.search_handle)) {
      for (const [from, to] of [[x, y], [y, x]]) {
        const r = await from.client.rpc(fn.search_handle, { p_query: to.handle });
        const st = r.data?.status;
        if (st === 'LIMIT' || r.error) { cover.searchLimited += 1; continue; }
        cover.searchChecked += 1;
        if (st === 'FOUND') found.push({ kind: 'VIOLATION', rule: 'B-차단 쌍인데 아이디 검색에 나옴', detail: `${from.name} → ${to.name}` });
      }
    }
    // 서로 차단한 쌍이면 상대가 걸어 둔 행이 내 목록에 보이는 게 맞음
    const mutual = blocks.some((o) => o.blocker_id === b.blocked_id && o.blocked_id === b.blocker_id);
    const mine = await y.client.rpc('my_blocks');
    if (!mutual && !mine.error && (mine.data ?? []).some((r) => r.user_id === x.id)) {
      found.push({ kind: 'VIOLATION', rule: 'B-차단당한 사람의 차단 목록에 차단한 사람이 보임', detail: `${y.name} 목록에 ${x.name}` });
    }
  }
  // 대조군: 서로 차단하지 않은 가상 유저는 아이디 검색에 FOUND여야 함 (항상 NOT_FOUND인 고장난 검색이 '위반 0'으로 보이지 않게)
  if (caps.hasRpc(fn.search_handle)) {
    const blockedSet = new Set(blocks.flatMap((b) => [`${b.blocker_id}|${b.blocked_id}`, `${b.blocked_id}|${b.blocker_id}`]));
    const pairs = users.flatMap((x) => users.filter((y) => y.id !== x.id && !blockedSet.has(`${x.id}|${y.id}`)).map((y) => [x, y]));
    const [x, y] = pairs[(users.length * 7 + cover.visible) % Math.max(pairs.length, 1)] ?? [];
    if (x) {
      const r = await x.client.rpc(fn.search_handle, { p_query: y.handle });
      if (r.data?.status === 'FOUND') cover.control += 1;
      else if (r.data?.status !== 'LIMIT') found.push({ kind: 'ANOMALY', rule: '차단 안 한 사람이 아이디 검색에 안 나옴', detail: `${x.name} → ${y.name}: ${r.data?.status ?? r.error?.code}` });
    }
  }
  return { found, cover, counts: { friends: friends.length, accepted: friends.filter((f) => f.status === 'ACCEPTED').length, blocks: blocks.length, perms: perms.filter((p) => p.can_view_alarm).length } };
}

async function main() {
  const env = loadEnv();
  const admin = createClient(env.url, env.serviceKey, NO_SESSION);
  const caps = await readCaps(env.url, env.serviceKey);
  await cleanup(admin);

  const tag = SEED.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'sim';
  let users = [];
  const rng = makeRng(SEED);
  const total = { visible: 0, hidden: 0, searchChecked: 0, searchLimited: 0, control: 0, groupsMade: 0, permsOn: 0, accepted: 0 };
  const available = ACTIONS;
  const anomalies = [];
  const days = [];
  let groups = 0;

  try {
    users = await createWorld({ admin, env, n: N, tag });
    for (let day = 1; day <= DAYS; day += 1) {
      const tally = new Map();
      for (const me of shuffled(rng, users)) {
        for (let k = 0; k < PER_DAY; k += 1) {
          const ctx = { rng, me, users, caps, fn: RPC, admin, anomalies, day, groupCount: () => groups, groupMade: () => { groups += 1; } };
          const usable = available.filter((a) => a.when(ctx));
          if (!usable.length) continue;
          const act = rng.weighted(usable);
          let res;
          try {
            res = await act.run(ctx);
          } catch (e) {
            anomalies.push({ kind: 'ANOMALY', rule: '행동 중 예외', detail: `${act.name}: ${e.message}` });
            res = { status: '예외' };
          }
          if (act.name === '그룹 만들기' && res.status === '됨') total.groupsMade += 1;
          if (act.name === '알람 조회 권한 켜기' && res.status === '됨') total.permsOn += 1;
          if (act.name === '요청 수락' && res.status === 'ACCEPTED') total.accepted += 1;
          const key = `${act.name} → ${res.status}`;
          tally.set(key, (tally.get(key) ?? 0) + 1);
        }
      }
      const eod = await endOfDay({ admin, users, caps, fn: RPC });
      for (const k of ['visible', 'hidden', 'searchChecked', 'searchLimited', 'control']) total[k] += eod.cover[k] ?? 0;
      const today = [...anomalies.splice(0), ...eod.found].map((v) => ({ ...v, day }));
      days.push({ day, tally, counts: eod.counts, violations: today });
      const bad = today.filter((v) => v.kind !== 'KNOWN').length;
      console.log(`${day}일째: 친구 ${eod.counts.accepted} · 차단 ${eod.counts.blocks} · 조회 권한 ${eod.counts.perms} → ${bad === 0 ? '위반 0 · 이상 0' : `위반/이상 ${bad}건`}`);
      for (const v of today) console.log(`   ${v.kind} ${v.rule} — ${v.detail}`);
    }
  } finally {
    await cleanup(admin).catch((e) => console.error(`임시 계정 지우기 실패: ${e.message} — 다시 실행하면 먼저 지움`));
  }

  // 검사량 문턱: 기능이 조용히 빠져서 '위반 0'이 빈 검사로 나오지 않게. DB에 그 기능이 있는데 일주일 동안 한 번도 일어나지 않으면 이상
  const need = [];
  if (caps.hasRpc(RPC.shared_alarms) && caps.hasTable('sharing_permissions')) {
    if (total.visible < 1) need.push('공유 알람이 보이는 조회가 한 번도 없음 (권한 있는 쌍 검사 0)');
    if (total.hidden < 1) need.push('공유 알람이 안 보이는 조회가 한 번도 없음');
    if (total.permsOn < 1) need.push('조회 권한 켜기가 한 번도 성공하지 못함');
  }
  if (caps.hasTable('groups') && total.groupsMade < 1) need.push('그룹 만들기가 한 번도 성공하지 못함 (그룹 노출 검사 0)');
  if (caps.hasRpc(RPC.friend_accept) && total.accepted < 1) need.push('친구 수락이 한 번도 성공하지 못함');
  if (caps.hasRpc(RPC.block_user) && total.searchChecked < 1) need.push('차단 쌍 검색 검사가 한 번도 안 됨');
  if (total.control < 1 && caps.hasRpc(RPC.search_handle)) need.push('검색 대조군(차단 안 한 사람이 FOUND)이 한 번도 안 됨');
  for (const m of need) days[days.length - 1].violations.push({ kind: 'ANOMALY', rule: '검사량 부족', detail: m, day: DAYS });
  const all = days.flatMap((d) => d.violations);
  const nViol = all.filter((v) => v.kind === 'VIOLATION').length;
  const nAnom = all.filter((v) => v.kind === 'ANOMALY').length;
  console.log(`검사량: 공유 알람 보임 ${total.visible} · 안 보임 ${total.hidden} · 차단 쌍 검색 ${total.searchChecked}(제한으로 못 한 ${total.searchLimited}) · 대조군 ${total.control} · 그룹 ${total.groupsMade} · 권한 켜기 ${total.permsOn} · 수락 ${total.accepted}`);
  const nKnown = all.filter((v) => v.kind === 'KNOWN').length;
  console.log(`\n가상 유저 ${N}명 × ${DAYS}일: 권한 위반 ${nViol} · 이상 결과 ${nAnom}`);

  const md = [
    `# 친구 · 그룹 · 권한 가상 유저 일주일 — 씨앗 \`${SEED}\``,
    '',
    `가상 유저 ${N}명 × ${DAYS}일, 하루 사람마다 ${PER_DAY}번 행동 (모델 호출 0회). **권한 위반 ${nViol} · 이상 결과 ${nAnom}** (알려진 동작 ${nKnown}건은 안 셈)`,
    '',
    `검사량: 공유 알람 조회 보임 ${total.visible} · 안 보임 ${total.hidden} / 차단 쌍 검색 ${total.searchChecked}(제한에 걸려 못 한 ${total.searchLimited}) · 대조군 ${total.control} / 그룹 만들기 ${total.groupsMade} · 권한 켜기 ${total.permsOn} · 수락 ${total.accepted}`,
    '',
    `쓴 기능: ${[...new Set(ACTIONS.filter((a) => a.when({ caps, fn: RPC, groupCount: () => 0 })).map((a) => a.name))].join(' · ')}`,
    '',
    ...days.flatMap((d) => [
      `## ${d.day}일째 — 친구 ${d.counts.accepted} · 차단 ${d.counts.blocks} · 조회 권한 ${d.counts.perms}`,
      '',
      '| 행동 → 결과 | 횟수 |',
      '|---|---|',
      ...[...d.tally].sort().map(([k, v]) => `| ${k} | ${v} |`),
      '',
      d.violations.length ? d.violations.map((v) => `- **${v.kind}** ${v.rule} — ${v.detail}`).join('\n') : '위반 0 · 이상 0',
      '',
    ]),
  ].join('\n');
  const out = opt('report', join(HERE, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}.md`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
  console.log(`보고서: ${out}`);
  process.exitCode = nViol + nAnom === 0 ? 0 : 1;
}

function shuffled(rng, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

main().catch((e) => {
  console.error(`시험 실행 실패: ${e.message}`);
  process.exit(2);
});
