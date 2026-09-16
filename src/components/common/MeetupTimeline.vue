<template>
  <div v-if="events.length" class="meetup-timeline">
    <h4>面交记录</h4>
    <ol>
      <li v-for="event in events" :key="event.id">
        <span class="meetup-timeline__dot" :class="`meetup-event--${event.type}`" />
        <div>
          <strong>{{ formatMeetupEvent(event.type) }}</strong>
          <small>{{ actorName(event.actor_user_id) }} · {{ formatDate(event.created_at) }}</small>
          <template v-if="event.slot">
            <small>时段：{{ formatDate(event.slot.start_at) }} · {{ event.slot.place }}</small>
          </template>
          <template v-else-if="event.released_slot">
            <small>释放旧时段：{{ formatDate(event.released_slot.start_at) }} · {{ event.released_slot.place }}</small>
          </template>
          <template v-else-if="event.candidates?.length">
            <small v-for="(candidate, index) in event.candidates" :key="slotKey(candidate)">
              候选 {{ index + 1 }}：{{ formatDate(candidate.start_at) }} · {{ candidate.place }}
            </small>
          </template>
          <small v-if="event.note">备注：{{ event.note }}</small>
        </div>
      </li>
    </ol>
  </div>
</template>

<script setup lang="ts">
import type { MeetupEvent } from '@/models/meetup';
import { useAuthStore } from '@/stores/authStore';
import { formatDate, formatMeetupEvent } from '@/utils/formatters';
import { normalizeSlotKey } from '@/utils/slotUtils';

defineProps<{ events: MeetupEvent[] }>();

const authStore = useAuthStore();
const actorName = (userId: string) => authStore.users.find((user) => user.id === userId)?.nickname ?? '对方';
const slotKey = normalizeSlotKey;
</script>
