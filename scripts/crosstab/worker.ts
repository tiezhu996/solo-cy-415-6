/*
 * 多标签页竞争测试的"页面"工作器：每个都是独立子进程（独立 JS 领域、各自的页内锁，
 * 只通过磁盘上的同一份 localStorage 与文件锁交互）。
 *
 * 模式（环境变量）：
 *   MODE=seed     写入同一份初始快照（SELECTED，等待终态动作）
 *   MODE=contend  两个页面从同一快照启动，过启动栅栏后同时提交各自的终态动作
 *                   ROLE=confirm -> 发起方确认锁定；ROLE=cancel -> 接收方取消
 *   MODE=read     重新加载，导出最终可回读状态（版本、占用、事件链）
 */
import { writeFileSync } from 'node:fs';

import { FsBarrier } from './barrier';
import { installFailingCrossTabLock, installFileCrossTabLock } from './file-lock';
import { installFileLocalStorage } from './file-local-storage';
import { FIXTURE, buildAcceptedExchange, buildSelectedMeetupSnapshot } from './fixtures';

import { meetupApi } from '@/api/meetupApi';
import { MeetupStatus } from '@/constants/meetup';
import { CrossTabLockError } from '@/utils/crossTabLock';
import { STORAGE_KEYS, storage } from '@/utils/storage';
import type { MeetupEvent } from '@/models/meetup';

const env = process.env;
const DATA_FILE = env.DATA_FILE!;
const LOCK_DIR = env.LOCK_DIR!;
const BARRIER_DIR = env.BARRIER_DIR!;
const BARRIER_PARTIES = Number(env.BARRIER_PARTIES ?? '2');
const OUT_FILE = env.OUT_FILE!;

// 必须最先安装：真实跨页文件存储 + 等价于 navigator.locks 的跨页锁。
// LOCK_MODE：
//   file（默认）真实文件锁；failing 建锁必失败（模拟互斥建立失败）；
//   none 不安装任何跨页后端（Node 无 navigator.locks，模拟互斥能力不可用）。
installFileLocalStorage(DATA_FILE);
if (env.LOCK_MODE === 'failing') {
  installFailingCrossTabLock();
} else if (env.LOCK_MODE !== 'none') {
  installFileCrossTabLock(LOCK_DIR);
}

const emit = (payload: unknown) => writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));

const snapshotView = (meetupId: string) =>
  storage.get(STORAGE_KEYS.meetups, []).then(async (all) => {
    const meetup = all.find((item: { id: string }) => item.id === meetupId);
    const events = await storage.get<MeetupEvent[]>(STORAGE_KEYS.meetupEvents, []);
    return { meetup, events: events.filter((event) => event.meetup_id === meetupId) };
  });

const seed = async () => {
  // 先把三个键写齐（真实应用 storage 信封格式），后续读取完全走 localStorage 路径。
  await storage.commitBatch({
    [STORAGE_KEYS.exchanges]: [buildAcceptedExchange()],
  });
  const { meetups, events } = buildSelectedMeetupSnapshot();
  await storage.commitBatch({
    [STORAGE_KEYS.meetups]: meetups,
    [STORAGE_KEYS.meetupEvents]: events,
  });
  const view = await snapshotView(FIXTURE.meetupId);
  emit({ mode: 'seed', ok: true, ...view });
};

const contend = async () => {
  const role = env.ROLE as 'confirm' | 'cancel';
  // 每个页面独立从同一份本地快照"启动"：先各自读一份当前预约与版本。
  const before = (await storage.get(STORAGE_KEYS.meetups, [])) as Array<{ id: string; version: number }>;
  const expectedVersion = before.find((item) => item.id === FIXTURE.meetupId)?.version;

  // 所有参与进程都就位后再一起放行，制造近同时提交（恢复场景只有单方时 parties=1）。
  await new FsBarrier(BARRIER_DIR, BARRIER_PARTIES).arriveAndWait(`${role}-${env.PARTY ?? ''}`);

  let result: unknown = null;
  let ok = true;
  let error = '';
  let errorKind: 'lock' | 'business' | '' = '';
  try {
    if (role === 'confirm') {
      result = await meetupApi.confirm(FIXTURE.meetupId, FIXTURE.fromUser, expectedVersion);
    } else {
      result = await meetupApi.cancel(FIXTURE.meetupId, FIXTURE.toUser, undefined, expectedVersion);
    }
  } catch (e) {
    ok = false;
    if (e instanceof CrossTabLockError) errorKind = 'lock';
    else errorKind = 'business';
    error = e instanceof Error ? e.message : String(e);
  }

  // 提交后重新加载，记录本页面此刻能回读到的状态。
  const view = await snapshotView(FIXTURE.meetupId);
  emit({
    mode: 'contend',
    role,
    lockMode: env.LOCK_MODE ?? 'file',
    ok,
    error,
    errorKind,
    expectedVersion,
    returned: result,
    reread: view.meetup,
    eventTypes: view.events.map((event) => event.type),
  });
};

const read = async () => {
  const view = await snapshotView(FIXTURE.meetupId);
  const meetup = view.meetup as
    | (Awaited<ReturnType<typeof snapshotView>>['meetup'] & {
        status: MeetupStatus;
        version: number;
        locked_slot: unknown;
        selected_slot: unknown;
      })
    | undefined;

  // 重新加载后统计：同一物品同一时段被几条有效预约（SELECTED/LOCKED）占用。
  const all = await storage.get(STORAGE_KEYS.meetups, []);
  const targetStart = FIXTURE.slot.start_at;
  const holders = all.filter((m: {
    status: string;
    locked_slot?: { start_at?: string } | null;
    selected_slot?: { start_at?: string } | null;
    item_ids?: string[];
  }) => {
    if (!['selected', 'locked'].includes(m.status)) return false;
    const held = m.status === 'selected' ? m.selected_slot : m.locked_slot;
    return held?.start_at === targetStart && (m.item_ids ?? []).some((id) => FIXTURE.fromItem === id || FIXTURE.toItem === id);
  });

  const terminal = view.events.filter((event) =>
    ['confirmed', 'rescheduled', 'cancelled'].includes(event.type),
  );

  emit({
    mode: 'read',
    status: meetup?.status ?? null,
    version: meetup?.version ?? null,
    lockedSlot: meetup?.locked_slot ?? null,
    selectedSlot: meetup?.selected_slot ?? null,
    holdersCount: holders.length,
    events: view.events.map((event) => ({
      type: event.type,
      actor: event.actor_user_id,
      round: event.round,
      hasSlot: Boolean(event.slot),
      hasReleased: Boolean(event.released_slot),
    })),
    terminalEventTypes: terminal.map((event) => event.type),
  });
};

const main = async () => {
  if (env.MODE === 'seed') await seed();
  else if (env.MODE === 'contend') await contend();
  else if (env.MODE === 'read') await read();
};

main().catch((error) => {
  emit({ mode: env.MODE ?? 'unknown', ok: false, fatal: String(error?.stack ?? error) });
  process.exitCode = 1;
});
