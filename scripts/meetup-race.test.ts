/* 临时并发正确性测试：用内存 storage 替身驱动真实 meetupApi / meetupWriteLock。 */
import { commitLocalBatch, storage, STORAGE_KEYS } from '@/utils/storage';
import { meetupApi } from '@/api/meetupApi';
import { ExchangeStatus } from '@/constants/exchange';
import { MeetupEventType, MeetupStatus } from '@/constants/meetup';
import { CrossTabLockError } from '@/utils/crossTabLock';
import type { Exchange } from '@/models/exchange';
import type { Meetup, MeetupEvent, MeetupSlot } from '@/models/meetup';

// ---- 内存 storage 替身 ----
const mem = new Map<string, unknown>();
// 故障注入：置 true 后下一次原子提交整体失败（不写入任何键），用于验证回滚。
let commitShouldFail = false;
(storage as any).get = async <T,>(key: string, fallback: T): Promise<T> =>
  (mem.has(key) ? structuredClone(mem.get(key)) : fallback) as T;
(storage as any).set = async <T,>(key: string, payload: T): Promise<T> => {
  mem.set(key, structuredClone(payload));
  return payload;
};
// 与真实 storage.commitBatch 同契约：要么全部键生效，要么一个都不动并抛错。
(storage as any).commitBatch = async (batch: Record<string, unknown>) => {
  if (commitShouldFail) throw new Error('simulated storage failure');
  for (const [key, payload] of Object.entries(batch)) mem.set(key, structuredClone(payload));
};
(storage as any).remove = async (key: string) => {
  mem.delete(key);
};
let seq = 0;
(storage as any).createId = (p: string) => `${p}_t${++seq}`;

// ---- 跨页锁替身 ----
// Node 里没有 navigator.locks：默认装一个"可用且健康"的适配器（单领域内直接放行，
// 页内 AsyncMutex 仍负责串行），与单个标签页里 Web Locks 正常时的行为一致。
const passthroughLock = { runExclusive: async <T,>(_name: string, fn: () => Promise<T>) => fn() };
const failingLock = {
  runExclusive: async () => {
    throw new CrossTabLockError('模拟：跨页互斥建立失败');
  },
};
const setLockAvailable = (available: boolean) => {
  (globalThis as Record<string, unknown>).__RESWAP_CROSS_TAB_LOCK__ = available ? passthroughLock : failingLock;
};
setLockAvailable(true);

const hoursFromNow = (h: number, place = '地铁口'): MeetupSlot => {
  const start = new Date(Date.now() + h * 3600_000);
  return { start_at: start.toISOString(), end_at: new Date(start.getTime() + 2 * 3600_000).toISOString(), place };
};
// 固定候选，保证 key 在多次读取间一致。
const SLOT_A = hoursFromNow(48);
const SLOT_B = hoursFromNow(72);
const SLOT_C = hoursFromNow(96);
const SLOT_D = hoursFromNow(120);
const keyOf = (s: MeetupSlot) => new Date(s.start_at).getTime().toString();
const twoSlots = (): MeetupSlot[] => [SLOT_A, SLOT_B];

