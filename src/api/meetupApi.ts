import {
  MEETUP_ACTION_FLOW,
  MEETUP_CANDIDATE_COUNT,
  MEETUP_SLOT_HOLDING_STATUSES,
  MeetupEventType,
  MeetupStatus,
} from '@/constants/meetup';
import { ExchangeStatus } from '@/constants/exchange';
import type { Meetup, MeetupDraft, MeetupEvent, MeetupSlot } from '@/models/meetup';
import { meetupWriteLock } from '@/utils/mutex';

import { exchangeApi } from './exchangeApi';
import { storage, STORAGE_KEYS } from '@/utils/storage';
import { isSameSlot, isSlotConflict, normalizeSlotKey } from '@/utils/slotUtils';

const dayAfter = (days: number, hour: number, minute = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};

const slot = (day: number, hour: number, place: string, lengthHours = 2): MeetupSlot => {
  const start = new Date(dayAfter(day, hour));
  const end = new Date(start.getTime() + 1000 * 60 * 60 * lengthHours);
  return { start_at: start.toISOString(), end_at: end.toISOString(), place };
};

// 演示用：一条已锁定的面交预约，挂在 exchangeApi 幂等注入的"已同意"交换上。
const seedLockedSlot = slot(2, 14, '杭州 · 西湖文化广场地铁口');
const seedMeetup: Meetup = {
  id: 'meetup_seed_locked',
  exchange_id: 'exchange_seed_accepted',
  from_user_id: 'user_me',
  to_user_id: 'user_chen',
  from_item_id: 'item_chair',
  to_item_id: 'item_books',
  item_ids: ['item_chair', 'item_books'],
  status: MeetupStatus.LOCKED,
  candidates: [seedLockedSlot, slot(3, 10, '杭州 · 西湖文化广场地铁口')],
  selected_slot: seedLockedSlot,
  locked_slot: seedLockedSlot,
  round: 1,
  offerer_user_id: 'user_me',
  version: 1,
  created_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  updated_at: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
};

const seedEvents: MeetupEvent[] = [
  {
    id: 'meetup_event_seed_1',
    meetup_id: seedMeetup.id,
    exchange_id: seedMeetup.exchange_id,
    type: MeetupEventType.PROPOSED,
    actor_user_id: 'user_me',
    round: 1,
    candidates: seedMeetup.candidates,
    created_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  },
  {
    id: 'meetup_event_seed_2',
    meetup_id: seedMeetup.id,
    exchange_id: seedMeetup.exchange_id,
    type: MeetupEventType.SELECTED,
    actor_user_id: 'user_chen',
    round: 1,
    slot: seedLockedSlot,
    created_at: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
  },
  {
    id: 'meetup_event_seed_3',
    meetup_id: seedMeetup.id,
    exchange_id: seedMeetup.exchange_id,
    type: MeetupEventType.CONFIRMED,
    actor_user_id: 'user_me',
    round: 1,
    slot: seedLockedSlot,
    created_at: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
  },
];

const readMeetups = () => storage.get<Meetup[]>(STORAGE_KEYS.meetups, []);
const readEvents = () => storage.get<MeetupEvent[]>(STORAGE_KEYS.meetupEvents, []);

const assertParty = (meetup: Meetup, actorUserId: string) => {
  if (actorUserId !== meetup.from_user_id && actorUserId !== meetup.to_user_id) {
    throw new Error('只有交换双方可以操作面交预约');
  }
};

const assertStatus = (action: keyof typeof MEETUP_ACTION_FLOW, status: MeetupStatus) => {
  if (!MEETUP_ACTION_FLOW[action].includes(status)) {
    throw new Error('当前预约状态不允许该操作，预约可能已被对方改期或取消');
  }
};

const assertCandidates = (candidates: MeetupSlot[]) => {
  if (candidates.length !== MEETUP_CANDIDATE_COUNT) {
    throw new Error(`请给出 ${MEETUP_CANDIDATE_COUNT} 个候选时段`);
  }
  if (isSameSlot(candidates[0], candidates[1])) {
    throw new Error('两个候选时段不能相同');
  }
  if (!candidates[0].place.trim() || !candidates[1].place.trim()) {
    throw new Error('请填写面交地点');
  }
};

