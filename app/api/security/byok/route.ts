/**
 * /api/security/byok —— Day 36 BYOK 客户密钥主权控制台数据接口（唯一入口）
 *
 * GET  ｜ 返回星辰与瑞康两个租户的密钥状态 + 敏感单据列表（在位租户逐单信封解密，
 *       吊销租户逐单拒绝解密并标注锁定原因）。首次访问为在位租户幂等补种密文。
 * POST ｜ { action: "kill" | "restore", tenantId }
 *       kill    —— 1 秒拔钥匙：销毁 KEK 副本，并实测「拔完→试解→拒绝」全程耗时 lockMs；
 *       restore —— 客户重新交付原密钥，旧信封全部恢复可解（实测 restoreMs）。
 *
 * 红线：本接口是人工运维动作（非 AI 动作），只改密钥仓状态与 WorkBot 自己的
 *       byok_secure_docs 派生密文库，业务表 intake_requests 零改动；
 *       PII 展示层脱敏在本接口完成（姓名 保首字、账号 前4后4）。
 */

import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { ensureSchema, getDb } from "@/db";
import { byokSecureDocs } from "@/db/schema";
import {
  loadTenantConfig,
  type TenantConfig,
} from "@/lib/ontology/tenant-config";
import { listTicketsForTenant } from "@/lib/ontology/tenant-repo";
import {
  auditByokEvent,
  decryptSensitiveForTenant,
  encryptSensitiveForTenant,
  killKey,
  KeyRevokedError,
  listTenantKeyStates,
  restoreKey,
  type EnvelopeBlob,
} from "@/lib/security/byok-kms";

/* ================================================================
 * 一、响应类型（与 /config-studio BYOK 控制台同源）
 * ================================================================ */

export interface ByokDocView {
  ticketNo: string;
  department: string;
  amount: number;
  summary: string;
  /** decrypted=已信封解密（展示层脱敏值）；locked=拒绝解密 */
  state: "decrypted" | "locked";
  name: string;
  account: string;
  /** 加密时 KEK 指纹（SHA-256 hex） */
  keyFp: string;
  /** 锁定原因（locked 时） */
  error?: string;
}

export interface ByokKeyView {
  status: "active" | "revoked";
  fingerprint: string;
  activatedAt: string;
  revokedAt: string | null;
  timeline: Array<{ action: string; at: string; fingerprint: string; detail: string }>;
}

export interface ByokTenantView {
  tenantId: string;
  companyDisplayName: string;
  primaryHex: string;
  sensitiveLabels: { name: string; account: string };
  key: ByokKeyView;
  docs: ByokDocView[];
  /** 本租户整批解密/锁定判定实测耗时（ms） */
  decryptMs: number;
  notice?: string;
}

export interface ByokConsoleData {
  algorithm: string;
  tenants: ByokTenantView[];
}

/* ================================================================
 * 二、展示层脱敏（AGENTS.md：张* / 6222 **** **** 1234）
 * ================================================================ */

function maskName(name: string): string {
  if (name.length <= 1) return `${name}*`;
  return `${name[0]}${"*".repeat(name.length - 1)}`;
}

function maskAccount(account: string): string {
  return account.length > 8
    ? `${account.slice(0, 4)} **** **** ${account.slice(-4)}`
    : "****";
}

/* ================================================================
 * 三、密文库补种（幂等）：真实工单优先，无工单租户用虚构演示单
 * ================================================================ */

interface SeedSource {
  ticketNo: string;
  department: string;
  amount: number;
  summary: string;
  name: string;
  account: string;
}

/** 全部为虚构演示数据（AGENTS.md 代码红线 3） */
const FALLBACK_DOCS: Record<string, SeedSource[]> = {
  xingchen: [
    {
      ticketNo: "BYOK-XC-001",
      department: "财务部",
      amount: 68500,
      summary: "德国仓滞销库存退货款，发票明细核对未通过，已标记疑似错账。",
      name: "陈建国",
      account: "6222020200112341234",
    },
    {
      ticketNo: "BYOK-XC-002",
      department: "财务部",
      amount: 52300,
      summary: "PayPal 收款汇率差额批量退款，超过 5 万元按现行 FIN-001 具名审批。",
      name: "周文彬",
      account: "6217000010087654321",
    },
    {
      ticketNo: "BYOK-XC-003",
      department: "客服部",
      amount: 860,
      summary: "客户反映订单少发一件商品，按缺件部分退款。",
      name: "马静怡",
      account: "6226090219988776655",
    },
  ],
  ruikang: [
    {
      ticketNo: "BYOK-RK-001",
      department: "采购部",
      amount: 45000,
      summary: "III 类医疗器械采购预付款，等待供应商合规审批。",
      name: "华重楼",
      account: "6228480402112233445",
    },
    {
      ticketNo: "BYOK-RK-002",
      department: "质控部",
      amount: 12800,
      summary: "冷链运输温度偏差 +2.5℃，触发 RK-COLD-002 人工复核。",
      name: "南宫雪",
      account: "6222020200998877665",
    },
    {
      ticketNo: "BYOK-RK-003",
      department: "仓储物流部",
      amount: 6600,
      summary: "仓储耗材月结费用，账期 30 天。",
      name: "慕容青",
      account: "6217000010055667788",
    },
  ],
};

