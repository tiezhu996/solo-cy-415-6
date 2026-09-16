/*
 * 跨页文件锁 —— 在多标签页测试里等价于浏览器的 Web Locks API。
 *
 * 多个独立子进程用 O_EXCL 原子创建同名锁文件竞争，持有者跑完临界区后释放；
 * 崩溃残留的陈旧锁（mtime 超过 TTL）可被接管。它只做跨进程互斥，
 * 页内并发仍由应用自己的 AsyncMutex 负责（与浏览器中的两层结构一致）。
 *
 * 与应用的错误约定一致：抢锁/建锁失败抛 CrossTabLockError（因此终态动作会被中止、
 * 绝不降级提交）；临界区内 fn 的业务错误原样透传。
 */
import { mkdirSync, openSync, closeSync, existsSync, statSync, renameSync, unlinkSync, utimesSync } from 'node:fs';

import { CrossTabLockError, type CrossRealmLockAdapter } from '@/utils/crossTabLock';

const TTL_MS = 10_000;
const ACQUIRE_TIMEOUT_MS = 15_000;
const BASE_DELAY_MS = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FileCrossTabLock implements CrossRealmLockAdapter {
  constructor(private readonly lockDir: string) {
    mkdirSync(this.lockDir, { recursive: true });
  }

  private lockPath(name: string) {
    return `${this.lockDir}/${encodeURIComponent(name)}.lock`;
  }

  private tryAcquire(path: string): boolean {
    try {
      const fd = openSync(path, 'wx');
      closeSync(fd);
      utimesSync(path, new Date(), new Date());
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw new CrossTabLockError(`跨页锁文件无法创建：${code ?? 'unknown'}`);
      return false;
    }
  }

  private isStale(path: string): boolean {
    try {
      return Date.now() - statSync(path).mtimeMs > TTL_MS;
    } catch {
      return false;
    }
  }

  async runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const path = this.lockPath(name);
    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
    let heldPath = '';
    let attempt = 0;

    while (Date.now() < deadline) {
      if (this.tryAcquire(path)) {
        heldPath = path;
        break;
      }
      if (existsSync(path) && this.isStale(path)) {
        // 接管陈旧锁：先把旧锁原子改名归自己，再立刻以 O_EXCL 重建主锁文件，
        // 重建这一步仍是排他的——抢不到说明别人已先重建，那就归还并继续等待，
        // 因此接管过程不会出现两个人同时持锁。
        const takeover = `${path}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
        try {
          renameSync(path, takeover);
          if (this.tryAcquire(path)) {
            unlinkSync(takeover);
            heldPath = path;
            break;
          }
          unlinkSync(takeover);
        } catch {
          /* 别人先接管或已释放，继续正常重试 */
        }
      }
      attempt += 1;
      await sleep(Math.min(120, BASE_DELAY_MS * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 6));
    }

    if (!heldPath) {
      throw new CrossTabLockError('跨页锁在限定时间内未能获取（互斥建立失败）');
    }

    try {
      // 注意：fn 的业务错误必须原样冒泡，不能改写成 CrossTabLockError。
      return await fn();
    } finally {
      try {
        unlinkSync(heldPath);
      } catch {
        /* 锁可能已被 TTL 接管，忽略 */
      }
    }
  }
}

/** 把文件锁注册为应用的跨页锁（对齐 navigator.locks 的注入点）。 */
export const installFileCrossTabLock = (lockDir: string): FileCrossTabLock => {
  const adapter = new FileCrossTabLock(lockDir);
  globalThis.__RESWAP_CROSS_TAB_LOCK__ = adapter;
  return adapter;
};

/** 安装一个"建锁必失败"的适配器，用于验证终态动作被明确中止。 */
export const installFailingCrossTabLock = (message = '模拟：跨页互斥建立失败'): void => {
  globalThis.__RESWAP_CROSS_TAB_LOCK__ = {
    async runExclusive() {
      throw new CrossTabLockError(message);
    },
  };
};
