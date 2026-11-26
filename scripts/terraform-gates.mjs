#!/usr/bin/env node
/**
 * Day 35 · Terraform 安全门禁零依赖自检（pnpm day35:gates）
 * 溯源：AGENTS.md 红区（严禁公网裸露 / 日志加密）+ 04 号文档权限边界。
 *
 * 两种身份，一个脚本：
 *   1) 演习版门禁：本机没装 Terraform 也能验证三道闸规则——直接解析三套环境的
 *      terraform.tfvars.example，逐套过闸；
 *   2) 反例考卷：内置 6 个「坏配置」自测（公网网段 / 单子网 / 非法 CIDR /
 *      数据库公网开关 / 假密钥 / 合法对照组），坏配置必须被拦、对照组必须放行。
 *
 * 单一真源：真正的硬门禁在 infra/terraform/modules/security-gates/main.tf 的
 * variable validation（terraform plan 阶段物理拦截）。本脚本的规则与它逐字同源，
 * 仅作为零依赖演习通道；两处规则若不一致，以 security-gates/main.tf 为准并回写本脚本。
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TERRAFORM_DIR = path.join(ROOT, "infra", "terraform");

// ---------------------------------------------------------------------------
// 门禁规则（与 modules/security-gates/main.tf 逐字同源）
// ---------------------------------------------------------------------------

/** RFC1918 私有网段前缀：10.x / 172.16-31.x / 192.168.x */
const PRIVATE_CIDR_RE = /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/;

/** 日志加密密钥引用：AWS KMS ARN / GCP CMEK 路径 / local:// 演习密钥，三选一 */
const LOG_KEY_RE =
  /^(arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/.+|projects\/[a-z][a-z0-9-]*\/locations\/[a-z]+\/keyRings\/[a-z][a-z0-9-]*\/cryptoKeys\/[a-z][a-z0-9-]*|local:\/\/[a-z0-9][a-z0-9-/]*)$/;

/** 等价 terraform can(cidrhost(cidr, 0))：IPv4 点分四段 + 合法前缀长度 */
function isValidCidr(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  const prefix = Number(m[5]);
  return (
    octets.every((o) => o >= 0 && o <= 255) && prefix >= 0 && prefix <= 32
  );
}

/** GATE-1 · 强制私有子网：全部合法 + 全部 RFC1918 + 至少 2 个（跨可用区） */
function checkGate1(subnetCidrs) {
  const reasons = [];
  if (!Array.isArray(subnetCidrs) || subnetCidrs.length < 2) {
    reasons.push(`私有子网需 ≥2 个（跨可用区），实际 ${subnetCidrs?.length ?? 0} 个`);
  }
  for (const cidr of subnetCidrs ?? []) {
    if (!isValidCidr(cidr)) reasons.push(`网段格式非法：${cidr}`);
    else if (!PRIVATE_CIDR_RE.test(cidr)) reasons.push(`非 RFC1918 私有网段：${cidr}`);
  }
  return reasons;
}

/** GATE-2 · 禁止公网裸库：只接受 false */
function checkGate2(publiclyAccessible) {
  return publiclyAccessible === false ? [] : ["数据库公网开关必须为 false（GATE-2 红线）"];
}

/** GATE-3 · 强制日志加密：密钥引用必须匹配三选一格式 */
function checkGate3(keyRef) {
  if (typeof keyRef !== "string" || keyRef.length === 0) {
    return ["日志加密密钥引用为空"];
  }
  return LOG_KEY_RE.test(keyRef) ? [] : [`密钥引用不合法（需 AWS KMS ARN / GCP CMEK 路径 / local:// 三选一）：${keyRef}`];
}

// ---------------------------------------------------------------------------
// tfvars 解析（行级正则，只认三个统一变量；解析不到视为缺失并判 FAIL）
// ---------------------------------------------------------------------------
function parseTfvars(text) {
  const cidrBlock = /\bprivate_subnet_cidrs\s*=\s*\[([^\]]*)\]/.exec(text);
  const subnets = cidrBlock
    ? [...cidrBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : null;
  const dbPublic = /\bdatabase_publicly_accessible\s*=\s*(true|false)\b/.exec(text);
  const logKey = /\blog_encryption_kms_key_ref\s*=\s*"([^"]*)"/.exec(text);
  return {
    subnets,
    dbPublic: dbPublic ? dbPublic[1] === "true" : null,
    logKey: logKey ? logKey[1] : null,
  };
}

