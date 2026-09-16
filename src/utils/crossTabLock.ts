/**
 * 跨「领域」的命名互斥锁。一个领域 = 一个浏览器标签页 / 一个独立 JS 进程。
 *
 * 仅靠进程内的 AsyncMutex 无法阻止两个标签页各自"读快照→改→写回"互相覆盖
 * （最后写入者胜，会丢终态事件、造成主记录与流水分裂）。因此面交写事务在页内锁之外，
 * 还要再套一层跨领域排他锁：
 *
 * - 真实浏览器：优先使用 Web Locks API（navigator.locks），同源多标签页互斥，
 *   标签页崩溃时浏览器自动释放，不会死锁。
 * - 多标签页测试：通过 globalThis.__RESWAP_CROSS_TAB_LOCK__ 注入一把真实文件锁，
 *   多个独立子进程竞争同一份磁盘 localStorage，得到与浏览器一致的跨进程互斥。
 *
 * 重要：互斥不可用时【不静默降级】。终态动作（确认/改期/取消）必须跨页互斥，
 * 拿不到锁就抛 CrossTabLockError 并停止提交，绝不能退回"只有页内锁"而再次产生
 * 两个成功终态。普通非终态动作可传 required=false，退化为仅页内保护。
 *
 * 错误约定：建锁/抢锁失败抛 CrossTabLockError；临界区内 fn 的业务错误（CAS、状态机等）
 * 必须原样透传，二者不能互相误判。
 */

export class CrossTabLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrossTabLockError';
  }
}

export interface CrossRealmLockAdapter {
  /**
   * 在跨领域排他锁内执行 fn。
   * 约定：建锁/抢锁失败抛 CrossTabLockError；fn 内部抛出的业务错误原样向上透传。
   */
  runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

declare global {
  // eslint-disable-next-line no-var
  var __RESWAP_CROSS_TAB_LOCK__: CrossRealmLockAdapter | undefined;
}

interface NavigatorLocks {
  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<T> | T,
  ): Promise<T>;
}

const getWebLocks = (): NavigatorLocks | undefined => {
  if (typeof navigator === 'undefined') return undefined;
  const locks = (navigator as unknown as { locks?: NavigatorLocks }).locks;
  return locks && typeof locks.request === 'function' ? locks : undefined;
};

export const CROSS_TAB_LOCK_UNAVAILABLE_MESSAGE =
  '跨标签页互斥不可用，为避免重复占用已阻止本次确认/改期/取消；请在支持的浏览器中重试';

const isLockFailure = (error: unknown): boolean =>
  error instanceof CrossTabLockError ||
  (error instanceof DOMException && error.name === 'AbortError');

/**
 * 在跨领域排他锁内执行 fn。
 *
 * @param required true（终态动作）：无后端或建锁失败 -> 抛 CrossTabLockError 且不执行 fn；
 *                 false（普通非终态动作）：无后端则仅靠页内锁执行，保持原有行为。
 */
export const runCrossTabExclusive = async <T>(
  name: string,
  fn: () => Promise<T>,
  required: boolean,
): Promise<T> => {
  // 注入适配器（多标签页测试用文件锁）：它已按约定区分锁错误与业务错误，直接透传。
  const injected = globalThis.__RESWAP_CROSS_TAB_LOCK__;
  if (injected) return injected.runExclusive(name, fn);

  const locks = getWebLocks();
  if (!locks) {
    if (required) throw new CrossTabLockError(CROSS_TAB_LOCK_UNAVAILABLE_MESSAGE);
    return fn();
  }

  try {
    return await locks.request(name, { mode: 'exclusive' }, fn);
  } catch (error) {
    // 只把明确的建锁失败归类为锁错误；临界区内的业务错误原样透传。
    if (isLockFailure(error)) {
      if (error instanceof CrossTabLockError) throw error;
      throw new CrossTabLockError(`跨标签页互斥被中断，已阻止本次提交：${(error as Error).message}`);
    }
    throw error;
  }
};
