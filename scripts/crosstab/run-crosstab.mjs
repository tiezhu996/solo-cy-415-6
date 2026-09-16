/*
 * 可重复执行的多标签页竞争测试编排器。
 *
 * 每一轮：
 *   1) seed 子进程写入同一份本地快照（SELECTED，待终态）；
 *   2) 两个【独立子进程】（= 两个标签页，各自页内锁、不共享内存）过文件栅栏后
 *      近同时提交 confirm 与 cancel；
 *   3) 第三个独立进程重新加载，核对版本、占用、事件链只收口一次。
 *
 * 全程使用真实跨页存储：多进程共享同一份磁盘 localStorage，唯一跨进程协调是
 * 应用自己申请的跨页文件锁（等价 navigator.locks）。默认开启；--baseline 关闭它，
 * 用真实覆盖来演示诊断输出。
 *
 * 用法：node scripts/crosstab/run-crosstab.mjs [轮数] [--baseline]
 */
import { build } from '../../node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const WORKER = join(here, '.worker-bundle.mjs');

const argv = process.argv.slice(2);
const mode = argv.includes('--baseline')
  ? 'baseline'
  : argv.includes('--lock-unavailable')
    ? 'lock-unavailable'
    : 'normal';
const explicitRounds = argv.find((a) => /^\d+$/.test(a));
const rounds = Number(explicitRounds ?? (mode === 'normal' ? 30 : mode === 'baseline' ? 12 : 10));

const TERMINAL = ['confirmed', 'rescheduled', 'cancelled'];

