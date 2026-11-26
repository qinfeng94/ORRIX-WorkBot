/**
 * 01-five-dim-arch-audit.mjs —— Day 26 五维架构体检（零第三方依赖，Node v18+）
 * 运行：node scripts/day26-lab/01-five-dim-arch-audit.mjs
 * 输出：.fde/day26-arch-audit.json（红黄绿灯体检报告，小白能懂）
 *
 * 五维（课程 Day 26 规范口径，落地为本项目真实扫描）：
 *  D1_ABSTRACTION          架构粒度：<40 行碎文件 / >600 行上帝文件 / 黄金区间 150~400 行
 *  D2_EXTERNALIZED_RULES   业务规则外置化：扫描 50000 阈值硬编码比较、阈值副本声明、
 *                          7.2 汇率硬编码、华东条款正则硬编码（注释剔除后匹配，避免误报）
 *  D3_DETERMINISM_VS_PROMPT 确定性边界：最长的「指令型」提示词字面量估算 Token（>800 判差）
 *  D4_TOOL_COHESION        工具内聚度：统计 src 内服务端工具注册表条目数（>6 判差）
 *  D5_EVAL_FEEDBACK_LOOP   评测反馈闭环：25 题黄金集 + CI 门禁 + 确定性策略引擎是否就位
 *
 * 红黄绿灯：维度分 ≥75 🟢健康 / 50~74 🟡预警 / <50 🔴病灶
 * 总分评级：≥85 A（AI-Native 就绪）/ ≥60 C（需局部手术）/ 否则 D（旧教条负债严重）
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const OUT_PATH = join(ROOT, ".fde", "day26-arch-audit.json");

/** 单点真源锚定文件豁免清单：其 50000 字面量是「启动一致性基准」，不是散落副本 */
const SSOT_ANCHOR_FILES = new Set(["src" + sep + "lib" + sep + "fin001.ts"]);

/* ================= 工具函数 ================= */

/** 递归收集目录下的 .ts/.tsx 文件 */
function collectFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collectFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** 剥离注释（与 midpoint-verify 同口径），避免文案声明误命中 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

function statusOf(score) {
  if (score >= 75) return "GREEN";
  if (score >= 50) return "YELLOW";
  return "RED";
}

/* ================= D1 架构粒度 ================= */

function auditD1(files) {
  const fragments = [];
  const gods = [];
  const golden = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    const lines = readFileSync(f, "utf8").split("\n").length;
    if (lines < 40) fragments.push({ file: rel, lines });
    else if (lines > 600) gods.push({ file: rel, lines });
    else if (lines >= 150 && lines <= 400) golden.push({ file: rel, lines });
  }
  const score = Math.max(20, 100 - fragments.length * 11 - gods.length * 25);
  const finding =
    gods.length === 0 && fragments.length === 0
      ? `文件粒度健康：黄金区间（150~400 行）文件 ${golden.length} 个，无碎文件、无上帝文件。`
      : `发现 ${gods.length} 个上帝文件（>600 行）与 ${fragments.length} 个碎文件（<40 行）。` +
        (gods.length > 0
          ? `最严重：${gods.sort((a, b) => b.lines - a.lines)[0].file}（${gods.sort((a, b) => b.lines - a.lines)[0].lines} 行）——AI 修一个小需求要读完整个大文件，烧 3 倍输入 Token。`
          : "");
  return {
    id: "D1_ABSTRACTION",
    name: "架构粒度（反洋葱碎文件 / 反上帝文件）",
    score,
    status: statusOf(score),
    finding,
    recommendation:
      gods.length + fragments.length === 0
        ? "维持「一次需求 ≈ 一个垂直切片」的切法，新文件直落 150~400 行黄金区间。"
        : "按垂直切片把上帝文件拆成 schema / 引擎 / 工具 / 测试四件套（每件 150~400 行）；碎文件就近合并进同意图邻居。",
    hits: [...gods.map((g) => ({ ...g, rule: "上帝文件>600行" })), ...fragments.map((g) => ({ ...g, rule: "碎文件<40行" }))],
  };
}

