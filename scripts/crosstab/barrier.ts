/*
 * 文件系统栅栏：让两个独立子进程在真正提交前同时就位，然后一起放行，
 * 以最大化"近同时提交"的交错，不依赖任何跨进程内存协调。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FsBarrier {
  private readonly dir: string;
  private readonly parties: number;

  constructor(dir: string, parties = 2) {
    this.dir = dir;
    this.parties = parties;
    mkdirSync(dir, { recursive: true });
  }

  /** 用当前进程的身份报到，然后等待所有参与方报到。 */
  async arriveAndWait(label: string, timeoutMs = 15_000): Promise<void> {
    writeFileSync(join(this.dir, `${label}.ready`), String(process.pid));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const arrived = readdirSync(this.dir).filter((name) => name.endsWith('.ready')).length;
      if (arrived >= this.parties) return;
      await sleep(2);
    }
    throw new Error(`barrier timeout: only ${readdirSync(this.dir).length} parties arrived`);
  }

  static exists(dir: string): boolean {
    return existsSync(dir);
  }
}
