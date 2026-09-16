<template>
  <section class="meetup-panel">
    <header class="meetup-panel__head">
      <div>
        <p class="eyebrow">线下面交</p>
        <h3>面交预约</h3>
      </div>
      <span v-if="meetup" class="status-pill" :class="statusToneClass(meetup.status)">
        {{ formatMeetupStatus(meetup.status) }}
      </span>
      <span v-else-if="latestMeetup" class="status-pill status-muted">
        {{ formatMeetupStatus(latestMeetup.status) }}
      </span>
    </header>

    <!-- 交换通过且尚无预约：发起方给出两个候选时段 -->
    <SlotOfferForm v-if="canCreate" :submitting="busy" @submit="onCreate" />
    <p v-else-if="!meetup && !latestMeetup && !isFromParty" class="form-note">
      交换已通过，等待对方发起线下面交预约。
    </p>

    <!-- 上一次预约已取消：新建态下仍可回读其确认/释放记录 -->
    <MeetupTimeline v-if="!meetup && latestMeetup?.status === MeetupStatus.CANCELLED && timeline.length" :events="timeline" />

    <!-- 改期阶段：改期发起方补齐新候选 -->
    <SlotOfferForm
      v-if="meetup && meetup.status === MeetupStatus.RESCHEDULING && isOfferer"
      compact
      :submitting="busy"
      @submit="onOffer"
    />

    <template v-else-if="meetup">
      <!-- 当前协商轮次的候选时段 -->
      <div v-if="meetup.candidates.length" class="meetup-candidates">
        <p class="form-note">第 {{ meetup.round }} 轮候选 · {{ isOfferer ? '你提供，等待对方选定' : '请选定一个' }}</p>
        <button
          v-for="candidate in meetup.candidates"
          :key="slotKey(candidate)"
          type="button"
          class="meetup-slot"
          :class="{ 'meetup-slot--active': slotKey(candidate) === chosenKey }"
          :disabled="!canSelect || busy"
          @click="chosenKey = slotKey(candidate)"
        >
          <strong>{{ formatDate(candidate.start_at) }}</strong>
          <small>{{ candidate.place }}</small>
        </button>
      </div>

      <!-- 已锁定 / 已选定的时段 -->
      <div v-if="activeSlot" class="meetup-locked">
        <span class="pill">{{ meetup.status === MeetupStatus.LOCKED ? '已锁定时段' : '已选定时段' }}</span>
        <strong>{{ formatDate(activeSlot.start_at) }}</strong>
        <small>{{ activeSlot.place }}</small>
      </div>

      <p v-else-if="meetup.status === MeetupStatus.RESCHEDULING" class="form-note">
        {{ isOfferer ? '请在上方给出新的两个候选时段。' : '对方正在给出新的候选时段，旧时段已释放。' }}
      </p>

      <!-- 操作区：确认 / 改期 / 取消 -->
      <div class="meetup-actions">
        <button
          v-if="meetup.status === MeetupStatus.PROPOSED && canSelect"
          class="primary-button"
          type="button"
          :disabled="!chosenKey || busy"
          @click="onSelect"
        >
          选定此时段
        </button>
        <button
          v-if="meetup.status === MeetupStatus.SELECTED && isOfferer"
          class="primary-button"
          type="button"
          :disabled="busy"
          @click="onConfirm"
        >
          确认并锁定
        </button>
        <button
          v-if="canReschedule"
          class="secondary-button"
          type="button"
          :disabled="busy"
          @click="onReschedule"
        >
          改期
        </button>
        <button v-if="canCancel" class="meetup-actions__cancel" type="button" :disabled="busy" @click="onCancel">
          取消面交
        </button>
      </div>

      <!-- 只追加的面交流水：确认记录与被释放的旧时段都可回读 -->
      <MeetupTimeline :events="timeline" />
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { showConfirmDialog } from 'vant';

import SlotOfferForm from '@/components/common/SlotOfferForm.vue';
import MeetupTimeline from '@/components/common/MeetupTimeline.vue';
import { ExchangeStatus } from '@/constants/exchange';
import { MeetupStatus } from '@/constants/meetup';
import { useMeetupTimeline } from '@/hooks/useMeetupTimeline';
import type { Exchange } from '@/models/exchange';
import type { MeetupSlot } from '@/models/meetup';
import { useAuthStore } from '@/stores/authStore';
import { useMeetupStore } from '@/stores/meetupStore';
import { formatDate, formatMeetupStatus, statusToneClass } from '@/utils/formatters';
import { normalizeSlotKey } from '@/utils/slotUtils';

const props = defineProps<{ exchange: Exchange }>();

const authStore = useAuthStore();
const meetupStore = useMeetupStore();

