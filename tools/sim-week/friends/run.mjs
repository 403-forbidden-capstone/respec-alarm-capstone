// 가상 유저 일주일 시험 — 친구 · 그룹 · 권한 (모델 호출 0회, 로컬 Supabase만)
//   node run.mjs [--users 6] [--days 7] [--actions 8] [--seed 글자 | --seeds 글자,글자,...] [--report 경로]
//   필요: 로컬 스택 + 시드 .env (E2E_SEED_ENV). 127.0.0.1이 아니면 멈춤. 시드 데모 계정은 안 건드리고 임시 계정만 만들고 지움
//   끝나는 조건: 위반(VIOLATION) 0 · 이상(ANOMALY) 0 → 종료 코드 0
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import { readCaps } from '../../friend-e2e/caps.mjs';
import { loadEnv } from '../../friend-e2e/env.mjs';
import { RPC as E2E_RPC } from '../../friend-e2e/rpc-map.mjs';
import { ACTIONS } from './actions.mjs';
import { checkGroups, checkGroupVisibility, checkMemberRows, checkSharedRead, checkState, checkWakeAndAppointments, checkWakeRows } from './oracle.mjs';
import { retryFetch } from './net.mjs';
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
  group_preview: 'preview_group_by_code',
  group_join: 'join_group',
  group_invite: 'invite_to_group',
  group_accept: 'accept_group_invite',
  wake_hide: 'set_wake_hidden',
  wake_ping: 'plan_wake_ping',
  alarm_suggest: 'propose_alarm_time',
  alarm_suggest_apply: 'respond_alarm_proposal',
  save_group_permissions: 'save_group_permissions',
  ...Object.fromEntries(Object.entries(E2E_RPC).filter(([, v]) => v)),
};
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: retryFetch } };

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const N = Number(opt('users', 6));
const DAYS = Number(opt('days', 7));
const PER_DAY = Number(opt('actions', 8));
const SEED = opt('seed', 'friend-week-1');
const INBOX = ['요청 수락', '초대 수락', '받은 제안 응답'];

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