/** 该时段是否已被另一条有效预约（SELECTED / LOCKED）以相交物品占用。 */
const findSlotHolder = (
  meetups: Meetup[],
  itemIds: string[],
  target: MeetupSlot,
  excludeMeetupId: string,
) =>
  meetups.find((meetup) => {
    if (meetup.id === excludeMeetupId || !MEETUP_SLOT_HOLDING_STATUSES.includes(meetup.status)) return false;
    const held = meetup.status === MeetupStatus.SELECTED ? meetup.selected_slot : meetup.locked_slot;
    return Boolean(held && isSlotConflict(target, meetup.item_ids, itemIds, held));
  });

const makeEvent = (
  meetup: Meetup,
  type: MeetupEventType,
  actorUserId: string,
  patch: Partial<MeetupEvent> = {},
): MeetupEvent => ({
  id: storage.createId('meetup_event'),
  meetup_id: meetup.id,
  exchange_id: meetup.exchange_id,
  type,
  actor_user_id: actorUserId,
  round: meetup.round,
  created_at: new Date().toISOString(),
  ...patch,
});

/** 同一预约、同一轮次、同一事件类型只允许一条；存在即返回旧记录，绝不重复追加。 */
const findEvent = (
  events: MeetupEvent[],
  meetup: Meetup,
  type: MeetupEventType,
): MeetupEvent | undefined =>
  events.find((event) => event.meetup_id === meetup.id && event.round === meetup.round && event.type === type);

const recordEvent = (
  events: MeetupEvent[],
  meetup: Meetup,
  type: MeetupEventType,
  actorUserId: string,
  patch: Partial<MeetupEvent> = {},
): MeetupEvent => {
  const existing = findEvent(events, meetup, type);
  if (existing) return existing;
  const event = makeEvent(meetup, type, actorUserId, patch);
  events.push(event);
  return event;
};

// 预约主记录 + 流水必须在同一原子提交里落地：任一步失败整体回滚，不留单边变化。
const commitMeetups = (meetups: Meetup[], events: MeetupEvent[]) =>
  storage.commitBatch({
    [STORAGE_KEYS.meetups]: meetups,
    [STORAGE_KEYS.meetupEvents]: events,
  });

