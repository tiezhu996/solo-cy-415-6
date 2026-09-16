import dayjs from 'dayjs';

import { ExchangeStatus } from '@/constants/exchange';
import { ItemCondition, ItemStatus } from '@/constants/item';
import { MeetupEventType, MeetupStatus } from '@/constants/meetup';
import { MEETUP_EVENT_TEXT, STATUS_MESSAGE_MAP } from '@/constants/messages';

export const formatDate = (date: string) => dayjs(date).format('YYYY-MM-DD HH:mm');

export const formatItemStatus = (status: ItemStatus) => {
  const map: Record<ItemStatus, string> = {
    [ItemStatus.AVAILABLE]: '可交换',
    [ItemStatus.EXCHANGED]: '已交换',
    [ItemStatus.OFFLINE]: '已下架',
  };
  return map[status];
};

export const formatExchangeStatus = (status: ExchangeStatus) => {
  const map: Record<ExchangeStatus, string> = {
    [ExchangeStatus.PENDING]: '待确认',
    [ExchangeStatus.ACCEPTED]: '已同意',
    [ExchangeStatus.REJECTED]: '已拒绝',
    [ExchangeStatus.COMPLETED]: '已完成',
  };
  return map[status];
};

export const formatMeetupStatus = (status: MeetupStatus) => {
  const map: Record<MeetupStatus, string> = {
    [MeetupStatus.PROPOSED]: '待选择',
    [MeetupStatus.SELECTED]: '待确认',
    [MeetupStatus.LOCKED]: '已锁定',
    [MeetupStatus.RESCHEDULING]: '改期中',
    [MeetupStatus.CANCELLED]: '已取消',
  };
  return map[status];
};

export const formatMeetupEvent = (type: MeetupEventType) => MEETUP_EVENT_TEXT[type];

/** 面交时段：6 月 18 日（周四）14:00–16:00。 */
export const formatMeetupSlot = (startAt: string, endAt: string, place: string) =>
  `${dayjs(startAt).format('M 月 D 日 ddd HH:mm')}–${dayjs(endAt).format('HH:mm')} · ${place}`;

export const formatCondition = (condition: ItemCondition) => {
  const map: Record<ItemCondition, string> = {
    [ItemCondition.NEW]: '全新',
    [ItemCondition.LIKE_NEW]: '九成新',
    [ItemCondition.GOOD]: '八成新',
    [ItemCondition.WORN]: '战损',
  };
  return map[condition];
};

export const formatCreditLevel = (score: number) => {
  if (score >= 90) return '守约达人';
  if (score >= 75) return '稳定交换';
  if (score >= 60) return '新晋用户';
  return '需谨慎';
};

export const statusToneClass = (status: ItemStatus | ExchangeStatus | MeetupStatus) => {
  if (status === ItemStatus.AVAILABLE || status === ExchangeStatus.ACCEPTED || status === MeetupStatus.LOCKED) {
    return 'status-good';
  }
  if (
    status === ItemStatus.OFFLINE ||
    status === ExchangeStatus.REJECTED ||
    status === MeetupStatus.CANCELLED
  ) {
    return 'status-muted';
  }
  if (status === ItemStatus.EXCHANGED || status === ExchangeStatus.COMPLETED) return 'status-done';
  if (status === MeetupStatus.RESCHEDULING) return 'status-wait';
  return 'status-wait';
};

export const formatStatusMessage = (status: ItemStatus | ExchangeStatus | MeetupStatus) =>
  STATUS_MESSAGE_MAP[status];