// 행동 안에서 규칙을 바로 대조할 때 쓰는 현재 상태 (가상 유저 것만)
async function worldState(admin, users, caps) {
  const ids = users.map((u) => u.id);
  const inSim = (r, ...keys) => keys.every((k) => ids.includes(r[k]));
  return {
    members: caps.hasTable('group_members') ? await readOf(admin, 'group_members', ['user_id'], ids) : [],
    hides: caps.hasTable('wake_hides') ? (await readOf(admin, 'wake_hides', ['owner_id', 'hidden_from_id'], ids)).filter((h) => inSim(h, 'owner_id', 'hidden_from_id')) : [],
    blocks: caps.hasTable('user_blocks') ? (await readOf(admin, 'user_blocks', ['blocker_id', 'blocked_id'], ids)).filter((b) => inSim(b, 'blocker_id', 'blocked_id')) : [],
    perms: (await readOf(admin, 'sharing_permissions', ['owner_id', 'grantee_id'], ids)).filter((p) => inSim(p, 'owner_id', 'grantee_id')),
  };
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
  const strict = caps.hasRpc(fn.group_preview); // 5장 함수가 있으면 참여 중만 그룹을 봄
  const cover = { visible: 0, hidden: 0, searchChecked: 0, searchLimited: 0, control: 0, wakeViews: 0, wakeOthers: 0 };

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
    if (strict) found.push(...checkGroups({ groups: groupRows, members: members.filter((m) => simGroups.has(m.group_id)) }));
    for (const u of users) {
      const res = await u.client.from('groups').select('group_id');
      if (res.error) {
        found.push({ kind: 'ANOMALY', rule: '그룹 조회가 오류', detail: `${u.name}: ${res.error.code}` });
        continue;
      }
      const visible = res.data.map((g) => g.group_id).filter((g) => simGroups.has(g));
      found.push(...checkGroupVisibility({ me: u.id, visibleGroupIds: visible, members, groups: groupRows, strict }));
      if (strict) {
        const mem = await u.client.from('group_members').select('group_id, user_id');
        if (mem.error) found.push({ kind: 'ANOMALY', rule: '구성원 조회가 오류', detail: `${u.name}: ${mem.error.code}` });
        else found.push(...checkMemberRows({ me: u.id, rows: mem.data.filter((r) => simGroups.has(r.group_id)), members }));
      }
    }
  }

  // 7 · 9 · 10장: 그룹 기상 줄 노출, 기상 확인 하루 한 건, 앞으로 공동 약속 참여, 제안 합계
  if (caps.hasTable('wake_hides') && caps.hasRpc('get_group_wake')) {
    const hides = (await readOf(admin, 'wake_hides', ['owner_id', 'hidden_from_id'], ids)).filter((h) => inSim(h, 'owner_id', 'hidden_from_id'));
    const groupRows = (await admin.from('groups').select('group_id').like('group_name', 'SIM %').limit(1000)).data ?? [];
    for (const g of groupRows) {
      for (const u of users) {
        const res = await u.client.rpc('get_group_wake', { p_group_id: g.group_id });
        if (res.error) {
          found.push({ kind: 'ANOMALY', rule: '그룹 기상 조회가 오류', detail: `${u.name}: ${res.error.code}` });
          continue;
        }
        cover.wakeViews += 1;
        cover.wakeOthers += (res.data ?? []).filter((x) => !x.is_me).length;
        found.push(...checkWakeRows({ viewer: u.id, groupId: g.group_id, rows: res.data ?? [], members, hides, blocks }));
      }
    }
  }
  if (caps.hasTable('alarm_events') && caps.hasTable('appointments')) {
    const wakeEvents = (await readOf(admin, 'alarm_events', ['user_id'], ids)).filter((e) => e.event_type === 'WAKE_CONFIRMED');
    const alarms = await readOf(admin, 'alarms', ['user_id'], ids);
    const participants = await readOf(admin, 'appointment_participants', ['user_id'], ids);
    const appts = (await admin.from('appointments').select('appointment_id, group_id, appointment_at').like('title', 'SIM %').limit(1000)).data ?? [];
    found.push(...checkWakeAndAppointments({ wakeEvents, alarms, participants, appointments: appts, members }));
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

function kstHourNow() {
  return new Date(Date.now() + 9 * 3600e3).getUTCHours();
}

// 검사량 문턱: 기능이 조용히 빠져서 '위반 0'이 빈 검사로 나오지 않게. DB에 그 기능이 있는데 한 번도 일어나지 않으면 이상
//   --seeds 모드에서는 씨앗 여러 개의 합계로 한 번만 봄 (한 씨앗이 우연히 안 나온 것은 이상이 아님)
function coverageNeeds(total, caps) {
  const need = [];
  if (caps.hasRpc(RPC.shared_alarms) && caps.hasTable('sharing_permissions')) {
    if (total.visible < 1) need.push('공유 알람이 보이는 조회가 한 번도 없음 (권한 있는 쌍 검사 0)');
    if (total.hidden < 1) need.push('공유 알람이 안 보이는 조회가 한 번도 없음');
    if (total.permsOn < 1) need.push('조회 권한 켜기가 한 번도 성공하지 못함');
  }
  if (caps.hasTable('groups') && total.groupsMade < 1) need.push('그룹 만들기가 한 번도 성공하지 못함 (그룹 노출 검사 0)');
  if (caps.hasRpc(RPC.group_preview) && total.previewFound < 1) need.push('코드 미리보기가 맞는 코드에 FOUND를 준 적이 없음 (대조군)');
  if (caps.hasRpc(RPC.group_join) && total.joinedByCode < 1) need.push('코드 참여 함수가 맞는 코드를 알아본 적이 없음 (JOINED · ALREADY_JOINED 둘 다 없음, 대조군)');
  if (caps.hasTable('appointments') && total.apptMade < 1) need.push('공동 약속 만들기가 한 번도 성공하지 못함');
  if (caps.hasTable('appointment_participants') && total.alarmMade < 1) need.push('내 알람 만들기(약속 참여)가 한 번도 성공하지 못함');
  if (caps.hasTable('alarm_events') && total.confirmed < 1) need.push('기상 확인이 한 번도 성공하지 못함');
  // 시작 약속 · 기상 알람은 지금 + 5 · 2시간, 깨우기 판정은 지금 + 3.5시간. KST 20시 이후에 돌리면 이게 다음 날로 넘어가 '오늘' 기준 기상 조회 · 깨우기 판정이 비므로 두 문턱은 건너뜀(보고서에 적음)
  const kstHour = (new Date(Date.now() + 9 * 3600e3)).getUTCHours();
  const lateRun = kstHour >= 20;
  if (lateRun) need.skipped = '실행 시각이 KST 20시 이후라 기상 줄 · 깨우기 판정 문턱은 건너뜀 (약속이 다음 날로 넘어감)';
  if (!lateRun && caps.hasRpc('get_group_wake') && total.wakeOthers < 1) need.push('그룹 기상 조회에서 다른 사람 줄이 한 번도 안 보임 (기상 노출 검사 0)');
  if (caps.hasRpc(RPC.wake_hide) && total.hid < 1) need.push('기상 숨기기가 한 번도 성공하지 못함');
  if (!lateRun && caps.hasRpc(RPC.wake_ping) && total.pingJudged < 1) need.push('깨우기 판정이 FORBIDDEN 아닌 상태로 한 번도 안 나옴');
  if (caps.hasRpc(RPC.alarm_suggest) && total.proposed < 1) need.push('알람 바꾸기 제안이 한 번도 OK가 되지 못함');
  if (caps.hasRpc(RPC.alarm_suggest_apply) && total.responded < 1) need.push('받은 제안 응답이 한 번도 성공하지 못함');
  if (caps.hasRpc(RPC.save_group_permissions) && total.groupPerm < 1) need.push('그룹 권한 저장이 한 번도 OK가 되지 못함');
  if (caps.hasRpc(RPC.group_invite) && total.invited < 1) need.push('그룹 직접 초대가 한 번도 성공하지 못함');
  if (caps.hasRpc(RPC.group_accept) && total.groupAccepted < 1) need.push('그룹 초대 수락이 한 번도 성공하지 못함');
  if (caps.hasRpc(RPC.friend_accept) && total.accepted < 1) need.push('친구 수락이 한 번도 성공하지 못함');
  if (caps.hasRpc(RPC.block_user) && total.searchChecked < 1) need.push('차단 쌍 검색 검사가 한 번도 안 됨');
  if (total.control < 1 && caps.hasRpc(RPC.search_handle)) need.push('검색 대조군(차단 안 한 사람이 FOUND)이 한 번도 안 됨');
  return need;
}

async function main() {
  const env = loadEnv();
  const admin = createClient(env.url, env.serviceKey, NO_SESSION);
  const caps = await readCaps(env.url, env.serviceKey);
  await cleanup(admin);

  const tag = SEED.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'sim';
  let users = [];
  const rng = makeRng(SEED);
  const total = { visible: 0, hidden: 0, searchChecked: 0, searchLimited: 0, control: 0, groupsMade: 0, permsOn: 0, accepted: 0, invited: 0, groupAccepted: 0, previewFound: 0, joinedByCode: 0, apptMade: 0, alarmMade: 0, confirmed: 0, hid: 0, pingJudged: 0, proposed: 0, responded: 0, groupPerm: 0, wakeViews: 0, wakeOthers: 0 };
  const available = ACTIONS;
  const anomalies = [];
  const days = [];
  let groups = 0;
  let appts = 0;

  try {
    users = await createWorld({ admin, env, n: N, tag });
    groups += users.startGroups ?? 0;
    for (let day = 1; day <= DAYS; day += 1) {
      const tally = new Map();
      for (const me of shuffled(rng, users)) {
        // 하루의 시작: 받은 요청 · 초대 · 알람 제안 함 훑어보기 (사람은 받은 것을 대부분 처리함). 모든 기능 문턱이 운에 안 맡겨지게
        const inbox = INBOX.map((name) => available.find((a) => a.name === name)).filter(Boolean).filter(() => rng.chance(0.85));
        for (let k = 0; k < PER_DAY + inbox.length; k += 1) {
          const forced = k < inbox.length ? inbox[k] : null;
          const ctx = { rng, me, users, caps, fn: RPC, admin, anomalies, day, groupCount: () => groups, groupMade: () => { groups += 1; }, apptCount: () => appts, apptMade: () => { appts += 1; }, worldState: () => worldState(admin, users, caps) };
          const usable = available.filter((a) => a.when(ctx));
          if (!usable.length) continue;
          const act = forced && forced.when(ctx) ? forced : rng.weighted(usable);
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
          if (act.name === '그룹에 친구 초대' && res.status === 'INVITED') total.invited += 1;
          if (act.name === '공동 약속 만들기' && res.status === '됨') total.apptMade += 1;
          if (act.name === '내 알람 만들기' && res.status === '됨') total.alarmMade += 1;
          if (act.name === '기상 확인' && res.status === '됨') total.confirmed += 1;
          if (act.name === '기상 숨기기' && res.status === 'OK') total.hid += 1;
          if (act.name === '깨우기 판정' && res.status !== 'FORBIDDEN' && !String(res.status).startsWith('거절')) total.pingJudged += 1;
          if (act.name === '알람 바꾸기 제안' && res.status === 'OK') total.proposed += 1;
          if (act.name === '받은 제안 응답' && ['APPLIED', 'DISMISSED', 'EXPIRED', 'LIMIT'].includes(res.status)) total.responded += 1; // 응답 함수가 대기 제안을 처리함(곧 울릴 시각이 되어 EXPIRED여도)
          if (act.name === '그룹 권한 저장' && res.status === 'OK') total.groupPerm += 1;
          if (act.name === '코드 미리보기' && res.status === 'FOUND') total.previewFound += 1;
          if (act.name === '코드로 참여(함수)' && ['JOINED', 'ALREADY_JOINED'].includes(res.status)) total.joinedByCode += 1; // 맞는 코드를 알아봄(이미 참여 중이어도)
          if (act.name === '초대 수락' && res.status === 'JOINED') total.groupAccepted += 1;
          const key = `${act.name} → ${res.status}`;
          tally.set(key, (tally.get(key) ?? 0) + 1);
        }
      }
      const eod = await endOfDay({ admin, users, caps, fn: RPC });
      for (const k of ['visible', 'hidden', 'searchChecked', 'searchLimited', 'control', 'wakeViews', 'wakeOthers']) total[k] += eod.cover[k] ?? 0;
      const today = [...anomalies.splice(0), ...eod.found].map((v) => ({ ...v, day }));
      days.push({ day, tally, counts: eod.counts, violations: today });
      const bad = today.filter((v) => v.kind !== 'KNOWN').length;
      console.log(`${day}일째: 친구 ${eod.counts.accepted} · 차단 ${eod.counts.blocks} · 조회 권한 ${eod.counts.perms} → ${bad === 0 ? '위반 0 · 이상 0' : `위반/이상 ${bad}건`}`);
      for (const v of today) console.log(`   ${v.kind} ${v.rule} — ${v.detail}`);
    }
  } finally {
    // 깨우기 판정이 남긴 푸시 기록은 사람을 지워도 안 따라 지워질 수 있어 가상 유저 것을 먼저 지움
    if (users.length && caps.hasTable('push_sends')) {
      const set = users.map((u) => u.id).join(',');
      await admin.from('push_sends').delete().or(`sender_id.in.(${set}),target_id.in.(${set}),subject_id.in.(${set})`);
    }
    await cleanup(admin).catch((e) => console.error(`임시 계정 지우기 실패: ${e.message} — 다시 실행하면 먼저 지움`));
  }

  // 검사량 문턱: 기능이 조용히 빠져서 '위반 0'이 빈 검사로 나오지 않게. DB에 그 기능이 있는데 일주일 동안 한 번도 일어나지 않으면 이상
  const TOTAL_OUT = opt('total-out', null); // --seeds 모드의 자식 실행: 문턱은 합쳐서 한 번만 보므로 여기선 안 봄
  const lateRun = kstHourNow() >= 20;
  const need = TOTAL_OUT ? [] : coverageNeeds(total, caps);
  if (TOTAL_OUT) {
    mkdirSync(dirname(TOTAL_OUT), { recursive: true });
    writeFileSync(TOTAL_OUT, JSON.stringify({ seed: SEED, total, lateRun }));
  }
  if (need.skipped) console.log(`참고: ${need.skipped}`);
  for (const m of need) days[days.length - 1].violations.push({ kind: 'ANOMALY', rule: '검사량 부족', detail: m, day: DAYS });
  const all = days.flatMap((d) => d.violations);
  const nViol = all.filter((v) => v.kind === 'VIOLATION').length;
  const nAnom = all.filter((v) => v.kind === 'ANOMALY').length;
  console.log(`검사량: 공유 알람 보임 ${total.visible} · 안 보임 ${total.hidden} · 차단 쌍 검색 ${total.searchChecked}(제한으로 못 한 ${total.searchLimited}) · 대조군 ${total.control} · 그룹 ${total.groupsMade} · 권한 켜기 ${total.permsOn} · 수락 ${total.accepted} · 그룹 초대 ${total.invited} · 초대 수락 ${total.groupAccepted} · 미리보기 FOUND ${total.previewFound} · 코드 참여 ${total.joinedByCode} · 공동 약속 ${total.apptMade} · 내 알람 ${total.alarmMade} · 기상 확인 ${total.confirmed} · 기상 줄 ${total.wakeOthers} · 숨기기 ${total.hid} · 깨우기 판정 ${total.pingJudged} · 제안 ${total.proposed}/응답 ${total.responded} · 그룹 권한 ${total.groupPerm}`);
  const nKnown = all.filter((v) => v.kind === 'KNOWN').length;
  console.log(`\n가상 유저 ${N}명 × ${DAYS}일: 권한 위반 ${nViol} · 이상 결과 ${nAnom}`);

  const md = [
    `# 친구 · 그룹 · 권한 가상 유저 일주일 — 씨앗 \`${SEED}\``,
    '',
    `가상 유저 ${N}명 × ${DAYS}일, 하루 사람마다 ${PER_DAY}번 행동 (모델 호출 0회). **권한 위반 ${nViol} · 이상 결과 ${nAnom}** (알려진 동작 ${nKnown}건은 안 셈)`,
    '',
    `검사량: 공유 알람 조회 보임 ${total.visible} · 안 보임 ${total.hidden} / 차단 쌍 검색 ${total.searchChecked}(제한에 걸려 못 한 ${total.searchLimited}) · 대조군 ${total.control} / 그룹 만들기 ${total.groupsMade} · 권한 켜기 ${total.permsOn} · 수락 ${total.accepted} · 그룹 초대 ${total.invited} · 초대 수락 ${total.groupAccepted} · 미리보기 FOUND ${total.previewFound} · 코드 참여 ${total.joinedByCode}`,
    `기상 · 약속: 공동 약속 ${total.apptMade} · 내 알람 ${total.alarmMade} · 기상 확인 ${total.confirmed} · 기상 줄 ${total.wakeOthers} · 숨기기 ${total.hid} · 깨우기 판정 ${total.pingJudged} · 제안 ${total.proposed}/응답 ${total.responded} · 그룹 권한 저장 ${total.groupPerm}`,
    '',
    `쓴 기능: ${[...new Set(ACTIONS.filter((a) => a.when({ caps, fn: RPC, groupCount: () => 0, apptCount: () => 0 })).map((a) => a.name))].join(' · ')}`,
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

// --seeds a,b,c : 씨앗마다 한 번씩 돌리고(각자 위반 · 이상 검사는 그대로), 검사량 문턱은 합계로 한 번만 봄
async function runSeeds(seeds) {
  const env = loadEnv();
  const caps = await readCaps(env.url, env.serviceKey);
  const dir = join(tmpdir(), `sim-friends-seeds-${process.pid}`);
  const sum = Object.fromEntries(Object.keys({ visible: 0, hidden: 0, searchChecked: 0, searchLimited: 0, control: 0, groupsMade: 0, permsOn: 0, accepted: 0, invited: 0, groupAccepted: 0, previewFound: 0, joinedByCode: 0, apptMade: 0, alarmMade: 0, confirmed: 0, hid: 0, pingJudged: 0, proposed: 0, responded: 0, groupPerm: 0, wakeViews: 0, wakeOthers: 0 }).map((k) => [k, 0]));
  let bad = 0;
  let late = false;
  const passthrough = [];
  for (const k of ['users', 'days', 'actions']) if (opt(k, null) != null) passthrough.push(`--${k}`, opt(k));
  for (const seed of seeds) {
    const out = join(dir, `${seed}.json`);
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--seed', seed, '--total-out', out, ...passthrough], { stdio: 'inherit' });
      child.on('exit', (c) => resolve(c ?? 1));
    });
    if (code === 2) throw new Error(`씨앗 ${seed} 실행이 시작도 못 하고 실패함`);
    if (code !== 0) bad += 1;
    const r = JSON.parse(readFileSync(out, 'utf8'));
    for (const k of Object.keys(sum)) sum[k] += r.total[k] ?? 0;
    late ||= r.lateRun;
  }
  rmSync(dir, { recursive: true, force: true });
  const need = coverageNeeds(sum, caps);
  console.log(`
=== 씨앗 ${seeds.length}개 합계 (${seeds.join(' · ')}) ===`);
  console.log(`공유 알람 보임 ${sum.visible} · 안 보임 ${sum.hidden} · 차단 쌍 검색 ${sum.searchChecked} · 그룹 ${sum.groupsMade} · 공동 약속 ${sum.apptMade} · 기상 확인 ${sum.confirmed} · 기상 줄 ${sum.wakeOthers} · 숨기기 ${sum.hid} · 깨우기 판정 ${sum.pingJudged} · 제안 ${sum.proposed}/응답 ${sum.responded} · 그룹 권한 ${sum.groupPerm}`);
  if (need.skipped) console.log(`참고: ${need.skipped}`);
  for (const m of need) console.log(`ANOMALY 검사량 부족(합계) — ${m}`);
  console.log(`씨앗 ${seeds.length}개: 위반 · 이상이 있었던 씨앗 ${bad}개 · 합계 문턱 부족 ${need.length}건`);
  process.exitCode = bad + need.length === 0 ? 0 : 1;
}

const SEEDS = opt('seeds', null);
(SEEDS ? runSeeds(SEEDS.split(',').map((x) => x.trim()).filter(Boolean)) : main()).catch((e) => {
  console.error(`시험 실행 실패: ${e.message}`);
  process.exit(2);
});
