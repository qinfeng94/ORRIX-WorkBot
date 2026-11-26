/**
 * /arch-audit —— Day 26 架构大体检可视化看板
 * 数据源（构建产物即真源，不手工抄数字）：
 *  - .fde/day26-arch-audit.json（五维红黄绿灯体检报告）
 *  - .fde/day26-migration-metrics.json（两处手术前后量化 + 25 题 CI 结果）
 * 缺失时给出重跑命令，页面不崩、不编造数据。
 * 红线：本页只读展示与内存沙盒，无打款按钮、不写业务系统正式数据。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import AuditExperience, { type AuditReport, type MigrationMetrics } from "./AuditExperience";

// cacheComponents 下本页渲染期直接读取脚本生成的体检产物（随跑随新，页头也依赖数据），
// 显式声明为阻塞路由：整页等数据就绪后一次渲染，避免 Suspense 兜底闪烁。
export const instant = false;

async function readJson<T>(relPath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(process.cwd(), relPath), "utf8")) as T;
  } catch {
    return null;
  }
}

export default async function ArchAuditPage() {
  const audit = await readJson<AuditReport>(".fde/day26-arch-audit.json");
  const metrics = await readJson<MigrationMetrics>(".fde/day26-migration-metrics.json");

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Day 26 · Harness Engineering
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">架构大体检</h1>
        <p className="mt-2 max-w-3xl text-sm text-zinc-600">
          按「洋葱过度抽象 / 硬编码业务规则 / 万字大 Prompt / 细碎原子工具爆炸 / 评测反馈闭环」
          五个维度给项目放灯，并展示两处真实手术的前后对比。全程只读，不放款、不改正式数据。
        </p>
        {audit !== null && (
          <p className="mt-2 text-xs text-zinc-500">
            扫描范围：{audit.targetDirectory}（{audit.totalFilesScanned} 个文件）· 体检时间：
            {new Date(audit.auditedAt).toLocaleString("zh-CN")}
          </p>
        )}
      </header>

      {audit === null || metrics === null ? (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-800">
          <p className="font-bold">体检产物尚未生成</p>
          <p className="mt-1">请在项目根目录依次执行：</p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-white p-3 font-mono text-xs text-zinc-700">
{`node scripts/day26-lab/01-five-dim-arch-audit.mjs
node --experimental-strip-types --import ./tests/register-hooks.mjs scripts/day26-lab/02-migration-benchmark.mjs
pnpm eval:ci`}
          </pre>
          <p className="mt-2">生成后刷新本页即可看到五维体检卡与前后对比。</p>
        </section>
      ) : (
        <AuditExperience audit={audit} metrics={metrics} />
      )}
    </main>
  );
}
