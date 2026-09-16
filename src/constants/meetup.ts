// 线下面交预约状态机
//
// PROPOSED       本轮候选提供方给出两个候选时段，等待对方选定
// SELECTED       对方已选定一个候选，等待候选提供方确认（此时段软占）
// LOCKED         候选提供方确认后锁定；同一物品同一时段全平台只能有一组 LOCKED
// RESCHEDULING   任一方发起改期：旧时段已在同一事务内释放，等待改期方给出新候选
// CANCELLED      任一方取消：旧时段已在同一事务内释放；终态，历史记录仍可回读
export enum MeetupStatus {
  PROPOSED = 'proposed',
  SELECTED = 'selected',
  LOCKED = 'locked',
  RESCHEDULING = 'rescheduling',
  CANCELLED = 'cancelled',
}

export const MEETUP_STATUS_OPTIONS = [
  { label: '待选择', value: MeetupStatus.PROPOSED },
  { label: '待确认', value: MeetupStatus.SELECTED },
  { label: '已锁定', value: MeetupStatus.LOCKED },
  { label: '改期中', value: MeetupStatus.RESCHEDULING },
  { label: '已取消', value: MeetupStatus.CANCELLED },
];

// 面交流水事件类型 —— 只追加、不改写，用于确认记录与历史回读。
export enum MeetupEventType {
  PROPOSED = 'proposed',
  SELECTED = 'selected',
  CONFIRMED = 'confirmed',
  RESCHEDULED = 'rescheduled',
  CANCELLED = 'cancelled',
}

// 预约动作。create 用于交换通过后的首轮发起（无前置状态），其余动作受状态机约束。
export type MeetupAction = 'offer' | 'select' | 'confirm' | 'reschedule' | 'cancel';

// 每个动作允许从哪些当前状态发起；不满足即拒绝（近同时操作时后来者会读到已变更的状态）。
export const MEETUP_ACTION_FLOW: Record<MeetupAction, MeetupStatus[]> = {
  // 改期发起方在 RESCHEDULING 阶段补充两个新候选，进入新一轮 PROPOSED
  offer: [MeetupStatus.RESCHEDULING],
  select: [MeetupStatus.PROPOSED],
  confirm: [MeetupStatus.SELECTED],
  reschedule: [MeetupStatus.SELECTED, MeetupStatus.LOCKED],
  cancel: [MeetupStatus.PROPOSED, MeetupStatus.SELECTED, MeetupStatus.LOCKED, MeetupStatus.RESCHEDULING],
};

// 哪些状态仍然占着面交时段，用于"同一物品同一时段只能有一组锁定"的占用扫描。
// SELECTED 也软占：接收方一选定即挡住冲突，保证后续 confirm 不会撞车。
export const MEETUP_SLOT_HOLDING_STATUSES: MeetupStatus[] = [MeetupStatus.SELECTED, MeetupStatus.LOCKED];

export const MEETUP_CANDIDATE_COUNT = 2;

export const MEETUP_STORAGE_HINTS = {
  statusKey: 'reswap:meetups',
  statusTouchedBy: ['models/meetup.ts', 'stores/meetupStore.ts', 'components/common/MeetupPanel.vue'],
};
