/**
 * Day 29 配置工作台 · 新租户发布 API（0 行代码 30 秒上架）
 * 溯源：
 *  - ADR-005「规则外置」：红线规则 = config/tenants/<tenantId>.json 里的纯数据 DSL，
 *    经 validateRuleDsl fail-closed 校验，全链路零 eval / new Function；
 *  - tenant-config.TENANT_ID_PATTERN：租户 ID 白名单正则，防路径穿越（写文件前的最后一道闸）；
 *  - 红区纪律：发布只写「租户配置文件」这一个新文件，绝不触碰业务数据与老 ERP；
 *  - fail-closed：已存在的租户拒绝覆盖（409），内容非法拒绝落盘（400）。
 */

import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { badRequest, errorResponse } from "@/lib/api-error";
import {
  loadTenantConfig,
  parseTenantConfig,
  TENANT_CONFIG_DIR,
  TENANT_ID_PATTERN,
  type TenantDocumentField,
} from "@/lib/ontology/tenant-config";

/** 默认单据字段（新租户模板共用；amount 必填是 parseTenantConfig 的硬性要求） */
const DEFAULT_DOCUMENT_FIELDS: readonly TenantDocumentField[] = [
  { key: "ticketNo", label: "单据编号", required: true, pii: false },
  { key: "department", label: "所属部门", required: true, pii: false },
  { key: "amount", label: "金额（元）", required: true, pii: false },
  { key: "summary", label: "异常摘要", required: false, pii: false },
  { key: "customerName", label: "客户姓名", required: false, pii: true },
];

/** 发布请求的受控形状（逐字段收窄，杜绝整包透传） */
interface PublishPayload {
  tenantId: string;
  companyDisplayName: string;
  departments: readonly string[];
  thresholdDepartment: string;
  thresholdAmount: number;
  namedApprovers: readonly string[];
  themePrimaryHex: string;
  themePrimaryName: string;
  templateId: string;
  redlineRules: ReadonlyArray<{ id: string; label: string; action: string; rule: unknown }>;
}

/** 从请求体逐字段收窄（任何多余字段一律丢弃，绝不透传） */
function narrowPayload(raw: unknown): PublishPayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;

  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  const companyDisplayName =
    typeof body.companyDisplayName === "string" ? body.companyDisplayName.trim() : "";
  const departments = Array.isArray(body.departments)
    ? body.departments.map((d) => String(d).trim()).filter((d) => d.length > 0)
    : [];
  const namedApprovers = Array.isArray(body.namedApprovers)
    ? body.namedApprovers.map((a) => String(a).trim()).filter((a) => a.length > 0)
    : [];
  const thresholdAmount = Number(body.thresholdAmount);
  const thresholdDepartment =
    typeof body.thresholdDepartment === "string" ? body.thresholdDepartment.trim() : "";
  const themePrimaryHex =
    typeof body.themePrimaryHex === "string" ? body.themePrimaryHex.trim() : "";
  const themePrimaryName =
    typeof body.themePrimaryName === "string" ? body.themePrimaryName.trim() : "";
  const templateId = typeof body.templateId === "string" ? body.templateId.trim() : "";
  const redlineRules = Array.isArray(body.redlineRules)
    ? body.redlineRules.map((r) => {
        const rec = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
        return {
          id: String(rec.id ?? "").trim(),
          label: String(rec.label ?? "").trim(),
          action: String(rec.action ?? "").trim(),
          rule: rec.rule,
        };
      })
    : [];

  return {
    tenantId,
    companyDisplayName,
    departments,
    namedApprovers,
    thresholdAmount,
    thresholdDepartment,
    themePrimaryHex,
    themePrimaryName,
    templateId,
    redlineRules,
  };
}

/** POST /api/config-studio/publish —— 校验 → 组装 → fail-closed 复验 → 写 config/tenants/<id>.json */
export async function POST(request: Request): Promise<Response> {
  try {
    const narrowed = narrowPayload(await request.json());
    if (narrowed === null) {
      return badRequest("请求体格式非法。");
    }
    const p = narrowed;

    if (!TENANT_ID_PATTERN.test(p.tenantId)) {
      return badRequest("租户 ID 非法：只允许 2~64 位小写字母/数字/连字符（防路径穿越）。");
    }

    // fail-closed：已上架租户一律拒绝覆盖（改配置请走配置文件 + 评审，不走本向导）
    const filePath = path.join(TENANT_CONFIG_DIR, `${p.tenantId}.json`);
    try {
      await access(filePath);
      return NextResponse.json(
        { error: `租户「${p.tenantId}」已上架，向导不允许覆盖既有租户。` },
        { status: 409 },
      );
    } catch {
      // 文件不存在 = 可以发布（预期路径）
    }

    if (p.companyDisplayName.length === 0 || p.companyDisplayName.length > 40) {
      return badRequest("公司显示名必填且不超过 40 字。");
    }
    if (p.departments.length === 0) {
      return badRequest("至少填写一个部门。");
    }
    if (!p.departments.includes(p.thresholdDepartment)) {
      return badRequest("审批门槛部门必须来自部门清单。");
    }
    if (!Number.isInteger(p.thresholdAmount) || p.thresholdAmount <= 0 || p.thresholdAmount > 100_000_000) {
      return badRequest("审批门槛必须是大于 0 的整数（单位：元）。");
    }
    if (p.namedApprovers.length === 0) {
      return badRequest("至少填写一名具名审批人（AI/匿名/值班一律无效）。");
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(p.themePrimaryHex) || p.themePrimaryName.length === 0) {
      return badRequest("主题色非法：hex 必须是 #RRGGBB，色名必填。");
    }
    if (p.redlineRules.length > 20) {
      return badRequest("红线规则不超过 20 条。");
    }

    // 提示词模板从模板租户继承（文案真源仍是租户配置文件；占位符校验由 parseTenantConfig 兜底）
    const templateCfg = await loadTenantConfig(p.templateId);

    // 组装完整租户配置（纯数据 JSON，零可执行逻辑），再过 parseTenantConfig 全量复验
    const candidate = {
      tenantId: p.tenantId,
      companyDisplayName: p.companyDisplayName,
      departments: p.departments,
      approvalThreshold: {
        department: p.thresholdDepartment,
        amountYuan: p.thresholdAmount,
        mode: "above" as const,
      },
      namedApprovers: p.namedApprovers,
      flowDepartments: {
        logistics: p.departments[0] ?? "",
        finance: p.thresholdDepartment,
        complaint: p.departments[0] ?? "",
      },
      promptTemplate: templateCfg.promptTemplate,
      faultyPromptTemplate: templateCfg.faultyPromptTemplate,
      theme: { primaryHex: p.themePrimaryHex, primaryName: p.themePrimaryName },
      redlineRules: p.redlineRules,
      documentFields: DEFAULT_DOCUMENT_FIELDS,
    };
    parseTenantConfig(candidate); // 非法即抛错 → errorResponse 400，绝不落盘坏配置

    await writeFile(filePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf-8");
    return NextResponse.json({ ok: true, tenantId: p.tenantId }, { status: 201 });
  } catch (err: unknown) {
    return errorResponse(err);
  }
}