const mkExchange = (id: string, to: string, toItem: string): Exchange => ({
  id,
  from_user_id: 'user_me',
  to_user_id: to,
  from_item_id: 'item_chair',
  to_item_id: toItem,
  status: ExchangeStatus.ACCEPTED,
  message: '',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

const results: string[] = [];
const check = (name: string, cond: boolean, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  —— ${extra}` : ''}`);
  if (!cond) process.exitCode = 1;
};

const loadMeetups = async (): Promise<Meetup[]> => (await storage.get<Meetup[]>(STORAGE_KEYS.meetups, [])) as Meetup[];

const setup = () => {
  mem.clear();
  seq = 0;
  commitShouldFail = false;
  setLockAvailable(true);
};

const loadEvents = async (): Promise<MeetupEvent[]> =>
  (await storage.get<MeetupEvent[]>(STORAGE_KEYS.meetupEvents, [])) as MeetupEvent[];

// 把一条预约推进到 SELECTED（双方走完 offer + select）。
const reachSelected = async (exchangeId = 'ex1', receiver = 'user_lin') => {
  const m = await meetupApi.createForExchange(exchangeId, 'user_me', twoSlots());
  await meetupApi.selectSlot(m.id, receiver, keyOf(SLOT_A), m.version);
  return m.id;
};

// 测试 1：两条共享 item_chair 的交换，抢同一时段 —— 只能有一组锁定。
const testDoubleBook = async () => {
  setup();
  await storage.set(STORAGE_KEYS.exchanges, [mkExchange('ex1', 'user_lin', 'item_camera'), mkExchange('ex2', 'user_chen', 'item_books')]);
  const m1 = await meetupApi.createForExchange('ex1', 'user_me', twoSlots());
  const m2 = await meetupApi.createForExchange('ex2', 'user_me', twoSlots());

  // 两个接收方近同时选定同一候选 SLOT_A：只能一条成功。
  const sel = await Promise.allSettled([
    meetupApi.selectSlot(m1.id, 'user_lin', keyOf(SLOT_A)),
    meetupApi.selectSlot(m2.id, 'user_chen', keyOf(SLOT_A)),
  ]);
  const selOk = sel.filter((r) => r.status === 'fulfilled').length;

  // 输掉的一方改选 SLOT_B，随后两组近同时确认：SLOT_A 上仍只有 m1 一组锁定。
  await meetupApi.selectSlot(m2.id, 'user_chen', keyOf(SLOT_B));
  const v1 = (await loadMeetups()).find((m) => m.id === m1.id)!.version;
  const v2 = (await loadMeetups()).find((m) => m.id === m2.id)!.version;
  const conf = await Promise.allSettled([
    meetupApi.confirm(m1.id, 'user_me', v1),
    meetupApi.confirm(m2.id, 'user_me', v2),
  ]);
  const after = await loadMeetups();
  const lockedOnSlotA = after.filter(
    (m) => m.status === MeetupStatus.LOCKED && m.locked_slot && new Date(m.locked_slot.start_at).getTime() === Number(keyOf(SLOT_A)),
  );
  const lockedOnSlotB = after.filter(
    (m) => m.status === MeetupStatus.LOCKED && m.locked_slot && new Date(m.locked_slot.start_at).getTime() === Number(keyOf(SLOT_B)),
  );

  check('选定阶段同物品同时段只有一条成功', selOk === 1, `成功 ${selOk} 条`);
  check('两组确认各自成功且 SLOT_A 仅一组锁定', conf.every((r) => r.status === 'fulfilled') && lockedOnSlotA.length === 1 && lockedOnSlotB.length === 1);
};

// 测试 2：取消/改期立即释放，释放后时段可被重新预约。
const testReleaseRebook = async () => {
  setup();
  await storage.set(STORAGE_KEYS.exchanges, [mkExchange('ex1', 'user_lin', 'item_camera'), mkExchange('ex2', 'user_chen', 'item_books')]);
  const m1 = await meetupApi.createForExchange('ex1', 'user_me', twoSlots());
  const key = keyOf(SLOT_A);
  await meetupApi.selectSlot(m1.id, 'user_lin', key);
  await meetupApi.confirm(m1.id, 'user_me');
  await meetupApi.cancel(m1.id, 'user_me'); // 任一方取消

  const m2 = await meetupApi.createForExchange('ex2', 'user_me', twoSlots());
  await meetupApi.selectSlot(m2.id, 'user_chen', key); // 旧时段应可重新预约
  const rebooked = await meetupApi.confirm(m2.id, 'user_me');

  const events = await storage.get<any[]>(STORAGE_KEYS.meetupEvents, []);
  const cancelEvent = events.find((e) => e.type === 'cancelled' && e.meetup_id === m1.id);
  check('取消后旧时段可被另一条交换重新锁定', rebooked.status === MeetupStatus.LOCKED);
  check('取消事件带回被释放的旧时段（可回读）', Boolean(cancelEvent?.released_slot));
};

// 测试 3：确认 / 改期 / 取消近同时发生（同一版本），只能保留一个有效结果。重复 60 轮并乱序。
const testRacyTriad = async () => {
  setup();
  await storage.set(STORAGE_KEYS.exchanges, [mkExchange('ex1', 'user_lin', 'item_camera')]);
  const ROUNDS = 60;
  let bad = 0;
  let badEvents = 0;
  const outcomeCount: Record<string, number> = {};
  const shuffle = <T,>(arr: T[]): T[] => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  for (let i = 0; i < ROUNDS; i++) {
    mem.delete(STORAGE_KEYS.meetups);
    mem.delete(STORAGE_KEYS.meetupEvents);
    const m = await meetupApi.createForExchange('ex1', 'user_me', twoSlots());
    await meetupApi.selectSlot(m.id, 'user_lin', keyOf(SLOT_A));
    const selected = (await loadMeetups()).find((x) => x.id === m.id)!;
    const v = selected.version; // 三个动作都基于同一个版本发起

    const actions = shuffle([
      () => meetupApi.confirm(m.id, 'user_me', v),
      () => meetupApi.reschedule(m.id, 'user_me', undefined, v),
      () => meetupApi.cancel(m.id, 'user_lin', undefined, v),
    ]);
    const rs = await Promise.allSettled(actions.map((a) => a()));
    const won = rs.filter((r) => r.status === 'fulfilled').length;

    const after = (await loadMeetups()).find((x) => x.id === m.id)!;
    outcomeCount[after.status] = (outcomeCount[after.status] ?? 0) + 1;
    const consistent =
      (after.status === MeetupStatus.LOCKED && Boolean(after.locked_slot)) ||
      ((after.status === MeetupStatus.RESCHEDULING || after.status === MeetupStatus.CANCELLED) &&
        after.locked_slot === null &&
        after.selected_slot === null);

    // 本轮在 SELECTED 之后应只新增恰好一条终结性写事件（confirmed/rescheduled/cancelled）。
    const terminalEvents = (await storage.get<any[]>(STORAGE_KEYS.meetupEvents, [])).filter(
      (e) => e.meetup_id === m.id && ['confirmed', 'rescheduled', 'cancelled'].includes(e.type),
    );

    if (won !== 1 || !consistent) bad++;
    if (terminalEvents.length !== 1) badEvents++;
  }
  check('60 轮近同时 确认/改期/取消 恰好一个生效、结果自洽', bad === 0, `异常 ${bad} 轮；分布 ${JSON.stringify(outcomeCount)}`);
  check('每轮只写入一条终结事件（无撕裂/无多重收口）', badEvents === 0, `异常 ${badEvents} 轮`);
};

// 测试 4：改期新旧时段同次收口 —— 改期后旧时段可被他人预约，新一轮可再锁定。
const testRescheduleCloseout = async () => {
  setup();
  await storage.set(STORAGE_KEYS.exchanges, [mkExchange('ex1', 'user_lin', 'item_camera'), mkExchange('ex2', 'user_chen', 'item_books')]);
  const oldKey = keyOf(SLOT_A);
  const m1 = await meetupApi.createForExchange('ex1', 'user_me', twoSlots());
  await meetupApi.selectSlot(m1.id, 'user_lin', oldKey);
  await meetupApi.confirm(m1.id, 'user_me');
  await meetupApi.reschedule(m1.id, 'user_lin'); // 接收方发起改期
  let after = (await loadMeetups()).find((x) => x.id === m1.id)!;
  check('改期后旧时段立即释放、进入改期中、轮次+1',
    after.status === MeetupStatus.RESCHEDULING && after.locked_slot === null && after.round === 2 && after.offerer_user_id === 'user_lin');

  // 改期方给新候选（避开旧时段），对方选定，改期方确认
  await meetupApi.offerSlots(m1.id, 'user_lin', [SLOT_C, SLOT_D]);
  const newKey = keyOf(SLOT_C);
  await meetupApi.selectSlot(m1.id, 'user_me', newKey);
  await meetupApi.confirm(m1.id, 'user_lin');

  // 旧时段此刻应能被第二条交换预约成功
  const m2 = await meetupApi.createForExchange('ex2', 'user_me', twoSlots());
  await meetupApi.selectSlot(m2.id, 'user_chen', oldKey);
  const rebook = await meetupApi.confirm(m2.id, 'user_me');

  after = (await loadMeetups()).find((x) => x.id === m1.id)!;
  check('改期后新轮次可重新锁定，且旧时段已可被他人重约',
    after.status === MeetupStatus.LOCKED && rebook.status === MeetupStatus.LOCKED);
};

// 测试 5：确认/改期/取消提交失败时，主记录与流水都不变，重试后成功。
const testAtomicFailureRollback = async () => {
  // 5a. 确认失败：保持 SELECTED、旧时段仍保留、无 confirmed 流水
  setup();
  await storage.set(STORAGE_KEYS.exchanges, [mkExchange('ex1', 'user_lin', 'item_camera')]);
  const id = await reachSelected();
  const before = (await loadMeetups()).find((m) => m.id === id)!;
  const eventsBefore = (await loadEvents()).length;

  commitShouldFail = true;
  let threw = false;
  try {
    await meetupApi.confirm(id, 'user_me', before.version);
  } catch {
    threw = true;
  }
  commitShouldFail = false;
  const mid = (await loadMeetups()).find((m) => m.id === id)!;
  const eventsMid = await loadEvents();

  check('确认提交失败会向上抛错', threw);
  check('确认失败：主记录回到事务前（仍 SELECTED、版本不变）',
    mid.status === MeetupStatus.SELECTED && mid.version === before.version &&
      mid.selected_slot?.start_at === SLOT_A.start_at && mid.locked_slot === null);
  check('确认失败：流水未追加 confirmed（无单边变化）',
    eventsMid.length === eventsBefore && !eventsMid.some((e) => e.type === MeetupEventType.CONFIRMED));

  // 失败后重试：回到事务前状态，确认可正常成功
  const retried = await meetupApi.confirm(id, 'user_me', before.version);
  const after = (await loadMeetups()).find((m) => m.id === id)!;
  const eventsAfter = await loadEvents();
  check('失败后重试确认成功并锁定', retried.status === MeetupStatus.LOCKED && after.status === MeetupStatus.LOCKED);
  check('重试后只产生一条 confirmed 流水',
    eventsAfter.filter((e) => e.type === MeetupEventType.CONFIRMED && e.meetup_id === id).length === 1);

  // 5b. 改期失败：保持 LOCKED、旧时段仍保留（事务前是锁定状态）
  setup();
  await storage.set(STORAGE_KEYS.exchanges, [mkExchange('ex1', 'user_lin', 'item_camera')]);
  const id2 = await reachSelected();
  await meetupApi.confirm(id2, 'user_me');
  const locked = (await loadMeetups()).find((m) => m.id === id2)!;
  commitShouldFail = true;
  threw = false;
  try {
    await meetupApi.reschedule(id2, 'user_lin', undefined, locked.version);
  } catch {
    threw = true;
  }
  commitShouldFail = false;
  const stillLocked = (await loadMeetups()).find((m) => m.id === id2)!;
  check('改期提交失败会抛错且旧时段按事务前保留（仍 LOCKED）',
    threw && stillLocked.status === MeetupStatus.LOCKED &&
      stillLocked.locked_slot?.start_at === SLOT_A.start_at && stillLocked.round === 1);
  check('改期失败：无 rescheduled 流水',
    !(await loadEvents()).some((e) => e.type === MeetupEventType.RESCHEDULED && e.meetup_id === id2));

  // 5c. 取消失败：保持当前状态、时段不释放
  const reschedOk = await meetupApi.reschedule(id2, 'user_lin');
  commitShouldFail = true;
  threw = false;
  try {
    // 在 RESCHEDULING 上再取消，模拟取消提交失败
    await meetupApi.cancel(id2, 'user_me', undefined, reschedOk.version);
  } catch {
    threw = true;
  }
  commitShouldFail = false;
  const stillRescheduling = (await loadMeetups()).find((m) => m.id === id2)!;
  check('取消提交失败会抛错且预约仍为改期中（未被单边取消）',
    threw && stillRescheduling.status === MeetupStatus.RESCHEDULING);
};

// 测试 6：成功过的终态操作不会重复追加流水（幂等重放）。
const testNoDuplicateEvents = async () => {
  setup();
  await storage.set(STORAGE_KEYS.exchanges, [mkExchange('ex1', 'user_lin', 'item_camera')]);
  const id = await reachSelected();
  await meetupApi.confirm(id, 'user_me');

  // 人为制造"主记录已锁定、但再跑一遍 confirm 的 apply"不会重复：状态机本就拒绝从 LOCKED 再 confirm。
  // 这里直接验证幂等键：对同一 (meetup, round, type) 重放，事件条数不增长。
  const events = await loadEvents();
  const confirmedCount = events.filter((e) => e.type === MeetupEventType.CONFIRMED && e.meetup_id === id).length;

  // 改期成功后再改期（进入新一轮）是允许的，但每一轮各自只有一条 rescheduled；
  // 同一轮重复提交同类型终态事件被 CAS 版本拦截。
  const v1 = (await loadMeetups()).find((m) => m.id === id)!.version;
  const dup = await Promise.allSettled([
    meetupApi.reschedule(id, 'user_me', undefined, v1),
    meetupApi.reschedule(id, 'user_lin', undefined, v1),
  ]);
  const rescheduleWins = dup.filter((r) => r.status === 'fulfilled').length;
  const after = await loadEvents();
  check('成功锁定只产生一条 confirmed 流水', confirmedCount === 1);
  check('同版本并发改期只有一次生效', rescheduleWins === 1);
  check('并发改期只追加一条 rescheduled 流水',
    after.filter((e) => e.type === MeetupEventType.RESCHEDULED && e.meetup_id === id).length === 1);
};

// 测试 7：commitLocalBatch 中途失败会把已写键逆序回滚到事务前。
const testCommitLocalBatchRollback = () => {
  class FakeStorage {
    data = new Map<string, string>();
    failOnKey = '';
    getItem(key: string) {
      return this.data.has(key) ? this.data.get(key)! : null;
    }
    setItem(key: string, value: string) {
      if (key === this.failOnKey) throw new Error('quota exceeded');
      this.data.set(key, value);
    }
    removeItem(key: string) {
      this.data.delete(key);
    }
    clear() {
      this.data.clear();
    }
  }
  const fake = new FakeStorage();
  const real = globalThis.localStorage;
  (globalThis as { localStorage: Storage }).localStorage = fake as unknown as Storage;

  // k1 先存在（旧值），k2 不存在；提交 [k1 新值, k2] 时在 k2 抛错。
  fake.setItem('k1', 'old');
  fake.failOnKey = 'k2';
  let threw = false;
  try {
    commitLocalBatch([
      { key: 'k1', packedJson: 'new' },
      { key: 'k2', packedJson: 'x' },
    ]);
  } catch {
    threw = true;
  }
  const k1Restored = fake.getItem('k1') === 'old';
  const k2Absent = fake.getItem('k2') === null;

  // 无故障时全部写入
  fake.failOnKey = '';
  commitLocalBatch([
    { key: 'k1', packedJson: 'new' },
    { key: 'k2', packedJson: 'x' },
  ]);
  const allWritten = fake.getItem('k1') === 'new' && fake.getItem('k2') === 'x';

  (globalThis as { localStorage?: Storage }).localStorage = real;
  check('commitLocalBatch 中途失败抛错', threw);
  check('回滚：已改键恢复旧值、新增键被删除', k1Restored && k2Absent);
  check('无故障时批量提交全部生效', allWritten);
};

// 测试 8：跨页互斥不可用/建立失败时，确认/改期/取消必须明确失败且不提交。
const testRequiredCrossTabLock = async () => {
  setup();
  await storage.set(STORAGE_KEYS.exchanges, [mkExchange('ex1', 'user_lin', 'item_camera')]);
  const id = await reachSelected();
  const before = (await loadMeetups()).find((m) => m.id === id)!;
  const eventsBefore = (await loadEvents()).length;

  // 8a. 建立锁失败（注入适配器抛 CrossTabLockError）：三个终态动作都被阻止。
  setLockAvailable(false);
  const expectLockBlock = async (
    label: string,
    call: () => Promise<unknown>,
    unchanged: { status: MeetupStatus; version: number },
  ) => {
    const eventsAtCall = (await loadEvents()).length;
    let caught: unknown = null;
    try {
      await call();
    } catch (e) {
      caught = e;
    }
    const isLockErr = caught instanceof CrossTabLockError;
    const m = (await loadMeetups()).find((x) => x.id === id)!;
    const ev = (await loadEvents()).length;
    check(`${label}：建锁失败时抛 CrossTabLockError`, isLockErr, caught ? String((caught as Error).message) : '未抛错');
    check(`${label}：被阻止后状态/版本/流水不变`,
      m.status === unchanged.status && m.version === unchanged.version && ev === eventsAtCall);
  };

  await expectLockBlock('确认', () => meetupApi.confirm(id, 'user_me', before.version), {
    status: MeetupStatus.SELECTED,
    version: before.version,
  });
  // 先把它推进到 LOCKED 以便测改期/取消（恢复可用）。
  setLockAvailable(true);
  await meetupApi.confirm(id, 'user_me', before.version);
  const locked = (await loadMeetups()).find((m) => m.id === id)!;

  setLockAvailable(false);
  await expectLockBlock('改期', () => meetupApi.reschedule(id, 'user_lin', undefined, locked.version), {
    status: MeetupStatus.LOCKED,
    version: locked.version,
  });
  await expectLockBlock('取消', () => meetupApi.cancel(id, 'user_me', undefined, locked.version), {
    status: MeetupStatus.LOCKED,
    version: locked.version,
  });

  // 8b. 完全没有跨页后端（移除注入，Node 又无 navigator.locks）：终态动作同样被阻止。
  (globalThis as Record<string, unknown>).__RESWAP_CROSS_TAB_LOCK__ = undefined;
  let caught: unknown = null;
  try {
    await meetupApi.cancel(id, 'user_me', undefined, locked.version);
  } catch (e) {
    caught = e;
  }
  const stillLocked = (await loadMeetups()).find((m) => m.id === id)!;
  check('无跨页后端时取消抛 CrossTabLockError 且不降级提交',
    caught instanceof CrossTabLockError && stillLocked.status === MeetupStatus.LOCKED && stillLocked.version === locked.version);

  // 8c. 非终态动作在无后端时仍可尽力执行（建约/选定保持原样），不被必需锁拦住。
  await storage.set(STORAGE_KEYS.exchanges, [
    mkExchange('ex1', 'user_lin', 'item_camera'),
    mkExchange('ex2', 'user_chen', 'item_books'),
  ]);
  const created = await meetupApi.createForExchange('ex2', 'user_me', [SLOT_C, SLOT_D]);
  const selected = await meetupApi.selectSlot(created.id, 'user_chen', keyOf(SLOT_C), created.version);
  check('无跨页后端时普通建约/选定仍可执行（尽力而为）',
    created.status === MeetupStatus.PROPOSED && selected.status === MeetupStatus.SELECTED);

  // 8d. 互斥恢复后重试同一终态动作只生效一次；再重复只得到业务拒绝。
  setLockAvailable(true);
  const done = await meetupApi.confirm(created.id, 'user_me', selected.version);
  let businessErr: unknown = null;
  try {
    await meetupApi.confirm(created.id, 'user_me', done.version);
  } catch (e) {
    businessErr = e;
  }
  const confirmedCount = (await loadEvents()).filter(
    (e) => e.type === MeetupEventType.CONFIRMED && e.meetup_id === created.id,
  ).length;
  check('恢复后确认单次生效，重复仅业务拒绝、不重复追加',
    done.status === MeetupStatus.LOCKED && businessErr instanceof Error && !(businessErr instanceof CrossTabLockError) && confirmedCount === 1);
};

await testDoubleBook();
await testReleaseRebook();
await testRacyTriad();
await testRescheduleCloseout();
await testAtomicFailureRollback();
await testNoDuplicateEvents();
testCommitLocalBatchRollback();
await testRequiredCrossTabLock();
console.log(results.join('\n'));
