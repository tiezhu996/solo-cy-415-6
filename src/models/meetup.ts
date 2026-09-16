import type { MeetupEventType, MeetupStatus } from '@/constants/meetup';

/** 线下面交候选时段。start_at/end_at 为 ISO 字符串，place 为面交地点。 */
export interface MeetupSlot {
  start_at: string;
  end_at: string;
  place: string;
}

/**
 * 一次面交预约，挂在一条交换（Exchange）之下。
 *
 * 一次交换至多有一条"有效"预约（非 CANCELLED）。改期不是新建预约，而是在同一条
 * 预约上推进协商轮次 round，保证"新旧时段同次收口"。
 */
export interface Meetup {
  id: string;
  exchange_id: string;
  /** 交换发起方 / 接收方，整次交换固定不变。 */
  from_user_id: string;
  to_user_id: string;
  from_item_id: string;
  to_item_id: string;
  /** 冗余本次交换涉及的两件物品，供"同物品同时段唯一"占用扫描直接读取。 */
  item_ids: string[];
  status: MeetupStatus;
  /** 当前协商轮次的两个候选时段；RESCHEDULING 阶段尚未给出新候选时为空数组。 */
  candidates: MeetupSlot[];
  /** 当前轮次被选定的候选；未选定或已释放时为 null。 */
  selected_slot: MeetupSlot | null;
  /** 当前锁定时段；SELECTED 阶段或已释放（改期/取消）后为 null。 */
  locked_slot: MeetupSlot | null;
  /** 协商轮次，首轮为 1，每发起一次改期 +1。 */
  round: number;
  /** 本轮候选提供方：首轮是交换发起方，改期轮是改期触发方。 */
  offerer_user_id: string;
  /** 乐观版本号，每次写入 +1，用于近同时操作的 compare-and-swap。 */
  version: number;
  created_at: string;
  updated_at: string;
}

/** 只追加、不改写的面交流水事件，确认/改期/取消记录都靠它回读。 */
export interface MeetupEvent {
  id: string;
  meetup_id: string;
  exchange_id: string;
  type: MeetupEventType;
  actor_user_id: string;
  round: number;
  /** PROPOSED 事件携带本轮两个候选。 */
  candidates?: MeetupSlot[];
  /** SELECTED / CONFIRMED 事件携带对应时段。 */
  slot?: MeetupSlot;
  /** RESCHEDULED / CANCELLED 事件携带被同一事务释放掉的旧时段。 */
  released_slot?: MeetupSlot;
  note?: string;
  created_at: string;
}

/** 交换通过后发起方面交预约所需的输入。 */
export type MeetupDraft = Pick<
  Meetup,
  'exchange_id' | 'from_user_id' | 'to_user_id' | 'from_item_id' | 'to_item_id'
> & {
  candidates: MeetupSlot[];
};
