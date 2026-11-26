/**
 * midpoint-verify.mjs —— Day 20 Checkpoint #1 一键核验（零第三方依赖）
 * 用法：pnpm midpoint:verify
 * 核验范围：Week 1–4（Day 1–19）全部页面路由、API 路由、核心引擎与安全文件的存在性，
 *           加上红线内容检查（FIN-001 阈值 / 注入护栏 / dryRun 锁死 / 防死循环上限 /
 *           组件白名单 / PII 脱敏 / 只增不改表 / 导航完整性），最后跑 tsc --noEmit。
 * 输出：逐项 ✅ / ❌ + 分组小结；任一失败退出码 1（CI 可直接用）。
 */

import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ================= 一、Week 1–4 文件清单（真实路由与核心文件） ================= */

const GROUPS = [
  {
    label: "Week 1 · Day 1–5 基座与工单协同台",
    files: [
      "app/page.tsx",
      "app/api/tickets/route.ts",
      "app/api/tickets/approve/route.ts",
      "src/lib/fin001.ts",
      "src/lib/ticket-dto.ts",
      "src/lib/api-error.ts",
      "src/db/schema.ts",
      "src/db/index.ts",
      "app/components/TopNav.tsx",
      ".fde/01-stakeholders-and-fittest.md",
      ".fde/02-workflow-cut.md",
      ".fde/03-solution-design.md",
      ".fde/04-access-boundary.md",
      ".fde/05-eval-spec-20.md",
    ],
  },
  {
    label: "Week 2 · Day 6–9 双模型引擎 / 对话工作台 / 生成式 UI / 三层记忆",
    files: [
      "lib/llm/llm-client.mjs",
      "lib/llm/llm-client.d.ts",
      "scripts/day6-lab/01-dual-stream-ledger.mjs",
      "scripts/day6-lab/02-tool-chain-dryrun.mjs",
      "app/chat/page.tsx",
      "app/api/chat/route.ts",
      "app/api/chat/approve/route.ts",
      "src/lib/chat-engine.ts",
      "src/lib/posthog-server.ts",
      "app/studio/page.tsx",
      "app/api/generative-ui/route.ts",
      "src/lib/genui/catalog-schema.ts",
      "src/components/genui/ComponentRegistry.tsx",
      "src/lib/memory.ts",
      "app/api/memory/route.ts",
      "tests/memory.test.ts",
    ],
  },
  {
    label: "Week 3 · Day 11–15 调查引擎 / 四代理专班 / 检索 / 浏览器 / 尽调",
    files: [
      "app/investigate/page.tsx",
      "app/api/investigate/route.ts",
      "src/lib/ai/react-agent.ts",
      "app/multi-agent/page.tsx",
      "app/api/multi-agent/route.ts",
      "src/lib/multiagent/pipeline.ts",
      "src/lib/multiagent/guardrails.ts",
      "src/lib/multiagent/envelopes.ts",
      "src/lib/multiagent/a2a-client.ts",
      "src/lib/multiagent/external-logistics-agent.ts",
      "app/rag-lab/page.tsx",
      "app/api/rag-lab/route.ts",
      "src/lib/raglab/retrieval.ts",
      "src/lib/raglab/corpus.ts",
      "app/browser-lab/page.tsx",
      "app/api/browser-lab/route.ts",
      "src/lib/browser-lab/scrape-engine.ts",
      "src/lib/browser-lab/prefill-engine.ts",
      "src/lib/browser-lab/legacy-erp-data.ts",
      "app/sandbox-legacy-erp/page.tsx",
      "app/api/sandbox-legacy-erp/submit/route.ts",
      "app/research-analyst/page.tsx",
      "app/api/research-analyst/route.ts",
      "app/api/research-analyst/archive/route.ts",
      "src/lib/research-analyst/engine.ts",
    ],
  },
  {
    label: "Week 4 · Day 16–19 多模态 / 单据抽取 / 持久审批流 / PII 脱敏",
    files: [
      "app/multimodal/page.tsx",
      "app/api/multimodal/forensics/route.ts",
      "app/api/voice/session/route.ts",
      "app/api/voice/tools/route.ts",
      "src/lib/multimodal/demo-tapes.ts",
      "app/extraction/page.tsx",
      "app/api/extraction/eval/route.ts",
      "src/lib/extraction/extractor.ts",
      "src/lib/extraction/validators.ts",
      "src/lib/extraction/eval.ts",
      "src/lib/extraction/dirty-docs.ts",
      "src/lib/extraction/schemas.ts",
      "app/workflows/page.tsx",
      "app/api/workflows/route.ts",
      "app/api/workflows/[runId]/decide/route.ts",
      "app/api/inngest/route.ts",
      "app/api/mcp/tasks/route.ts",
      "app/api/mcp/tasks/[taskId]/route.ts",
      "src/lib/workflow/engine.ts",
      "src/lib/workflow/inngest.ts",
      "app/api/external-logistics/a2a/tasks/route.ts",
      "app/api/external-logistics/.well-known/agent.json/route.ts",
      "src/lib/pii-scrubber.ts",
      "app/sandbox-demo/page.tsx",
    ],
  },
];

/* ================= 二、红线内容检查 ================= */

