/* 多标签页竞争测试共享夹具：同一条面交安排与它挂的已同意交换。 */
import { ExchangeStatus } from '@/constants/exchange';
import { MeetupStatus } from '@/constants/meetup';
import type { Exchange } from '@/models/exchange';
import type { MeetupSlot } from '@/models/meetup';

export const FIXTURE = {
  exchangeId: 'exchange_cross',
  meetupId: 'meetup_cross',
  fromUser: 'user_me',
  toUser: 'user_lin',
  fromItem: 'item_chair',
  toItem: 'item_camera',
  // 用跨进程一致的固定时刻（不能各进程用 Date.now() 现算，否则 seed/contend/read
  // 对"同一时段"的判定会错开）。取足够远的未来，保证每次重复运行都成立。
  slot: {
    start_at: '2030-01-01T10:00:00.000Z',
    end_at: '2030-01-01T12:00:00.000Z',
    place: '杭州 · 西湖文化广场地铁口',
  } satisfies MeetupSlot,
  candidates: [] as MeetupSlot[],
};

// 第二个候选与第一候选错开，避免候选重复。
FIXTURE.candidates = [
  FIXTURE.slot,
  {
    start_at: '2030-01-02T10:00:00.000Z',
    end_at: '2030-01-02T12:00:00.000Z',
    place: '杭州 · 武林广场地铁口',
  },
];

export const buildAcceptedExchange = (): Exchange => ({
  id: FIXTURE.exchangeId,
  from_user_id: FIXTURE.fromUser,
  to_user_id: FIXTURE.toUser,
  from_item_id: FIXTURE.fromItem,
  to_item_id: FIXTURE.toItem,
  status: ExchangeStatus.ACCEPTED,
  message: '多标签页面交竞争测试',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

// 双方从同一份本地快照启动时读到的预约：SELECTED，等待发起方确认锁定。
export const buildSelectedMeetupSnapshot = (): {
  meetups: import('@/models/meetup').Meetup[];
  events: import('@/models/meetup').MeetupEvent[];
} => {
  const now = new Date().toISOString();
  const meetup = {
    id: FIXTURE.meetupId,
    exchange_id: FIXTURE.exchangeId,
    from_user_id: FIXTURE.fromUser,
    to_user_id: FIXTURE.toUser,
    from_item_id: FIXTURE.fromItem,
    to_item_id: FIXTURE.toItem,
    item_ids: [FIXTURE.fromItem, FIXTURE.toItem],
    status: MeetupStatus.SELECTED,
    candidates: FIXTURE.candidates,
    selected_slot: FIXTURE.slot,
    locked_slot: null,
    round: 1,
    offerer_user_id: FIXTURE.fromUser,
    version: 2,
    created_at: now,
    updated_at: now,
  };
  const base = {
    meetup_id: FIXTURE.meetupId,
    exchange_id: FIXTURE.exchangeId,
  };
  const events = [
    {
      id: 'event_proposed',
      ...base,
      type: 'proposed',
      actor_user_id: FIXTURE.fromUser,
      round: 1,
      candidates: FIXTURE.candidates,
      created_at: now,
    },
    {
      id: 'event_selected',
      ...base,
      type: 'selected',
      actor_user_id: FIXTURE.toUser,
      round: 1,
      slot: FIXTURE.slot,
      created_at: now,
    },
  ];
  return { meetups: [meetup], events };
};