/** 信封结构白盒校验（fail-closed，防止脏数据直入解密原语） */
function asEnvelope(raw: unknown, ticketNo: string): EnvelopeBlob {
  const rec = raw as Record<string, unknown> | null;
  if (typeof rec !== "object" || rec === null) {
    throw new Error(`单据 ${ticketNo} 信封结构非法。`);
  }
  if (rec.v !== 1) {
    throw new Error(`单据 ${ticketNo} 信封版本不支持（v=${String(rec.v)}）。`);
  }
  for (const field of ["fp", "dekIv", "dekTag", "wrappedDek", "iv", "tag", "ct"]) {
    if (typeof rec[field] !== "string") {
      throw new Error(`单据 ${ticketNo} 信封字段 ${field} 非法。`);
    }
  }
  return rec as unknown as EnvelopeBlob;
}

/** 为在位租户补种缺失的加密单据（真实工单优先；返回本次新入档数） */
async function seedDocsForTenant(tenantId: string): Promise<number> {
  const realRows = await listTicketsForTenant(tenantId);
  const sources: SeedSource[] =
    realRows.length > 0
      ? realRows.map((row) => ({
          ticketNo: row.ticketNo,
          department: row.department,
          amount: row.amount,
          summary: row.summary,
          name: row.customerName,
          account: row.bankAccount,
        }))
      : FALLBACK_DOCS[tenantId] ?? [];
  const existing = await getDb()
    .select({ ticketNo: byokSecureDocs.ticketNo })
    .from(byokSecureDocs)
    .where(eq(byokSecureDocs.tenantId, tenantId));
  const have = new Set(existing.map((row) => row.ticketNo));
  let inserted = 0;
  for (const src of sources.slice(0, 12)) {
    if (have.has(src.ticketNo)) continue;
    const { envelope, keyFingerprint } = await encryptSensitiveForTenant(
      tenantId,
      src.ticketNo,
      { name: src.name, account: src.account },
    );
    const envelopeJson: Record<string, unknown> = { ...envelope };
    await getDb()
      .insert(byokSecureDocs)
      .values({
        tenantId,
        ticketNo: src.ticketNo,
        department: src.department,
        amount: src.amount,
        summary: src.summary,
        envelope: envelopeJson,
        keyFp: keyFingerprint,
      })
      .onConflictDoNothing();
    inserted += 1;
  }
  if (inserted > 0) {
    await auditByokEvent(
      "seed",
      tenantId,
      `信封补种 ${inserted} 条敏感单据密文（真实工单优先，明文永不落库）`,
      { inserted },
    );
  }
  return inserted;
}

/* ================================================================
 * 四、GET：密钥状态 + 单据列表（在位解密 / 吊销锁定）
 * ================================================================ */

async function buildTenantView(
  tenantId: string,
  state: { status: "active" | "revoked"; fingerprint: string; activatedAt: string; revokedAt: string | null; timeline: Array<{ action: string; at: string; fingerprint: string; detail: string }> },
  config: TenantConfig,
): Promise<ByokTenantView> {
  if (state.status === "active") {
    await seedDocsForTenant(tenantId);
  }
  const rows = await getDb()
    .select()
    .from(byokSecureDocs)
    .where(eq(byokSecureDocs.tenantId, tenantId))
    .orderBy(asc(byokSecureDocs.id));

  const t0 = performance.now();
  const docs: ByokDocView[] = [];
  for (const row of rows) {
    const base = {
      ticketNo: row.ticketNo,
      department: row.department,
      amount: row.amount,
      summary: row.summary,
      keyFp: row.keyFp,
    };
    try {
      const payload = await decryptSensitiveForTenant(
        tenantId,
        row.ticketNo,
        asEnvelope(row.envelope, row.ticketNo),
      );
      docs.push({
        ...base,
        state: "decrypted",
        name: maskName(payload.name),
        account: maskAccount(payload.account),
      });
    } catch (err) {
      const locked =
        err instanceof KeyRevokedError ||
        (err instanceof Error && err.message.includes("BYOK 密钥已被吊销"));
      docs.push({
        ...base,
        state: "locked",
        name: "",
        account: "",
        error: locked
          ? "KEK 已吊销 · 拒绝解密（信封完好，重新交付密钥即可恢复）"
          : `信封校验失败：${err instanceof Error ? err.message : "未知错误"}`,
      });
    }
  }
  const decryptMs = Math.round(performance.now() - t0);

  const view: ByokTenantView = {
    tenantId,
    companyDisplayName: config.companyDisplayName,
    primaryHex: config.theme.primaryHex,
    sensitiveLabels:
      tenantId === "ruikang"
        ? { name: "患者姓名", account: "银行账号" }
        : { name: "客户姓名", account: "银行账号" },
    key: {
      status: state.status,
      fingerprint: state.fingerprint,
      activatedAt: state.activatedAt,
      revokedAt: state.revokedAt,
      timeline: state.timeline,
    },
    docs,
    decryptMs,
  };
  if (state.status === "revoked") {
    view.notice =
      "密钥已吊销：全部敏感单据拒绝解密，且新单据不入档加密（fail-closed）。重新交付密钥后立即恢复。";
  }
  return view;
}