const buildWorker = async () => {
  const result = await build({
    entryPoints: [join(here, 'worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    alias: { '@': join(ROOT, 'src') },
  });
  // Node 20 可直接写 ESM .mjs。
  const { writeFileSync } = await import('node:fs');
  writeFileSync(WORKER, result.outputFiles[0].text);
};

const runWorker = (dir, role, extraEnv = {}) =>
  new Promise((resolve, reject) => {
    const outFile = join(dir, `out-${role}.json`);
    const child = spawn(process.execPath, [WORKER], {
      env: {
        ...process.env,
        DATA_FILE: join(dir, 'store.json'),
        LOCK_DIR: join(dir, 'locks'),
        BARRIER_DIR: join(dir, 'barrier'),
        BARRIER_PARTIES: '2',
        LOCK_MODE: 'file',
        OUT_FILE: outFile,
        ...extraEnv,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!existsSync(outFile)) return reject(new Error(`${role} 无输出，exit=${code}\n${stderr}`));
      try {
        resolve(JSON.parse(readFileSync(outFile, 'utf8')));
      } catch (e) {
        reject(new Error(`${role} 输出无法解析: ${e}\n${stderr}`));
      }
    });
  });

const seed = (dir) => runWorker(dir, 'seed', { MODE: 'seed' });

// 两个终态动作近同时提交。lockModes 可分别指定每页的跨页锁后端；clearBarrier 用于复用目录。
const contendBoth = (
  dir,
  { confirmMode = 'file', cancelMode = 'file', suffix = '' } = {},
) =>
  Promise.all([
    runWorker(dir, `confirm${suffix}`, {
      MODE: 'contend',
      ROLE: 'confirm',
      PARTY: `confirm${suffix}`,
      LOCK_MODE: confirmMode,
    }),
    runWorker(dir, `cancel${suffix}`, {
      MODE: 'contend',
      ROLE: 'cancel',
      PARTY: `cancel${suffix}`,
      LOCK_MODE: cancelMode,
    }),
  ]);

const reread = (dir) => runWorker(dir, 'read', { MODE: 'read' });

const summarize = (out) => ({
  ok: out.ok,
  error: out.error,
  returnedStatus: out.returned?.status ?? null,
  returnedVersion: out.returned?.version ?? null,
  rereadStatus: out.reread?.status ?? null,
  eventTypes: out.eventTypes ?? null,
});

// 判定一轮是否"只收口一次"，并在覆盖时收集诊断。
const evaluate = (confirmOut, cancelOut, finalRead) => {
  const defects = [];
  const winner = confirmOut.ok ? 'confirm' : cancelOut.ok ? 'cancel' : null;
  const committed = [confirmOut.ok, cancelOut.ok].filter(Boolean).length;

  if (committed === 0) defects.push('两个终态动作都失败（没有任何收口）');
  if (committed > 1) defects.push('两个终态动作都提交成功（发生跨页覆盖，本应只有一个生效）');

  const terminalTypes = finalRead.terminalEventTypes;
  if (terminalTypes.length !== 1) {
    defects.push(`终态事件数量=${terminalTypes.length}（应为 1）：${JSON.stringify(terminalTypes)}`);
  }

  // 终态事件必须与最终主记录状态一致（否则即主记录/流水被撕裂）。
  if (finalRead.status === 'locked' && terminalTypes[0] !== 'confirmed') {
    defects.push(`主记录=locked 但终态事件=${terminalTypes[0]}（主记录与流水分裂）`);
  }
  if (finalRead.status === 'cancelled' && terminalTypes[0] !== 'cancelled') {
    defects.push(`主记录=cancelled 但终态事件=${terminalTypes[0]}（主记录与流水分裂）`);
  }

  // 占用必须与状态一致：locked 恰好 1 组占用；cancelled 0 组。
  if (finalRead.status === 'locked' && finalRead.holdersCount !== 1) {
    defects.push(`locked 但同物品同时段占用数=${finalRead.holdersCount}（应为 1）`);
  }
  if (finalRead.status === 'cancelled' && finalRead.holdersCount !== 0) {
    defects.push(`cancelled 但仍有 ${finalRead.holdersCount} 组占用未释放`);
  }
  if (!['locked', 'cancelled'].includes(finalRead.status)) {
    defects.push(`最终状态=${finalRead.status}（不是终态）`);
  }
  if (finalRead.version !== 3) defects.push(`最终版本=${finalRead.version}（起始 2，应只 +1 到 3）`);

  // 胜出方提交的结果必须就是最终可回读状态（否则它的提交被后者覆盖丢失）。
  if (winner) {
    const winOut = winner === 'confirm' ? confirmOut : cancelOut;
    const expectedStatus = winner === 'confirm' ? 'locked' : 'cancelled';
    if (finalRead.status !== expectedStatus) {
      defects.push(`先提交成功的是 ${winner}，但最终回读为 ${finalRead.status}（该结果被覆盖丢失）`);
    }
    void winOut;
  }

  // 丢失事件：某页面提交后自己回读到了终态事件，但最终重载的事件链里没有。
  const lostEvents = [];
  for (const [page, out] of [['confirm', confirmOut], ['cancel', cancelOut]]) {
    for (const type of out.eventTypes ?? []) {
      if (TERMINAL.includes(type) && !terminalTypes.includes(type)) {
        lostEvents.push(`${page} 页写入的 "${type}" 在最终事件链中丢失`);
      }
    }
  }

  return { ok: defects.length === 0, defects, winner, committed, lostEvents };
};

const printDiagnostics = (round, confirmOut, cancelOut, finalRead, verdict) => {
  console.log(`\n── 第 ${round} 轮检测到覆盖/撕裂 ${mode === 'baseline' ? '（基线：跨页锁关闭）' : ''} ──`);
  console.log('[confirm 页返回]', JSON.stringify(summarize(confirmOut), null, 2));
  console.log('[cancel  页返回]', JSON.stringify(summarize(cancelOut), null, 2));
  console.log('[最终重新加载可回读状态]', JSON.stringify(finalRead, null, 2));
  console.log('[收口成功页数]', verdict.committed, ' 胜出方:', verdict.winner);
  if (verdict.lostEvents.length) console.log('[丢失事件]\n - ' + verdict.lostEvents.join('\n - '));
  console.log('[问题]\n - ' + verdict.defects.join('\n - '));
};

const main = async () => {
  await buildWorker();

  console.log(
    mode === 'normal'
      ? `多标签页竞争测试：${rounds} 轮，跨页锁【开启】（navigator.locks 的文件锁等价物）`
      : mode === 'baseline'
        ? `多标签页竞争测试：${rounds} 轮，跨页锁【关闭】（基线，预期出现覆盖）`
        : `多标签页竞争测试：${rounds} 轮，互斥【不可用】（终态动作必须被明确阻止，恢复后单次生效）`,
  );

  let failedRounds = 0;
  let baselineOverwrites = 0;
  const winners = { confirm: 0, cancel: 0, none: 0 };

  // 单方终态提交（恢复场景，独立进程，栅栏 parties=1 立即放行）。
  const contendOne = (dir, role, { barrier, lockMode = 'file' }) =>
    runWorker(dir, `${role}-${barrier}`, {
      MODE: 'contend',
      ROLE: role,
      PARTY: `${role}-${barrier}`,
      LOCK_MODE: lockMode,
      BARRIER_PARTIES: '1',
      BARRIER_DIR: join(dir, barrier),
    });

  // 锁不可用的单轮校验：两个终态动作都必须被"锁错误"拦下，状态/版本/事件不变；
  // 恢复后同一动作只生效一次；再对已成终态的安排重复同一动作，只得到业务拒绝。
  const runLockUnavailableRound = async (round, dir) => {
    const defects = [];
    // 交替模拟两种故障：none=无跨页后端（navigator.locks 缺失），failing=后端建立锁失败。
    const downMode = round % 2 === 1 ? 'none' : 'failing';

    // —— 阶段 A：互斥不可用，两页近同时尝试 confirm 与 cancel ——
    const [confirmOut, cancelOut] = await Promise.all([
      runWorker(dir, 'confirm-block', {
        MODE: 'contend', ROLE: 'confirm', PARTY: 'confirm-block',
        LOCK_MODE: downMode, BARRIER_PARTIES: '2', BARRIER_DIR: join(dir, 'b-block'),
      }),
      runWorker(dir, 'cancel-block', {
        MODE: 'contend', ROLE: 'cancel', PARTY: 'cancel-block',
        LOCK_MODE: downMode, BARRIER_PARTIES: '2', BARRIER_DIR: join(dir, 'b-block'),
      }),
    ]);

    for (const [name, out] of [['confirm', confirmOut], ['cancel', cancelOut]]) {
      if (out.ok) defects.push(`${name} 在互斥不可用时竟然提交成功（发生降级）`);
      if (out.ok === false && out.errorKind !== 'lock') {
        defects.push(`${name} 失败但不是锁错误（errorKind=${out.errorKind}：${out.error}）`);
      }
      if (out.reread?.status !== 'selected' || out.reread?.version !== 2) {
        defects.push(`${name} 被阻止后状态发生变化：${out.reread?.status}@v${out.reread?.version}`);
      }
    }

    const afterBlock = await reread(dir);
    if (afterBlock.status !== 'selected' || afterBlock.version !== 2) {
      defects.push(`阻止阶段后最终状态=${afterBlock.status}@v${afterBlock.version}（应保持 selected@v2）`);
    }
    if (afterBlock.terminalEventTypes.length !== 0) {
      defects.push(`阻止阶段写入了终态事件：${JSON.stringify(afterBlock.terminalEventTypes)}`);
    }

    // —— 阶段 B：互斥恢复，全新单页重试"同一动作 confirm"，只能生效一次 ——
    const recover = await contendOne(dir, 'confirm', { barrier: 'b-recover', lockMode: 'file' });
    if (!recover.ok || recover.returned?.status !== 'locked' || recover.returned?.version !== 3) {
      defects.push(`恢复后重试 confirm 未单次生效：ok=${recover.ok} ${recover.error}`);
    }
    const afterRecover = await reread(dir);
    if (
      afterRecover.status !== 'locked' ||
      afterRecover.version !== 3 ||
      afterRecover.holdersCount !== 1 ||
      afterRecover.terminalEventTypes.length !== 1 ||
      afterRecover.terminalEventTypes[0] !== 'confirmed'
    ) {
      defects.push(`恢复后最终收口异常：${JSON.stringify(afterRecover)}`);
    }

    // —— 阶段 C：对已是 locked 的安排再次重复同一动作，只应得到业务拒绝且不追加事件 ——
    const duplicate = await contendOne(dir, 'confirm', { barrier: 'b-dup', lockMode: 'file' });
    if (duplicate.ok) defects.push('对已锁定安排重复 confirm 竟然再次成功');
    if (!duplicate.ok && duplicate.errorKind !== 'business') {
      defects.push(`重复 confirm 应是业务拒绝，实际 errorKind=${duplicate.errorKind}`);
    }
    const afterDup = await reread(dir);
    const confirmedEvents = afterDup.events.filter((e) => e.type === 'confirmed').length;
    if (afterDup.version !== 3 || confirmedEvents !== 1) {
      defects.push(`重复尝试后版本/事件数异常：v${afterDup.version}，confirmed 事件=${confirmedEvents}`);
    }

    if (defects.length) {
      failedRounds += 1;
      console.log(`\n── 第 ${round} 轮 锁不可用场景失败 ──`);
      console.log('[confirm 阻止时返回]', JSON.stringify(summarize(confirmOut), null, 2));
      console.log('[cancel  阻止时返回]', JSON.stringify(summarize(cancelOut), null, 2));
      console.log('[阻止后回读]', JSON.stringify(afterBlock, null, 2));
      console.log('[恢复重试返回]', JSON.stringify(summarize(recover), null, 2));
      console.log('[恢复后回读]', JSON.stringify(afterRecover, null, 2));
      console.log('[重复尝试返回]', JSON.stringify(summarize(duplicate), null, 2));
      console.log('[问题]\n - ' + defects.join('\n - '));
    } else {
      process.stdout.write(`  轮 ${round}: 阻止阶段 0 提交；恢复后单次 locked@v3；重复仅业务拒绝、事件仍 1 条\n`);
    }
  };

  for (let round = 1; round <= rounds; round += 1) {
    const dir = mkdtempSync(join(tmpdir(), `reswap-crosstab-${round}-`));
    mkdirSync(join(dir, 'locks'), { recursive: true });
    try {
      const seeded = await seed(dir);
      if (!seeded.ok) throw new Error('seed 失败: ' + JSON.stringify(seeded));

      if (mode === 'lock-unavailable') {
        await runLockUnavailableRound(round, dir);
        continue;
      }

      const lockMode = mode === 'baseline' ? 'none' : 'file';
      const [confirmOut, cancelOut] = await contendBoth(dir, {
        confirmMode: lockMode,
        cancelMode: lockMode,
      });
      const finalRead = await reread(dir);
      const verdict = evaluate(confirmOut, cancelOut, finalRead);

      winners[verdict.winner ?? 'none'] += 1;
      if (mode === 'baseline') {
        if (!verdict.ok) {
          baselineOverwrites += 1;
          printDiagnostics(round, confirmOut, cancelOut, finalRead, verdict);
        }
      } else if (!verdict.ok) {
        failedRounds += 1;
        printDiagnostics(round, confirmOut, cancelOut, finalRead, verdict);
      } else {
        process.stdout.write(`  轮 ${round}: 单次收口 -> ${verdict.winner}，最终 ${finalRead.status}@v${finalRead.version}，占用 ${finalRead.holdersCount}\n`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (mode === 'lock-unavailable') {
    if (failedRounds > 0) {
      console.error(`\n失败 ${failedRounds}/${rounds} 轮：互斥不可用时仍发生提交，或恢复后未单次生效。`);
      process.exit(1);
    }
    console.log(`\n通过：${rounds}/${rounds} 轮——互斥不可用/建立失败时确认与取消都被明确阻止且不留变化，恢复后同一动作只生效一次，重复仅得业务拒绝。`);
    return;
  }

  console.log(`\n胜出分布：confirm=${winners.confirm} cancel=${winners.cancel} 无收口=${winners.none}`);
  if (mode === 'baseline') {
    console.log(`基线完成：${baselineOverwrites}/${rounds} 轮观察到跨页覆盖/事件丢失（证明使用的是真实跨页存储）。`);
    console.log('去掉 --baseline 后，跨页锁应使所有轮次单次收口。');
    process.exit(0);
  }

  if (failedRounds > 0) {
    console.error(`\n失败 ${failedRounds}/${rounds} 轮：版本/占用/事件链未做到只收口一次。`);
    process.exit(1);
  }
  console.log(`\n通过：${rounds}/${rounds} 轮均为单次收口，版本只 +1，占用与事件链一致，无丢失/重复终态事件。`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
