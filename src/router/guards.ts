import type { Router } from 'vue-router';

import { ExchangeStatus } from '@/constants/exchange';
import { ItemStatus } from '@/constants/item';
import { MeetupStatus } from '@/constants/meetup';
import { LOG_MESSAGES } from '@/constants/messages';
import { useAuthStore } from '@/stores/authStore';
import { useExchangeStore } from '@/stores/exchangeStore';
import { useItemStore } from '@/stores/itemStore';
import { useMeetupStore } from '@/stores/meetupStore';

export const setupRouterGuards = (router: Router) => {
  router.beforeEach(async () => {
    const authStore = useAuthStore();
    const itemStore = useItemStore();
    const exchangeStore = useExchangeStore();
    const meetupStore = useMeetupStore();
    if (!authStore.currentUser) {
      await authStore.hydrate();
    }
    if (!itemStore.items.length) {
      await itemStore.hydrate();
    }
    if (!exchangeStore.exchanges.length) {
      await exchangeStore.hydrate();
    }
    if (!meetupStore.meetups.length) {
      await meetupStore.hydrate();
    }

    const statusProbe = itemStore.items.some((item) => item.status === ItemStatus.AVAILABLE);
    const exchangeProbe = exchangeStore.exchanges.some((item) => item.status === ExchangeStatus.PENDING);
    const meetupProbe = meetupStore.meetups.some((item) => item.status === MeetupStatus.LOCKED);
    if (import.meta.env.DEV && (statusProbe || exchangeProbe || meetupProbe)) {
      console.debug(LOG_MESSAGES.storageHydrated);
    }
    return true;
  });
};