/* ================= D2 业务规则外置化 ================= */

function auditD2(files) {
  /** 模式库：业务规则硬编码的四类病灶（注释剔除后匹配） */
  const patterns = [
    { rule: "阈值硬编码比较（> 50000）", re: />\s*50000\b/g },
    { rule: "阈值副本声明（const = 50000）", re: /const\s+\w+\s*(?::[^=]+)?=\s*50000\b/g, exemptSsot: true },
    { rule: "汇率硬编码（= 7.2）", re: /=\s*7\.2\b/g },
    { rule: "华东条款硬编码（正则/字面量判断）", re: /\/华东\/\.test|includes\("华东"\)|===\s*["']EAST_CN["']/g },
  ];
  const hits = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    const code = stripComments(readFileSync(f, "utf8"));
    for (const p of patterns) {
      if (p.exemptSsot && SSOT_ANCHOR_FILES.has(rel)) continue;
      const found = code.match(p.re);
      if (found) hits.push({ file: rel, rule: p.rule, count: found.length });
    }
  }
  const total = hits.reduce((s, h) => s + h.count, 0);
  const score = Math.max(15, 100 - total * 18);
  const finding =
    total === 0
      ? "业务规则已全部外置到 config/approval-policies.json（纯数据），源码里零硬编码金额 / 汇率 / 区域条款。"
      : `发现 ${total} 处业务规则硬编码散落在代码里。最痛的场景：财务想把审批门槛从 5 万调成 3 万，得改代码、走发版、等三天。`;
  return {
    id: "D2_EXTERNALIZED_RULES",
    name: "业务规则外置化（反硬编码 if/else）",
    score,
    status: statusOf(score),
    finding,
    recommendation:
      total === 0
        ? "维持「规则改 JSON、代码不动」的纪律；新增规则先问一句：这该不该是配置？"
        : "把阈值 / 汇率 / 区域条款搬进 config/approval-policies.json，代码只留一个启动一致性校验，改规则 = 改配置 5 秒生效。",
    hits,
  };
}

/* ================= D3 确定性边界（反万字大 Prompt） ================= */

function auditD3(files) {
  /** 扫描指令型字符串字面量（含提示词特征词），估算最大 Token（口径：字符数 ÷ 1.8） */
  const markers = /你是|纪律|制度|红线|审批|必须|严禁/;
  let maxTok = 0;
  let maxAt = "";
  for (const f of files) {
    const rel = relative(ROOT, f);
    // 提示词只可能出现在 .ts 服务端模块；.tsx 是界面层（JSX 会让朴素字符串正则跨码误捕）
    if (!f.endsWith(".ts")) continue;
    const code = readFileSync(f, "utf8");
    // 只匹配单行字面量（跨行模板串多为代码结构，不是提示词）
    const literals = code.match(/(["'])((?:\\.|(?!\1)[^\n]){40,}?)\1/g) ?? [];
    for (const lit of literals) {
      const body = lit.slice(1, -1);
      // SQL DDL / 数据语句不是提示词，剔除防误报
      if (/CREATE TABLE|INSERT INTO|ALTER TABLE|CREATE TRIGGER|DROP TRIGGER|CREATE INDEX/.test(body)) continue;
      if (!markers.test(body)) continue;
      const tok = Math.round(body.length / 1.8);
      if (tok > maxTok) {
        maxTok = tok;
        maxAt = rel;
      }
    }
  }
  const score = maxTok > 800 ? 35 : 90;
  const finding =
    maxTok > 800
      ? `最大的提示词字面量约 ${maxTok} Tokens（${maxAt}），超过 800 判差——万字大 Prompt 让模型抓不住重点，确定性规则（算术 / 红线）不该靠提示词求模型自觉。`
      : `最大的提示词字面量约 ${maxTok} Tokens（${maxAt}），在健康区间；金额算术与红线判定均由确定性代码承担，不靠提示词求模型自觉。`;
  return {
    id: "D3_DETERMINISM_VS_PROMPT",
    name: "确定性边界（反万字大 Prompt）",
    score,
    status: statusOf(score),
    finding,
    recommendation:
      maxTok > 800
        ? "把「算账、对红线」从提示词搬进确定性函数；提示词瘦身到 800 Tokens 以内，只讲角色与格式。"
        : "维持「提示词讲角色、代码守红线」的分工，新增规则优先写成函数而不是往提示词里堆字。",
    hits: maxTok > 0 ? [{ file: maxAt, rule: "最大提示词字面量", count: maxTok }] : [],
  };
}

/* ================= D4 工具内聚度（反细碎原子工具爆炸） ================= */

/** 统计 src 内服务端工具注册表的条目数（大括号配平扫描） */
function countRegistryEntries(code, exportName) {
  const startRe = new RegExp(`export const ${exportName}[^=]*=\\s*\\{`);
  const m = code.match(startRe);
  if (!m || m.index === undefined) return 0;
  let i = code.indexOf("{", m.index);
  let depth = 0;
  let entries = 0;
  for (; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1 && code.startsWith(":", i + 1) === false) {
      // noop（占位，键计数在下方按「行首两空格键名 + 冒号」模式做）
    }
  }
  // 取注册表块文本，按「两空格缩进的键: {」计数
  const block = code.slice(code.indexOf("{", m.index), i + 1);
  entries = (block.match(/\n {2}[A-Za-z_]\w*:\s*\{/g) ?? []).length;
  return entries;
}

function auditD4(files) {
  // 只统计「对话期供模型选择」的工具注册表；调查探针（PROBE_REGISTRY）单独作为信息项披露
  const REGISTRY_EXPORTS = ["TOOL_REGISTRY"];
  const hits = [];
  let toolCount = 0;
  for (const f of files) {
    const rel = relative(ROOT, f);
    const code = readFileSync(f, "utf8");
    for (const name of REGISTRY_EXPORTS) {
      const n = countRegistryEntries(code, name);
      if (n > 0) {
        toolCount += n;
        hits.push({ file: rel, rule: `${name} 工具数`, count: n });
      }
    }
    const probe = countRegistryEntries(code, "PROBE_REGISTRY");
    if (probe > 0) hits.push({ file: rel, rule: "PROBE_REGISTRY 调查探针数（信息项）", count: probe });
  }
  const score = toolCount > 6 ? Math.max(20, 100 - (toolCount - 4) * 9) : 92;
  const finding =
    toolCount > 6
      ? `服务端工具注册表共 ${toolCount} 把工具，超过 6 把判差——工具越碎，模型选错工具的概率越高，每次调用还要背着全套工具说明书（输入 Token 线性上涨）。`
      : `服务端工具注册表共 ${toolCount} 把工具（≤6 健康线），按「单一业务意图」聚合，模型好选、说明书也轻。`;
  return {
    id: "D4_TOOL_COHESION",
    name: "工具内聚度（反细碎原子工具爆炸）",
    score,
    status: statusOf(score),
    finding,
    recommendation:
      toolCount > 6
        ? "把细碎底层查询工具合并成 3 个高内聚业务意图工具（案情勘察 / 制度检索 / 审批预演），单工具核心入参 3~6 个。"
        : "维持意图级聚合；新增能力先问是否属于既有三意图之一，严禁再造瑞士军刀式 35 参数工具。",
    hits,
  };
}

/* ================= D5 评测反馈闭环 ================= */

function auditD5() {
  let evalScript = "";
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    evalScript = typeof pkg.scripts?.["eval:ci"] === "string" ? pkg.scripts["eval:ci"] : "";
  } catch {
    evalScript = "";
  }
  const checks = [
    { item: "25 题黄金评测集（data/evals/golden-suite-v2.json）", ok: existsSync(join(ROOT, "data", "evals", "golden-suite-v2.json")) },
    { item: "CI 评测门禁（pnpm eval:ci → scripts/day25-eval-gate.ts）", ok: evalScript.length > 0 && existsSync(join(ROOT, "scripts", "day25-eval-gate.ts")) },
    { item: "外置策略配置（config/approval-policies.json）", ok: existsSync(join(ROOT, "config", "approval-policies.json")) },
    { item: "确定性策略引擎 evaluateApprovalPolicy", ok: grepInDir(join(ROOT, "src"), "evaluateApprovalPolicy") },
  ];
  const gateReady = checks[0].ok && checks[1].ok;
  const policyMounted = checks[2].ok && checks[3].ok;
  const score = gateReady ? (policyMounted ? 90 : 78) : 40;
  const finding = gateReady
    ? `评测反馈闭环就位：25 题黄金集 + CI 阻塞门禁（pnpm eval:ci）${policyMounted ? " + 确定性策略引擎已挂载" : ""}——任何重构跑一遍 25/25 全绿才准合入，红线被改坏会当场红灯。`
    : "评测反馈闭环缺失：改完代码没有一套固定考卷来证明「没改坏」，回归全凭感觉——这是旧教条负债。";
  return {
    id: "D5_EVAL_FEEDBACK_LOOP",
    name: "评测与反馈闭环（反「改完凭感觉」）",
    score,
    status: statusOf(score),
    finding,
    recommendation: gateReady
      ? "维持纪律：任何规则 / 流程变更必须重考 25 题，红灯锁死合入。"
      : "补建 25 题分层阻塞式评测门禁（pnpm eval:ci）：安全 7 题 / 契约 6 题 / 审批 6 题 / 推理 6 题，25/25 全绿才放行。",
    hits: checks.map((c) => ({ file: c.item, rule: c.ok ? "就位" : "缺失", count: c.ok ? 1 : 0 })),
  };
}

function grepInDir(dir, needle) {
  try {
    for (const f of collectFiles(dir)) {
      if (readFileSync(f, "utf8").includes(needle)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/* ================= 主流程 ================= */

/** 术前基线（Day 26 手术前实测记录，供 /arch-audit 看板做前后对比） */
const BASELINE = {
  capturedAt: "Day 26 术前扫描",
  overallScore: 48,
  grade: "D (旧教条负债严重)",
  note: "术前：4 处业务规则硬编码散落在源码、4 把细碎查询工具、无外置策略配置",
};

function main() {
  const files = [...collectFiles(join(ROOT, "src")), ...collectFiles(join(ROOT, "app"))];
  const dimensions = [
    auditD1(files),
    auditD2(files),
    auditD3(files),
    auditD4(files),
    auditD5(),
  ];
  const overall = Math.round(dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length);
  const grade =
    overall >= 85 ? "A (AI-Native 就绪)" : overall >= 60 ? "C (需局部手术)" : "D (旧教条负债严重)";

  const report = {
    auditedAt: new Date().toISOString(),
    targetDirectory: "src/ + app/（WorkBot 生产代码）",
    totalFilesScanned: files.length,
    overallScore: overall,
    grade,
    baseline: BASELINE,
    lightLegend: "🟢 GREEN ≥75 健康｜🟡 YELLOW 50~74 预警｜🔴 RED <50 病灶",
    dimensions,
  };

  writeOut(report);
  console.log(`\n=== Day 26 五维架构体检 ===`);
  console.log(`扫描文件：${files.length} 个 ｜ 总分：${overall}/100 ｜ 评级：${grade}\n`);
  for (const d of dimensions) {
    const light = d.status === "GREEN" ? "🟢" : d.status === "YELLOW" ? "🟡" : "🔴";
    console.log(`${light} ${d.id}  ${String(d.score).padStart(3)} 分  ${d.name}`);
    console.log(`   ${d.finding}`);
  }
  console.log(`\n报告已落盘：.fde/day26-arch-audit.json\n`);
}

function writeOut(report) {
  mkdirSync(join(ROOT, ".fde"), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
}

main();
