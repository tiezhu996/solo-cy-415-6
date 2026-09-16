import { computed, ref, unref, type MaybeRefOrGetter } from 'vue';

import { meetupApi } from '@/api/meetupApi';
import type { MeetupEvent } from '@/models/meetup';

/**
 * 读取面交流水事件（只追加历史）。
 *
 * 确认 / 改期 / 取消都会留下不可变事件，旧时段被释放后仍可经由此时间线回读
 * （RESCHEDULED / CANCELLED 事件携带 released_slot）。
 */
export const useMeetupTimeline = (meetupIdSource: MaybeRefOrGetter<string | undefined>) => {
  const events = ref<MeetupEvent[]>([]);
  const loaded = ref(false);

  const hydrate = async () => {
    events.value = await meetupApi.listEvents();
    loaded.value = true;
  };

  const timeline = computed(() => {
    const meetupId = unref(meetupIdSource);
    if (!meetupId) return [];
    return events.value
      .filter((event) => event.meetup_id === meetupId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  });

  return { events, timeline, loaded, hydrate };
};
