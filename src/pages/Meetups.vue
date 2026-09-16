<template>
  <section class="page meetups-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">线下面交</p>
        <h1>把换物约到线下</h1>
      </div>
    </div>

    <div class="stats-row">
      <span>有效预约 {{ stats.active }}</span>
      <span>已锁定 {{ stats.locked }}</span>
      <span>待选择/确认 {{ stats.pending }}</span>
      <span>改期中 {{ stats.rescheduling }}</span>
    </div>

    <div v-if="acceptedExchanges.length" class="meetup-list">
      <article v-for="exchange in acceptedExchanges" :key="exchange.id" class="meetup-entry">
        <header class="meetup-entry__head">
          <div>
            <strong>{{ itemTitle(exchange.from_item_id) }} ↔ {{ itemTitle(exchange.to_item_id) }}</strong>
            <small>{{ userName(exchange.from_user_id) }} 与 {{ userName(exchange.to_user_id) }}</small>
          </div>
          <span class="status-pill status-good">交换已同意</span>
        </header>
        <MeetupPanel :exchange="exchange" />
      </article>
    </div>
    <EmptyState v-else title="暂无可预约的面交" description="交换请求被同意后，可由发起方在此给出两个候选时段。" mark="约" />

    <!-- 全平台当前锁定时段：直观呈现"同一物品同一时段只有一组" -->
    <section v-if="lockedSlots.length" class="meetup-locked-grid">
      <h2>当前已锁定时段</h2>
      <div class="stats-row">
        <span v-for="entry in lockedSlots" :key="entry.meetup.id">
          {{ formatDate(entry.slot.start_at) }} · {{ entry.slot.place }}（{{ itemTitle(entry.meetup.from_item_id) }}）
        </span>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import EmptyState from '@/components/common/EmptyState.vue';
import MeetupPanel from '@/components/common/MeetupPanel.vue';
import { ExchangeStatus } from '@/constants/exchange';
import { MeetupStatus } from '@/constants/meetup';
import { useAuthStore } from '@/stores/authStore';
import { useExchangeStore } from '@/stores/exchangeStore';
import { useItemStore } from '@/stores/itemStore';
import { useMeetupStore } from '@/stores/meetupStore';
import { formatDate } from '@/utils/formatters';

const authStore = useAuthStore();
const itemStore = useItemStore();
const exchangeStore = useExchangeStore();
const meetupStore = useMeetupStore();

const acceptedExchanges = computed(() =>
  exchangeStore.exchanges.filter(
    (exchange) =>
      exchange.status === ExchangeStatus.ACCEPTED &&
      (exchange.from_user_id === authStore.currentUser?.id || exchange.to_user_id === authStore.currentUser?.id),
  ),
);

const myMeetups = computed(() =>
  meetupStore.meetups.filter(
    (meetup) =>
      meetup.from_user_id === authStore.currentUser?.id || meetup.to_user_id === authStore.currentUser?.id,
  ),
);

const stats = computed(() => ({
  active: myMeetups.value.filter((item) => item.status !== MeetupStatus.CANCELLED).length,
  locked: myMeetups.value.filter((item) => item.status === MeetupStatus.LOCKED).length,
  pending: myMeetups.value.filter((item) =>
    [MeetupStatus.PROPOSED, MeetupStatus.SELECTED].includes(item.status),
  ).length,
  rescheduling: myMeetups.value.filter((item) => item.status === MeetupStatus.RESCHEDULING).length,
}));

const lockedSlots = computed(() =>
  meetupStore.active
    .filter((meetup) => meetup.status === MeetupStatus.LOCKED && meetup.locked_slot)
    .map((meetup) => ({ meetup, slot: meetup.locked_slot! })),
);

const itemTitle = (id: string) => itemStore.items.find((item) => item.id === id)?.title ?? '未知物品';
const userName = (id: string) => authStore.users.find((user) => user.id === id)?.nickname ?? '用户';
</script>