export async function GET(): Promise<NextResponse> {
  try {
    await ensureSchema();
    const states = await listTenantKeyStates();
    const tenants: ByokTenantView[] = [];
    for (const state of states) {
      const config = await loadTenantConfig(state.tenantId);
      tenants.push(await buildTenantView(state.tenantId, state, config));
    }
    const data: ByokConsoleData = {
      algorithm: "AES-256-GCM 信封加密：每单独立 DEK 加密内容，客户自带 KEK 包裹 DEK",
      tenants,
    };
    return NextResponse.json(data);
  } catch (err) {
    console.error("[byok] GET 失败：", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "BYOK 控制台数据加载失败（fail-closed）。" },
      { status: 500 },
    );
  }
}

/* ================================================================
 * 五、POST：拔钥匙（kill）/ 重新交付（restore），带实测计时与验证
 * ================================================================ */

interface ByokActionBody {
  action: string;
  tenantId: string;
}

function parseActionBody(raw: unknown): ByokActionBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (
    (rec.action !== "kill" && rec.action !== "restore") ||
    typeof rec.tenantId !== "string" ||
    rec.tenantId.length === 0
  ) {
    return null;
  }
  return { action: rec.action, tenantId: rec.tenantId };
}

/** 拔完钥匙后抽一单实测「拒绝解密」确实发生（不硬凑：无单据时以 kill 成功为准） */
async function verifyLocked(tenantId: string): Promise<boolean> {
  const rows = await getDb()
    .select()
    .from(byokSecureDocs)
    .where(eq(byokSecureDocs.tenantId, tenantId))
    .orderBy(asc(byokSecureDocs.id))
    .limit(1);
  if (rows.length === 0) return true;
  try {
    await decryptSensitiveForTenant(
      tenantId,
      rows[0]!.ticketNo,
      asEnvelope(rows[0]!.envelope, rows[0]!.ticketNo),
    );
    return false; // 竟然解密成功 → 验证不通过
  } catch {
    return true; // 拒绝解密 → 验证通过
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    await ensureSchema();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
    }
    const parsed = parseActionBody(body);
    if (!parsed) {
      return NextResponse.json(
        { error: "参数非法：需要 { action: 'kill'|'restore', tenantId }。" },
        { status: 400 },
      );
    }
    const config = await loadTenantConfig(parsed.tenantId).catch(() => null);
    if (!config) {
      return NextResponse.json(
        { error: `租户 ${parsed.tenantId} 不存在（fail-closed）。` },
        { status: 400 },
      );
    }

    if (parsed.action === "kill") {
      const t0 = performance.now();
      const { alreadyRevoked, state } = await killKey(parsed.tenantId);
      const killMs = Math.round(performance.now() - t0);
      if (alreadyRevoked) {
        return NextResponse.json(
          { error: `租户 ${config.companyDisplayName} 的密钥已处于吊销状态，无需重复拔除。` },
          { status: 409 },
        );
      }
      const verified = await verifyLocked(parsed.tenantId);
      const lockMs = Math.round(performance.now() - t0);
      if (!verified) {
        return NextResponse.json(
          { error: "拔钥匙后实测仍能解密：验证不通过，请立即检查（fail-closed）。" },
          { status: 500 },
        );
      }
      return NextResponse.json({
        ok: true,
        action: "kill",
        tenantId: parsed.tenantId,
        /** 拔钥匙动作本身耗时（吊销 KEK 副本 + 台账留痕），达标判定口径 */
        killMs,
        /** 拔钥匙 → 实测拒绝解密 全程耗时（含 dev 冷启动等环境开销，仅供参考） */
        lockMs,
        withinOneSecond: killMs < 1000,
        fingerprint: state.fingerprint,
        message: `已吊销 ${config.companyDisplayName} 密钥（拔钥匙 ${killMs}ms），实测敏感数据拒绝解密，锁定生效。`,
      });
    }

    // restore
    const t0 = performance.now();
    const { alreadyActive } = await restoreKey(parsed.tenantId);
    if (alreadyActive) {
      return NextResponse.json(
        { error: `租户 ${config.companyDisplayName} 的密钥已在位，无需重新交付。` },
        { status: 409 },
      );
    }
    const verified = await verifyLocked(parsed.tenantId).then(
      (locked) => !locked,
      () => false,
    );
    const restoreMs = Math.round(performance.now() - t0);
    return NextResponse.json({
      ok: true,
      action: "restore",
      tenantId: parsed.tenantId,
      restoreMs,
      verified,
      message: verified
        ? `已重新交付 ${config.companyDisplayName} 密钥，旧信封实测恢复可解（${restoreMs}ms）。`
        : `已重新交付 ${config.companyDisplayName} 密钥（${restoreMs}ms）。`,
    });
  } catch (err) {
    console.error("[byok] POST 失败：", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "密钥操作失败（fail-closed）。" },
      { status: 500 },
    );
  }
}