// ---------------------------------------------------------------------------
// 输出工具
// ---------------------------------------------------------------------------
const results = [];
function record(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` —— ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// 第 0 步：真门禁存在性检查（security-gates/main.tf 里三道闸的 validation 必须在）
// ---------------------------------------------------------------------------
console.log("\n== 第 0 步：真门禁（Terraform validation）存在性检查 ==");
const gatesMain = readFileSync(
  path.join(TERRAFORM_DIR, "modules", "security-gates", "main.tf"),
  "utf8",
);
for (const gate of ["GATE-1", "GATE-2", "GATE-3"]) {
  record(`security-gates/main.tf 含 ${gate} 硬校验`, gatesMain.includes(gate));
}

// ---------------------------------------------------------------------------
// 第 1 步：反例考卷（坏配置必须被拦，对照必须放行）
// ---------------------------------------------------------------------------
console.log("\n== 第 1 步：反例考卷（6 例）==");

record("反例1 公网网段子网被拦", checkGate1(["203.0.113.0/24", "10.0.1.0/24"]).length > 0);
record("反例2 单子网被拦", checkGate1(["10.0.1.0/24"]).length > 0);
record("反例3 非法 CIDR 被拦", checkGate1(["10.0.1.0/999", "10.0.2.0/24"]).length > 0);
record("反例4 数据库公网开关 true 被拦", checkGate2(true).length > 0);
record("反例5 假密钥引用被拦", checkGate3("not-a-kms-ref").length > 0);
record("反例6 合法对照组放行",
  checkGate1(["10.40.1.0/24", "10.40.2.0/24"]).length === 0 &&
  checkGate2(false).length === 0 &&
  checkGate3("arn:aws:kms:us-east-1:123456789012:key/00000000-1111-2222-3333-444444444444").length === 0,
);

// ---------------------------------------------------------------------------
// 第 2 步：三套环境真实 tfvars.example 逐套过闸
// ---------------------------------------------------------------------------
console.log("\n== 第 2 步：三套环境过闸 ==");
const environments = [
  { name: "local-k8s", dir: "environments/local-k8s" },
  { name: "aws-landing-zone", dir: "environments/aws-landing-zone" },
  { name: "gcp-landing-zone", dir: "environments/gcp-landing-zone" },
];

for (const env of environments) {
  const tfvarsPath = path.join(TERRAFORM_DIR, env.dir, "terraform.tfvars.example");
  console.log(`\n[${env.name}]`);

  if (!existsSync(tfvarsPath)) {
    record(`${env.name} tfvars 存在`, false, tfvarsPath);
    continue;
  }
  const parsed = parseTfvars(readFileSync(tfvarsPath, "utf8"));
  const missing = [];
  if (!parsed.subnets) missing.push("private_subnet_cidrs");
  if (parsed.dbPublic === null) missing.push("database_publicly_accessible");
  if (!parsed.logKey) missing.push("log_encryption_kms_key_ref");
  record("统一变量齐全", missing.length === 0, missing.length ? `缺 ${missing.join(", ")}` : "");

  const g1 = parsed.subnets ? checkGate1(parsed.subnets) : ["未解析到子网清单"];
  record("GATE-1 强制私有子网", g1.length === 0, g1.join("; ") || parsed.subnets?.join(" + "));
  const g2 = parsed.dbPublic === null ? ["未解析到开关"] : checkGate2(parsed.dbPublic);
  record("GATE-2 禁止公网裸库", g2.length === 0, g2.join("; ") || "publicly_accessible = false");
  const g3 = checkGate3(parsed.logKey);
  record("GATE-3 强制日志加密", g3.length === 0, g3.join("; ") || parsed.logKey);
}

// ---------------------------------------------------------------------------
// 总判 + 审计落盘（JSONL 只增不改）
// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
const passed = results.length - failed.length;
console.log(`\n==== 门禁自检总判：${passed}/${results.length} 通过 ${failed.length === 0 ? "✅ 全绿放行" : "❌ 存在拦截项，禁止发货"} ====`);

// 台账：data/day35/gates-checks.jsonl 只增不改（与 llm_usage_logs 同款纪律）
import { appendFileSync, mkdirSync } from "node:fs";
const ledgerDir = path.join(ROOT, "data", "day35");
mkdirSync(ledgerDir, { recursive: true });
appendFileSync(
  path.join(ledgerDir, "gates-checks.jsonl"),
  JSON.stringify({
    ts: new Date().toISOString(),
    passed,
    total: results.length,
    allGreen: failed.length === 0,
    failedLabels: failed.map((f) => f.label),
  }) + "\n",
);
console.log("审计台账：data/day35/gates-checks.jsonl（只增不改）+1 行");

process.exitCode = failed.length === 0 ? 0 : 1;