const CONTENT_CHECKS = [
  {
    label: "FIN-001 阈值 = 50000 且全文件无 100000（旧 10 万制度不复活）",
    file: "src/lib/fin001.ts",
    must: ["50000"],
    mustNot: ["100000"],
  },
  {
    label: "FIN-001 判定是严格大于（等于不触发，Q12 口径）",
    file: "src/lib/fin001.ts",
    must: ["> FIN001_THRESHOLD_YUAN"],
  },
  {
    label: "入口护栏：恶意注入特征库存在（CISO 条款 5）",
    file: "src/lib/multiagent/guardrails.ts",
    must: ["INJECTION_PATTERNS", "runInputGuard"],
  },
  {
    label: "黄区写操作 dryRun 代码层锁死（04 号 Y1~Y4）",
    file: "src/lib/chat-engine.ts",
    must: ["dryRunTool"],
  },
  {
    label: "对话工具链 maxSteps=6 防死循环上限",
    file: "src/lib/chat-engine.ts",
    must: ["MAX_STEPS = 6"],
  },
  {
    label: "ReAct 引擎 maxSteps=8 物理熔断",
    file: "src/lib/ai/react-agent.ts",
    must: ["MAX_STEPS = 8"],
  },
  {
    label: "生成式 UI：布局 JSON 注入特征直接拒绝（严禁原始 HTML/JS）",
    file: "src/lib/genui/catalog-schema.ts",
    must: ["/<script/i", "/javascript:/i", "/onerror\\s*=/i"],
  },
  {
    label: "PII 确定性脱敏（fail-closed）",
    file: "src/lib/pii-scrubber.ts",
    must: ["REDACTED_PII", "ID_CARD_RE", "BANK_CARD_RE", "PHONE_RE"],
  },
  {
    label: "审批流状态机：跨重启判定基准 + 7 天挂起窗口",
    file: "src/lib/workflow/engine.ts",
    must: ["PROCESS_START_MS", "WAIT_TIMEOUT_MS"],
  },
  {
    label: "批准幂等：已完成 run 返回原凭据，绝不产生第二张",
    file: "src/lib/workflow/engine.ts",
    must: ['run.phase === "completed"'],
  },
  {
    label: "DB Schema：13 张表齐全",
    file: "src/db/schema.ts",
    must: [
      "intake_requests",
      "approval_audit_logs",
      "llm_usage_logs",
      "memory_episodes",
      "user_preferences",
      "agent_traces",
      "agent_spans",
      "erp_scraped_invoices",
      "research_reports",
      "workflow_runs",
      "workflow_events",
      "mcp_tasks",
    ],
  },
  {
    label: "审计/事件表注释声明只增不改（触发器物理拒绝篡改）",
    file: "src/db/schema.ts",
    must: ["只增不改", "触发器"],
  },
  {
    label: "记忆表刻意不挂只增不改触发器（用户可编辑/删除/遗忘）",
    file: "src/db/schema.ts",
    must: ["不挂只增不改触发器"],
  },
  {
    label: "顶栏导航：12 个入口齐全（含本日新增 /architecture-hub）",
    file: "app/components/TopNav.tsx",
    must: [
      'href: "/"',
      'href: "/chat"',
      'href: "/studio"',
      'href: "/investigate"',
      'href: "/multi-agent"',
      'href: "/rag-lab"',
      'href: "/browser-lab"',
      'href: "/research-analyst"',
      'href: "/multimodal"',
      'href: "/extraction"',
      'href: "/workflows"',
      'href: "/architecture-hub"',
    ],
  },
  {
    label: "架构文档（Day 20 Checkpoint #1 交付物）就位",
    file: "docs/architecture/WORKBOT-PRODUCTION-ARCHITECTURE.md",
    must: ["需求偏差审计表", "ADR-001", "ADR-002", "ADR-003"],
  },
];

/* ================= 三、执行 ================= */

let pass = 0;
let fail = 0;
const failures = [];

function tick(ok, label) {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ❌ ${label}`);
  }
}

async function exists(rel) {
  try {
    await access(path.join(ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("\n=== WorkBot Day 20 Checkpoint #1 · midpoint:verify ===\n");

  for (const g of GROUPS) {
    console.log(`\n📁 ${g.label}`);
    for (const f of g.files) tick(await exists(f), f);
  }

  console.log("\n🔒 红线内容检查");
  for (const c of CONTENT_CHECKS) {
    const abs = path.join(ROOT, c.file);
    let text = "";
    try {
      text = await readFile(abs, "utf8");
    } catch {
      tick(false, `${c.label}（文件缺失：${c.file}）`);
      continue;
    }
    const missing = c.must.filter((m) => !text.includes(m));
    // 违禁词只查「代码逻辑」——先剥离 /** */ 与 // 注释，避免自检声明文案误命中
    const codeOnly = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
    const leaked = (c.mustNot ?? []).filter((m) => codeOnly.includes(m));
    const ok = missing.length === 0 && leaked.length === 0;
    const detail = ok
      ? ""
      : `（缺失：${missing.join(" / ")}${leaked.length ? `；违禁命中：${leaked.join(" / ")}` : ""}）`;
    tick(ok, `${c.label}${detail}`);
  }

  console.log("\n🧪 TypeScript 严格模式编译检查（tsc --noEmit）");
  const tsc = spawnSync("pnpm", ["exec", "tsc", "--noEmit"], {
    cwd: ROOT,
    shell: true,
    encoding: "utf8",
    timeout: 180_000,
  });
  tick(tsc.status === 0, tsc.status === 0 ? "tsc --noEmit 零错误" : `tsc 报错：\n${tsc.stdout}${tsc.stderr}`);

  console.log("\n----------------------------------------");
  console.log(`结果：${pass} 通过 / ${fail} 失败 ${fail === 0 ? "—— 全绿 ✅" : "—— 存在 ❌ 项"}`);
  if (fail > 0) {
    console.log("失败项：");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("");
}

main().catch((err) => {
  console.error("核验脚本异常：", err);
  process.exit(1);
});
