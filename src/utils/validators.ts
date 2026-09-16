import type { MeetupSlot } from '@/models/meetup';
import type { ItemDraft } from '@/models/item';
import type { UserDraft } from '@/models/user';

import { FORM_MESSAGES } from '@/constants/messages';
import { isSameSlot } from '@/utils/slotUtils';

export const validateItemDraft = (draft: Partial<ItemDraft>) => {
  if (!draft.title?.trim()) return FORM_MESSAGES.requiredTitle;
  if (!draft.description?.trim()) return FORM_MESSAGES.requiredDescription;
  return '';
};

export const validateUserDraft = (draft: Partial<UserDraft>) => {
  if (!draft.nickname?.trim()) return '昵称不能为空';
  if (!draft.phone?.trim()) return FORM_MESSAGES.requiredPhone;
  return '';
};

/** 面交候选时段表单校验：必须两个、时间不相同、地点非空、时间在未来。 */
export const validateMeetupCandidates = (candidates: MeetupSlot[]) => {
  if (candidates.length !== 2) return FORM_MESSAGES.meetupNeedCandidates;
  if (isSameSlot(candidates[0], candidates[1])) return FORM_MESSAGES.meetupNeedCandidates;
  if (candidates.some((slot) => !slot.place.trim())) return FORM_MESSAGES.meetupNeedPlace;
  if (candidates.some((slot) => new Date(slot.start_at).getTime() <= Date.now())) {
    return '候选时段需晚于当前时间';
  }
  return '';
};