export const meetupApi = {
  async listMeetups(): Promise<Meetup[]> {
    const meetups = await readMeetups();
    if (meetups.length) return meetups;
    return this.ensureSeed();
  },

  async listEvents(): Promise<MeetupEvent[]> {
    const events = await readEvents();
    if (events.length) return events;
    await this.ensureSeed();
    return readEvents();
  },

  // 幂等注入演示数据：仅在缺失时补齐，绝不覆盖用户已写入的预约。
  async ensureSeed(): Promise<Meetup[]> {
    return meetupWriteLock.runExclusive(async () => {
      const [meetups, events] = await Promise.all([readMeetups(), readEvents()]);
      const nextMeetups = meetups.some((item) => item.id === seedMeetup.id) ? meetups : [...meetups, seedMeetup];
      const nextEvents = events.some((item) => item.id === seedEvents[0].id)
        ? events
        : [...events, ...seedEvents];
      if (nextMeetups !== meetups || nextEvents !== events) {
        await commitMeetups(nextMeetups, nextEvents);
      }
      return nextMeetups;
    });
  },

  /** 交换通过（已同意）后，由发起方给出两个候选时段，创建面交预约。 */
  async createForExchange(exchangeId: string, actorUserId: string, candidates: MeetupSlot[]): Promise<Meetup> {
    assertCandidates(candidates);
    return meetupWriteLock.runExclusive(async () => {
      const exchange = await exchangeApi.detail(exchangeId);
      if (!exchange) throw new Error('交换记录不存在');
      if (exchange.status !== ExchangeStatus.ACCEPTED) {
        throw new Error('只有已同意的交换才能预约线下面交');
      }
      if (exchange.from_user_id !== actorUserId) {
        throw new Error('首轮候选时段由交换发起方提供');
      }
      const meetups = await readMeetups();
      if (
        meetups.some(
          (item) => item.exchange_id === exchangeId && item.status !== MeetupStatus.CANCELLED,
        )
      ) {
        throw new Error('这条交换已有进行中的面交预约');
      }

      const now = new Date().toISOString();
      const meetup: Meetup = {
        id: storage.createId('meetup'),
        exchange_id: exchangeId,
        from_user_id: exchange.from_user_id,
        to_user_id: exchange.to_user_id,
        from_item_id: exchange.from_item_id,
        to_item_id: exchange.to_item_id,
        item_ids: [exchange.from_item_id, exchange.to_item_id],
        status: MeetupStatus.PROPOSED,
        candidates,
        selected_slot: null,
        locked_slot: null,
        round: 1,
        offerer_user_id: exchange.from_user_id,
        version: 1,
        created_at: now,
        updated_at: now,
      };
      const events = await readEvents();
      recordEvent(events, meetup, MeetupEventType.PROPOSED, actorUserId, { candidates });
      // 主记录与流水同一原子提交：写失败则两边都不落，本次建约整体回到事务前。
      await commitMeetups([meetup, ...meetups], events);
      return meetup;
    });
  },

  /** RESCHEDULING 阶段：改期触发方补齐两个新候选，进入新一轮 PROPOSED。 */
  async offerSlots(
    id: string,
    actorUserId: string,
    candidates: MeetupSlot[],
    expectedVersion?: number,
  ): Promise<Meetup> {
    assertCandidates(candidates);
    return this.mutate(id, actorUserId, 'offer', expectedVersion, (meetup, meetups, events) => {
      if (meetup.offerer_user_id !== actorUserId) throw new Error('本轮候选由改期发起方提供');
      meetup.status = MeetupStatus.PROPOSED;
      meetup.candidates = candidates;
      meetup.selected_slot = null;
      meetup.locked_slot = null;
      recordEvent(events, meetup, MeetupEventType.PROPOSED, actorUserId, { candidates });
    });
  },

  /** 接收方（非候选提供方）从两个候选中选定一个。 */
  async selectSlot(
    id: string,
    actorUserId: string,
    slotKey: string,
    expectedVersion?: number,
  ): Promise<Meetup> {
    return this.mutate(id, actorUserId, 'select', expectedVersion, (meetup, meetups, events) => {
      if (actorUserId === meetup.offerer_user_id) throw new Error('候选由对方选定');
      const chosen = meetup.candidates.find((item) => normalizeSlotKey(item) === slotKey);
      if (!chosen) throw new Error('请选择有效的候选时段');
      // 选定瞬间软占：挡掉其它预约对同一物品同一时段的占用。
      const holder = findSlotHolder(meetups, meetup.item_ids, chosen, meetup.id);
      if (holder) throw new Error('该时段已被相关物品的另一场面交占用，请改选其它候选');
      meetup.status = MeetupStatus.SELECTED;
      meetup.selected_slot = chosen;
      meetup.locked_slot = null;
      recordEvent(events, meetup, MeetupEventType.SELECTED, actorUserId, { slot: chosen });
    });
  },

  /** 候选提供方确认，时段锁定。confirm 与改期/取消近同时发生时由锁 + 版本 CAS 裁决。 */
  async confirm(id: string, actorUserId: string, expectedVersion?: number): Promise<Meetup> {
    return this.mutate(id, actorUserId, 'confirm', expectedVersion, (meetup, meetups, events) => {
      if (actorUserId !== meetup.offerer_user_id) throw new Error('由候选提供方确认锁定');
      const chosen = meetup.selected_slot;
      if (!chosen) throw new Error('尚未选定时段');
      // 确认前再扫一次：若该时段在此期间被别人锁定，本次确认失败，时段不会被重复占用。
      const holder = findSlotHolder(meetups, meetup.item_ids, chosen, meetup.id);
      if (holder) throw new Error('该时段刚刚被另一场面交锁定，请重新选择或改期');
      meetup.status = MeetupStatus.LOCKED;
      meetup.locked_slot = chosen;
      recordEvent(events, meetup, MeetupEventType.CONFIRMED, actorUserId, { slot: chosen });
    }, { crossTab: 'required' });
  },

  /** 任一方改期：同一临界区内释放旧时段、进入 RESCHEDULING、轮次 +1。 */
  async reschedule(id: string, actorUserId: string, note?: string, expectedVersion?: number): Promise<Meetup> {
    return this.mutate(id, actorUserId, 'reschedule', expectedVersion, (meetup, _meetups, events) => {
      const released = meetup.locked_slot ?? meetup.selected_slot;
      // 先按"当前轮"记一条 RESCHEDULED，再推进轮次；新旧时段在同一事务内收口。
      recordEvent(events, meetup, MeetupEventType.RESCHEDULED, actorUserId, {
        released_slot: released ?? undefined,
        note,
      });
      meetup.status = MeetupStatus.RESCHEDULING;
      meetup.round += 1;
      // 旧时段此刻立即释放，新候选由改期发起方随后给出。
      meetup.offerer_user_id = actorUserId;
      meetup.candidates = [];
      meetup.selected_slot = null;
      meetup.locked_slot = null;
    }, { crossTab: 'required' });
  },

  /** 任一方取消：同一临界区内释放旧时段并置为终态 CANCELLED。 */
  async cancel(id: string, actorUserId: string, note?: string, expectedVersion?: number): Promise<Meetup> {
    return this.mutate(id, actorUserId, 'cancel', expectedVersion, (meetup, _meetups, events) => {
      const released = meetup.locked_slot ?? meetup.selected_slot;
      recordEvent(events, meetup, MeetupEventType.CANCELLED, actorUserId, {
        released_slot: released ?? undefined,
        note,
      });
      meetup.status = MeetupStatus.CANCELLED;
      meetup.selected_slot = null;
      meetup.locked_slot = null;
      meetup.candidates = [];
    }, { crossTab: 'required' });
  },

  /**
   * 所有写动作共用的事务模板：进入同一把全局锁 -> 读最新数据 -> 角色/状态机/版本 CAS 校验
   * -> 就地改一条、幂等追加一条事件 -> 主记录与流水【单次原子提交】。
   *
   * 并发与一致性防线：
   *  1) meetupWriteLock 把近同时操作串行化（保证"同物品同时段唯一"与"新旧时段同次收口"）；
   *  2) expectedVersion 乐观锁：确认/改期/取消基于同一版本同时发起时，只有第一个提交生效，
   *     其余因版本已前进而失败，确保"几乎同时发生时只保留一个有效结果"；
   *  3) storage.commitBatch 同步原子提交并补偿回滚：预约结果与流水要么同时落地、要么都不落地。
   *     提交抛错时把内存里的 version/updated_at 还原到事务前，随后重试等价于从未执行过，
   *     旧时段严格按事务前状态保留或释放；成功动作的流水按 (meetup, round, type) 幂等，不重复追加。
   */
  async mutate(
    id: string,
    actorUserId: string,
    action: keyof typeof MEETUP_ACTION_FLOW,
    expectedVersion: number | undefined,
    apply: (meetup: Meetup, meetups: Meetup[], events: MeetupEvent[]) => void,
    lockOptions: { crossTab?: 'required' | 'best-effort' } = {},
  ): Promise<Meetup> {
    // 终态动作传 { crossTab: 'required' }：跨页锁建立失败时 runExclusive 直接抛
    // CrossTabLockError，根本不会进入临界区，因此没有任何提交、状态或流水变化。
    return meetupWriteLock.runExclusive(async () => {
      const [meetups, events] = await Promise.all([readMeetups(), readEvents()]);
      const meetup = meetups.find((item) => item.id === id);
      if (!meetup) throw new Error('面交预约不存在');
      assertParty(meetup, actorUserId);
      assertStatus(action, meetup.status);
      if (typeof expectedVersion === 'number' && meetup.version !== expectedVersion) {
        throw new Error('预约状态已被对方更新，请刷新后重试');
      }

      const previousVersion = meetup.version;
      const previousUpdatedAt = meetup.updated_at;
      apply(meetup, meetups, events);

      meetup.version = previousVersion + 1;
      meetup.updated_at = new Date().toISOString();
      try {
        await commitMeetups(meetups, events);
      } catch (error) {
        // 原子提交已把存储层整体回滚；这里同步把内存副本恢复到事务前，失败后可原样重试。
        meetup.version = previousVersion;
        meetup.updated_at = previousUpdatedAt;
        throw error;
      }
      return meetup;
    }, lockOptions);
  },
};