const meetup = computed(() => meetupStore.byExchange(props.exchange.id));
// 含已取消的最近一条：取消后仍可回读其确认/释放记录。
const latestMeetup = computed(() => meetupStore.latestByExchange(props.exchange.id));
const busy = ref(false);
const chosenKey = ref('');

const { timeline, hydrate } = useMeetupTimeline(() => meetup.value?.id ?? latestMeetup.value?.id);

const currentUserId = computed(() => authStore.currentUser?.id ?? '');
const isFromParty = computed(() => currentUserId.value === props.exchange.from_user_id);
const isOfferer = computed(() => Boolean(meetup.value && currentUserId.value === meetup.value.offerer_user_id));

const canCreate = computed(
  () =>
    props.exchange.status === ExchangeStatus.ACCEPTED &&
    !meetup.value &&
    isFromParty.value,
);

const canSelect = computed(
  () => meetup.value?.status === MeetupStatus.PROPOSED && !isOfferer.value,
);
const canReschedule = computed(() =>
  [MeetupStatus.SELECTED, MeetupStatus.LOCKED].includes(meetup.value?.status as MeetupStatus),
);
const canCancel = computed(() =>
  [
    MeetupStatus.PROPOSED,
    MeetupStatus.SELECTED,
    MeetupStatus.LOCKED,
    MeetupStatus.RESCHEDULING,
  ].includes(meetup.value?.status as MeetupStatus),
);

const activeSlot = computed<MeetupSlot | null>(() => meetup.value?.locked_slot ?? meetup.value?.selected_slot ?? null);

const draftBase = computed(() => ({
  exchange_id: props.exchange.id,
  from_user_id: props.exchange.from_user_id,
  to_user_id: props.exchange.to_user_id,
  from_item_id: props.exchange.from_item_id,
  to_item_id: props.exchange.to_item_id,
}));

const slotKey = normalizeSlotKey;

const onSelect = async () => {
  if (!meetup.value || !chosenKey.value) return;
  // 先快照 id 与版本：若等待期间对方改期/取消导致版本前进，本次选定将被 CAS 拒绝。
  const { id, version } = meetup.value;
  const chosen = chosenKey.value;
  busy.value = true;
  try {
    await meetupStore.select(id, chosen, version);
    chosenKey.value = '';
  } finally {
    busy.value = false;
  }
  await hydrate();
};

const onCreate = async (slots: MeetupSlot[]) => {
  busy.value = true;
  try {
    await meetupStore.create({ ...draftBase.value, candidates: slots });
  } finally {
    busy.value = false;
  }
  await hydrate();
};

const onOffer = async (slots: MeetupSlot[]) => {
  if (!meetup.value) return;
  const { id, version } = meetup.value;
  busy.value = true;
  try {
    await meetupStore.offerSlots(id, slots, version);
  } finally {
    busy.value = false;
  }
  await hydrate();
};

const onConfirm = async () => {
  if (!meetup.value) return;
  const { id, version } = meetup.value;
  busy.value = true;
  try {
    await meetupStore.confirm(id, version);
  } finally {
    busy.value = false;
  }
  await hydrate();
};

const onReschedule = async () => {
  if (!meetup.value) return;
  // 在弹确认框之前就固定版本：用户犹豫的这段时间若对方已操作，提交会被 CAS 拒绝。
  const { id, version } = meetup.value;
  try {
    await showConfirmDialog({
      title: '确认改期？',
      message: '改期会立即释放当前时段，并由你给出新的两个候选时段。',
    });
  } catch {
    return;
  }
  busy.value = true;
  try {
    await meetupStore.reschedule(id, undefined, version);
  } finally {
    busy.value = false;
  }
  await hydrate();
};

const onCancel = async () => {
  if (!meetup.value) return;
  const { id, version } = meetup.value;
  try {
    await showConfirmDialog({
      title: '取消面交？',
      message: '取消后当前时段立即释放，可被其它交换重新预约；已有确认记录仍会保留。',
    });
  } catch {
    return;
  }
  busy.value = true;
  try {
    await meetupStore.cancel(id, undefined, version);
  } finally {
    busy.value = false;
  }
  await hydrate();
};

// 每次本地写入完成后刷新一次事件，保证时间线与"释放旧时段"记录及时回读；
// 同时统一解除忙碌态（create/offer 由子表单置位，version 变化即代表写入已收口）。
watch(
  () => meetup.value?.version,
  async () => {
    busy.value = false;
    await hydrate();
  },
);

watch(
  () => meetup.value?.candidates,
  (candidates) => {
    if (candidates?.length && meetup.value?.status === MeetupStatus.PROPOSED) {
      chosenKey.value = '';
    }
  },
);

onMounted(() => {
  void hydrate();
});
</script>
