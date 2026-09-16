import { ExchangeStatus } from './exchange';
import { ItemStatus } from './item';
import { MeetupEventType, MeetupStatus } from './meetup';

export const PAGE_MESSAGES = {
  homeEmpty: '暂时没有符合条件的闲置物品',
  publishReady: '发布后会同步写入 localStorage 和 IndexedDB',
  exchangeEmpty: '还没有交换请求，先去首页挑一件合眼缘的物品',
  profileUpdated: '个人资料已更新',
  meetupEmpty: '交换请求被同意后，由发起方给出两个线下面交候选时段',
};

export const FORM_MESSAGES = {
  requiredTitle: '物品标题不能为空',
  requiredDescription: '请描述你希望交换的物品',
  requiredPhone: '请填写联系方式',
  imageLimit: '最多上传 4 张图片',
  exchangeNeedOwnItem: '请先发布一件可交换物品',
  meetupNeedCandidates: '请给出两个不同的候选时段',
  meetupNeedPlace: '请填写面交地点',
};

export const LOG_MESSAGES = {
  storageHydrated: 'storage hydrated with status maps',
  itemStatusUsed: `ItemStatus includes ${ItemStatus.AVAILABLE}, ${ItemStatus.EXCHANGED}, ${ItemStatus.OFFLINE}`,
  exchangeStatusUsed: `ExchangeStatus includes ${ExchangeStatus.PENDING}, ${ExchangeStatus.ACCEPTED}, ${ExchangeStatus.REJECTED}, ${ExchangeStatus.COMPLETED}`,
  meetupStatusUsed: `MeetupStatus includes ${MeetupStatus.PROPOSED}, ${MeetupStatus.SELECTED}, ${MeetupStatus.LOCKED}, ${MeetupStatus.RESCHEDULING}, ${MeetupStatus.CANCELLED}`,
  meetupMutexUsed: 'meetup writes are serialized through meetupWriteLock',
};

export const STATUS_MESSAGE_MAP = {
  [ItemStatus.AVAILABLE]: '这件物品可发起交换',
  [ItemStatus.EXCHANGED]: '这件物品已完成交换',
  [ItemStatus.OFFLINE]: '这件物品已下架',
  [ExchangeStatus.PENDING]: '等待对方确认',
  [ExchangeStatus.ACCEPTED]: '交换已同意，可预约线下面交',
  [ExchangeStatus.REJECTED]: '交换请求已拒绝',
  [ExchangeStatus.COMPLETED]: '交换流程已完成',
  [MeetupStatus.PROPOSED]: '已给出两个候选时段，等待对方选定',
  [MeetupStatus.SELECTED]: '对方已选定时段，等待确认锁定',
  [MeetupStatus.LOCKED]: '面交时段已锁定',
  [MeetupStatus.RESCHEDULING]: '旧时段已释放，等待新的候选时段',
  [MeetupStatus.CANCELLED]: '面交已取消，时段已释放',
} as const;

export const MEETUP_EVENT_TEXT: Record<MeetupEventType, string> = {
  [MeetupEventType.PROPOSED]: '给出候选时段',
  [MeetupEventType.SELECTED]: '选定时段',
  [MeetupEventType.CONFIRMED]: '确认并锁定时段',
  [MeetupEventType.RESCHEDULED]: '发起改期，释放旧时段',
  [MeetupEventType.CANCELLED]: '取消面交，释放时段',
};
