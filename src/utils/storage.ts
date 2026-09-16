import { del, get, set, setMany } from 'idb-keyval';

import type { PersistedEnvelope } from '@/types';

const STORAGE_VERSION = 1;
const DEFAULT_TTL = 1000 * 60 * 60 * 24 * 365;

const prefixed = (key: string) => `reswap:${key}`;

export const STORAGE_KEYS = {
  currentUserId: prefixed('current-user-id'),
  users: prefixed('users'),
  items: prefixed('items'),
  exchanges: prefixed('exchanges'),
  meetups: prefixed('meetups'),
  meetupEvents: prefixed('meetup-events'),
  theme: prefixed('theme'),
  lastClean: prefixed('last-clean'),
};

const now = () => Date.now();

const envelope = <T>(payload: T, ttl = DEFAULT_TTL): PersistedEnvelope<T> => ({
  version: STORAGE_VERSION,
  expiresAt: now() + ttl,
  payload,
});

const toPlain = <T>(payload: T): T => JSON.parse(JSON.stringify(payload)) as T;

const isExpired = <T>(data: PersistedEnvelope<T> | null) => {
  if (!data) return false;
  return Boolean(data.expiresAt && data.expiresAt < now());
};

const parseLocal = <T>(key: string): PersistedEnvelope<T> | null => {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedEnvelope<T>;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
};

const writeLocal = <T>(key: string, payload: T, ttl?: number) => {
  localStorage.setItem(key, JSON.stringify(envelope(payload, ttl)));
};

/** 一次批量提交的单键内容（已打包成信封 JSON，保证整体可一次原子写入）。 */
export interface BatchEntry {
  key: string;
  packedJson: string;
}

/**
 * 多键原子提交到 localStorage（纯同步、补偿式回滚）。
 *
 * 契约：正常返回 => 所有键都已生效；一旦中途抛错 => 已写入的键全部还原为事务前状态
 * （先前不存在的键会被删除），绝不留下"部分键已改、部分键没改"的单边变化。
 *
 * 抽出为不依赖 storage 实例的纯函数，既供 storage.commitBatch 复用，也便于单测。
 */
export const commitLocalBatch = (entries: BatchEntry[]): void => {
  const undo: Array<() => void> = [];
  try {
    for (const entry of entries) {
      const previous = localStorage.getItem(entry.key);
      const existed = previous !== null;
      undo.push(() => {
        if (existed) localStorage.setItem(entry.key, previous as string);
        else localStorage.removeItem(entry.key);
      });
      localStorage.setItem(entry.key, entry.packedJson);
    }
  } catch (error) {
    // 逆序补偿，把本批已改动的键全部恢复到提交前。
    for (let i = undo.length - 1; i >= 0; i -= 1) {
      try {
        undo[i]();
      } catch {
        /* 回滚本身尽力而为，原始错误优先抛出 */
      }
    }
    throw error;
  }
};

export const storage = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const localEnvelope = parseLocal<T>(key);
    if (isExpired(localEnvelope)) {
      await this.remove(key);
      return fallback;
    }
    if (localEnvelope?.version === STORAGE_VERSION) {
      return localEnvelope.payload;
    }

    const indexedEnvelope = await get<PersistedEnvelope<T>>(key);
    if (isExpired(indexedEnvelope ?? null)) {
      await this.remove(key);
      return fallback;
    }
    if (indexedEnvelope?.version === STORAGE_VERSION) {
      writeLocal(key, indexedEnvelope.payload);
      return indexedEnvelope.payload;
    }
    return fallback;
  },

  async set<T>(key: string, payload: T, ttl?: number): Promise<T> {
    const plainPayload = toPlain(payload);
    const packed = envelope(plainPayload, ttl);
    localStorage.setItem(key, JSON.stringify(packed));
    await set(key, packed);
    return plainPayload;
  },

  /**
   * 多键原子提交：先在内存完成深拷贝与打包，再由 commitLocalBatch 同步写 localStorage
   * （要么全部生效、要么补偿回滚到事务前），IndexedDB 只作镜像且容忍失败。
   *
   * 面交预约一次动作必须同时落下"预约主记录 + 面交流水"，统一走这里，避免任一步失败
   * 造成单边变化。
   */
  async commitBatch<T extends Record<string, unknown>>(batch: T): Promise<void> {
    const entries: BatchEntry[] = Object.entries(batch).map(([key, payload]) => ({
      key,
      packedJson: JSON.stringify(envelope(toPlain(payload))),
    }));
    const packed: Array<[string, PersistedEnvelope<unknown>]> = entries.map((entry, index) => [
      entry.key,
      JSON.parse(entry.packedJson) as PersistedEnvelope<unknown>,
    ]);
    // 同步原子提交；抛错即已整体回滚，直接向上冒泡，不触碰镜像。
    commitLocalBatch(entries);
    // localStorage 已成功提交，IndexedDB 仅作跨会话镜像：失败不推翻已提交结果。
    try {
      await setMany(packed);
    } catch {
      /* 镜像失败不影响本地一致性，下一次 storage.get 会以 localStorage 为准并回填 */
    }
  },

  async remove(key: string): Promise<void> {
    localStorage.removeItem(key);
    await del(key);
  },

  async cleanExpired(): Promise<void> {
    const keys = Object.values(STORAGE_KEYS);
    await Promise.all(
      keys.map(async (key) => {
        const localEnvelope = parseLocal<unknown>(key);
        if (isExpired(localEnvelope)) {
          await this.remove(key);
        }
      }),
    );
    localStorage.setItem(STORAGE_KEYS.lastClean, JSON.stringify(envelope(new Date().toISOString())));
  },

  createId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
  },
};
