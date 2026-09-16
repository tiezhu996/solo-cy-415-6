import type { MeetupSlot } from '@/models/meetup';

/**
 * 时段归一化键。同一面交时段的判定只看起点时刻（地点不参与去重），
 * 这样改期/确认时新旧时段的比对、跨预约的占用扫描都基于同一个口径。
 */
export const normalizeSlotKey = (slot: MeetupSlot): string => new Date(slot.start_at).getTime().toString();

/** 两个候选时段是否指向同一时刻（同一轮内禁止给出两个相同候选）。 */
export const isSameSlot = (a: MeetupSlot, b: MeetupSlot): boolean => normalizeSlotKey(a) === normalizeSlotKey(b);

/** 两件交换物品集合是否有交集（任一物品同一时段都不允许重复锁定）。 */
export const hasSharedItem = (itemIdsA: string[], itemIdsB: string[]): boolean =>
  itemIdsA.some((id) => itemIdsB.includes(id));

/**
 * 占用冲突：另一条预约占着同一时段，且交换物品有交集。
 * "同一物品同一时段只能有一组锁定"由它实现；物品不相交（纯粹巧合的同一时间）允许并存。
 */
export const isSlotConflict = (
  slot: MeetupSlot,
  holderItemIds: string[],
  currentItemIds: string[],
  holderSlot: MeetupSlot,
): boolean => isSameSlot(slot, holderSlot) && hasSharedItem(holderItemIds, currentItemIds);
