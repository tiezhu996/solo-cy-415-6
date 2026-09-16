/*
 * 真实跨页存储：多个独立子进程共享同一份"localStorage"（落盘 JSON）。
 *
 * 对齐浏览器语义的关键：同源 localStorage 在标签页之间是【实时共享】的——A 页 setItem
 * 后，B 页 getItem 立即能读到。因此这里【不做进程内缓存】：
 *   - getItem 每次都重新读盘（反映其它页面已提交的写入）；
 *   - setItem 为"读整份 → 改一个键 → 临时文件 + rename 原子落盘"。
 * 单键 setItem 自身不会出现半截 JSON；而跨键的 read-modify-write 交错则交给跨页锁排除
 * （见 file-lock.ts，对应 navigator.locks）。关闭跨页锁的基线里，这种交错会真实地丢更新，
 * 正是要复现的跨页覆盖。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FileLocalStorageOptions {
  file: string;
}

class FileLocalStorage implements Storage {
  private file: string;

  constructor(options: FileLocalStorageOptions) {
    this.file = options.file;
    mkdirSync(dirname(this.file), { recursive: true });
  }

  private readAll(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private writeAtomic(store: Record<string, string>): void {
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(store));
    renameSync(tmp, this.file);
  }

  get length(): number {
    return Object.keys(this.readAll()).length;
  }

  clear(): void {
    this.writeAtomic({});
  }

  getItem(key: string): string | null {
    const store = this.readAll();
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
  }

  key(index: number): string | null {
    return Object.keys(this.readAll())[index] ?? null;
  }

  removeItem(key: string): void {
    const store = this.readAll();
    delete store[key];
    this.writeAtomic(store);
  }

  setItem(key: string, value: string): void {
    const store = this.readAll();
    store[key] = String(value);
    this.writeAtomic(store);
  }
}

/** 在当前进程安装文件式 localStorage。必须在任何 storage.ts 调用前执行。 */
export const installFileLocalStorage = (file: string): Storage => {
  const shim = new FileLocalStorage({ file });
  Object.defineProperty(globalThis, 'localStorage', {
    value: shim,
    configurable: true,
    writable: true,
  });
  return shim;
};
