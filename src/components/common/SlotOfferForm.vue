<template>
  <div class="slot-form">
    <p v-if="!compact" class="form-note">给出两个线下候选时段，由对方选定其中一个。</p>
    <div v-for="(_, index) in slots" :key="index" class="slot-form__row">
      <label>
        <span>候选 {{ index + 1 }} · 日期时间</span>
        <input v-model="slots[index].datetime" type="datetime-local" />
      </label>
      <label>
        <span>面交地点</span>
        <input v-model="slots[index].place" type="text" placeholder="如：地铁口 / 咖啡店" />
      </label>
    </div>
    <p v-if="error" class="slot-form__error">{{ error }}</p>
    <button class="primary-button" type="button" :disabled="submitting" @click="submit">
      {{ compact ? '给出新候选' : '发出两个候选时段' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';

import { MEETUP_CANDIDATE_COUNT } from '@/constants/meetup';
import type { MeetupSlot } from '@/models/meetup';

interface SlotFormRow {
  datetime: string;
  place: string;
}

withDefaults(defineProps<{ compact?: boolean; submitting?: boolean }>(), {
  compact: false,
  submitting: false,
});
const emit = defineEmits<{ submit: [slots: MeetupSlot[]] }>();

const buildDefaultRows = (): SlotFormRow[] => {
  const base = new Date();
  base.setMinutes(0, 0, 0);
  return [0, 1].map((offset) => {
    const date = new Date(base.getTime() + (offset + 2) * 24 * 60 * 60 * 1000);
    const datetime = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate(),
    ).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:00`;
    return { datetime, place: '' };
  });
};

const slots = reactive<SlotFormRow[]>(buildDefaultRows());
const error = ref('');

const submit = () => {
  error.value = '';
  if (slots.length !== MEETUP_CANDIDATE_COUNT) {
    error.value = `需要 ${MEETUP_CANDIDATE_COUNT} 个候选时段`;
    return;
  }
  if (slots.some((row) => !row.datetime || !row.place.trim())) {
    error.value = '请补全每个候选的时间与地点';
    return;
  }
  if (slots[0].datetime === slots[1].datetime) {
    error.value = '两个候选时段不能相同';
    return;
  }
  const payload: MeetupSlot[] = slots.map((row) => {
    const start = new Date(row.datetime);
    return {
      start_at: start.toISOString(),
      end_at: new Date(start.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      place: row.place.trim(),
    };
  });
  error.value = '';
  emit('submit', payload);
};
</script>
