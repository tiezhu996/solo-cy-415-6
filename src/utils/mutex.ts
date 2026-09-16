import { runCrossTabExclusive } from './crossTabLock';

/**
 * 极简异步互斥锁（不可重入），只在【当前标签页/进程】内串行化。
 *
 * localStorage / IndexedDB 没有真正的事务或唯一约束，"读-判-写"一旦交错就会
 * 同一时段被两条预约同时占用。面交写事务在同一把锁的临界区内完成
 * （读取最新数据 -> 状态机与占用校验 -> 原子写回 meetups + events）。
 */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  /** 串行执行 fn；同一把锁上后到的调用一定等前一个临界区完整结束后才进入。 */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = previous.then(fn, fn);
    // 无论 fn 成功与否都要释放锁，并把结果/异常原样透传给调用方。
    return run.finally(() => release!()) as Promise<T>;
  }
}

const MEETUP_LOCK_NAME = 'reswap:meetup-write';
const meetupInPageLock = new AsyncMutex();

interface MeetupLockOptions {
  /**
   * 'required'：跨标签页互斥为必需（确认/改期/取消）。后端不可用或建锁失败时，
   * runCrossTabExclusive 会抛 CrossTabLockError 且 fn 不会执行，绝不降级提交。
   * 'best-effort'（建约/给候选/选定）：无跨页后端时退回仅页内保护，保持原有行为。
   */
  crossTab?: 'required' | 'best-effort';
}

/**
 * 面交预约模块共用的写锁，两层叠加：
 *  1) 页内 AsyncMutex：串行化同一标签页内的并发调用；
 *  2) 跨领域排他锁（Web Locks / 测试注入的文件锁）：串行化多个标签页/进程，
 *     防止两个页面基于同一快照写回时互相覆盖、丢失终态事件。
 */
export const meetupWriteLock = {
  runExclusive<T>(fn: () => Promise<T>, options: MeetupLockOptions = {}): Promise<T> {
    const required = options.crossTab === 'required';
    return meetupInPageLock.runExclusive(() =>
      runCrossTabExclusive(MEETUP_LOCK_NAME, fn, required),
    );
  },
};
