import { defineStore } from 'pinia';

import { meetupApi } from '@/api/meetupApi';
import { MeetupStatus } from '@/constants/meetup';
import type { Meetup, MeetupDraft, MeetupSlot } from '@/models/meetup';
import { useAuthStore } from '@/stores/authStore';
import { message } from '@/utils/message';

// 所有写动作统一收口：成功走成功提示，失败把事务层拒绝原因冒泡成全局提示。
const runAction = async <T>(task: () => Promise<T>, successText: string, after: () => Promise<void>) => {
  try {
    const result = await task();
    await after();
    message(successText, 'success');
    return result;
  } catch (error) {
    await after();
    message(error instanceof Error ? error.message : '面交预约操作失败', 'error');
    return null;
  }
};

export const useMeetupStore = defineStore('meetups', {
  state: () => ({
    meetups: [] as Meetup[],
    statusFilter: 'all' as MeetupStatus | 'all',
    loading: false,
  }),
  getters: {
    byExchange: (state) => (exchangeId: string) =>
      state.meetups.find((item) => item.exchange_id === exchangeId && item.status !== MeetupStatus.CANCELLED),
    historyByExchange: (state) => (exchangeId: string) =>
      state.meetups.filter((item) => item.exchange_id === exchangeId),
    // 含已取消在内、最近更新的一条：用于取消后仍能回读上一次的确认/释放记录。
    latestByExchange: (state) => (exchangeId: string) =>
      state.meetups
        .filter((item) => item.exchange_id === exchangeId)
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0],
    active: (state) => state.meetups.filter((item) => item.status !== MeetupStatus.CANCELLED),
  },
  actions: {
    async hydrate() {
      this.loading = true;
      try {
        this.meetups = await meetupApi.listMeetups();
      } finally {
        this.loading = false;
      }
    },
    async refresh() {
      this.meetups = await meetupApi.listMeetups();
    },
    actorId(): string {
      return useAuthStore().currentUser?.id ?? '';
    },
    async create(draft: MeetupDraft) {
      return runAction(
        () => meetupApi.createForExchange(draft.exchange_id, this.actorId(), draft.candidates),
        '候选时段已发出，等待对方选定',
        () => this.refresh(),
      );
    },
    async offerSlots(id: string, candidates: MeetupSlot[], expectedVersion?: number) {
      return runAction(
        () => meetupApi.offerSlots(id, this.actorId(), candidates, expectedVersion),
        '新候选时段已给出',
        () => this.refresh(),
      );
    },
    async select(id: string, slotKey: string, expectedVersion?: number) {
      return runAction(
        () => meetupApi.selectSlot(id, this.actorId(), slotKey, expectedVersion),
        '已选定时段，等待对方确认锁定',
        () => this.refresh(),
      );
    },
    async confirm(id: string, expectedVersion?: number) {
      return runAction(
        () => meetupApi.confirm(id, this.actorId(), expectedVersion),
        '面交时段已锁定',
        () => this.refresh(),
      );
    },
    async reschedule(id: string, note?: string, expectedVersion?: number) {
      return runAction(
        () => meetupApi.reschedule(id, this.actorId(), note, expectedVersion),
        '旧时段已释放，请给出新的候选时段',
        () => this.refresh(),
      );
    },
    async cancel(id: string, note?: string, expectedVersion?: number) {
      return runAction(
        () => meetupApi.cancel(id, this.actorId(), note, expectedVersion),
        '面交预约已取消，时段已释放',
        () => this.refresh(),
      );
    },
  },
});
