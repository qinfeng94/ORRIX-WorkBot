/**
 * Day 14 · 老 ERP 仿真数据集（星辰供应链 ERP 2009 SP3）
 * 边界：全部为虚构演示数据（AGENTS.md 代码红线 3）；只供 /sandbox-legacy-erp 页面渲染，
 *      浏览器抓取引擎通过 HTTP 抓取该页面 HTML 解析，不直接 import 本文件（保证抓取真实性）。
 */

import type { LegacyErpInvoice } from "./types";

/** 原始行：status 为「已付清」时不受到期日影响 */
interface RawInvoice {
  invoiceNo: string;
  supplier: string;
  amount: number;
  /** 到期日 YYYY-MM-DD */
  dueDate: string;
  paid: boolean;
}

/** 24 条虚构供应商发票（分 3 页 × 每页 8 条） */
const RAW_INVOICES: RawInvoice[] = [
  // ---- 第 1 页 ----
  { invoiceNo: "INV-2026-0901", supplier: "东莞恒达五金制品厂", amount: 18240, dueDate: "2026-10-08", paid: false },
  { invoiceNo: "INV-2026-0912", supplier: "义乌泓瑞包装材料公司", amount: 6650, dueDate: "2026-10-15", paid: true },
  { invoiceNo: "INV-2026-0918", supplier: "广州丽丰塑胶有限公司", amount: 78300, dueDate: "2026-10-21", paid: false },
  { invoiceNo: "INV-2026-0925", supplier: "深圳迅捷物流股份有限公司", amount: 12900, dueDate: "2026-12-05", paid: false },
  { invoiceNo: "INV-2026-0933", supplier: "宁波百诚电子科技公司", amount: 45320, dueDate: "2026-11-02", paid: false },
  { invoiceNo: "INV-2026-0940", supplier: "青岛海诺食品加工厂", amount: 9280, dueDate: "2026-09-28", paid: false },
  { invoiceNo: "INV-2026-0947", supplier: "佛山金鸿纺织品有限公司", amount: 26750, dueDate: "2026-11-18", paid: true },
  { invoiceNo: "INV-2026-0955", supplier: "台州骏业模具制造公司", amount: 55100, dueDate: "2026-10-30", paid: false },
  // ---- 第 2 页 ----
  { invoiceNo: "INV-2026-0963", supplier: "温州晨曦鞋业有限公司", amount: 15800, dueDate: "2026-11-09", paid: false },
  { invoiceNo: "INV-2026-0971", supplier: "苏州朗润精密机械厂", amount: 92400, dueDate: "2026-10-12", paid: false },
  { invoiceNo: "INV-2026-0978", supplier: "中山博雅照明器材公司", amount: 7420, dueDate: "2026-12-20", paid: false },
  { invoiceNo: "INV-2026-0986", supplier: "泉州富闽针织集团有限公司", amount: 33160, dueDate: "2026-09-20", paid: false },
  { invoiceNo: "INV-2026-0994", supplier: "杭州钱塘印务有限公司", amount: 21540, dueDate: "2026-11-24", paid: false },
  { invoiceNo: "INV-2026-1002", supplier: "常州天宁轴承制造厂", amount: 13890, dueDate: "2026-10-25", paid: true },
  { invoiceNo: "INV-2026-1010", supplier: "厦门鹭岛渔具加工厂", amount: 67210, dueDate: "2026-11-06", paid: false },
  { invoiceNo: "INV-2026-1018", supplier: "嘉兴南湖丝巾织造公司", amount: 8760, dueDate: "2026-12-11", paid: false },
  // ---- 第 3 页 ----
  { invoiceNo: "INV-2026-1026", supplier: "无锡德诚不锈钢制品公司", amount: 44870, dueDate: "2026-10-18", paid: false },
  { invoiceNo: "INV-2026-1034", supplier: "绍兴柯桥染整厂", amount: 19830, dueDate: "2026-11-13", paid: false },
  { invoiceNo: "INV-2026-1042", supplier: "珠海格力美家电配件厂", amount: 88200, dueDate: "2026-09-15", paid: false },
  { invoiceNo: "INV-2026-1050", supplier: "东莞常平纸品包装公司", amount: 5390, dueDate: "2026-12-28", paid: false },
  { invoiceNo: "INV-2026-1058", supplier: "临沂鲁南钢材贸易公司", amount: 37640, dueDate: "2026-10-05", paid: false },
  { invoiceNo: "INV-2026-1066", supplier: "烟台锦程渔业装备公司", amount: 24310, dueDate: "2026-11-20", paid: true },
  { invoiceNo: "INV-2026-1074", supplier: "佛山顺德家具五金厂", amount: 7180, dueDate: "2026-12-02", paid: false },
  { invoiceNo: "INV-2026-1082", supplier: "武汉江城电气设备公司", amount: 59450, dueDate: "2026-10-27", paid: false },
];

/** 计算某条发票相对今天的展示状态（服务端渲染时调用，口径与抓取端一致） */
export function classifyInvoice(raw: RawInvoice, today: Date): LegacyErpInvoice {
  if (raw.paid) {
    return { ...raw, daysOverdue: 0, status: "已付清", sourcePage: 0 };
  }
  const due = new Date(`${raw.dueDate}T00:00:00+08:00`);
  const diffDays = Math.floor((today.getTime() - due.getTime()) / 86_400_000);
  if (diffDays > 0) {
    return { ...raw, daysOverdue: diffDays, status: "超期", sourcePage: 0 };
  }
  return { ...raw, daysOverdue: 0, status: "未到期", sourcePage: 0 };
}

/** 取某一页的发票（page ∈ 1~3），服务端渲染仿真 ERP 时调用 */
export function getInvoicePage(page: number): LegacyErpInvoice[] {
  const today = new Date();
  const start = (page - 1) * 8;
  return RAW_INVOICES.slice(start, start + 8).map((raw) => ({
    ...classifyInvoice(raw, today),
    sourcePage: page,
  }));
}

/** 总页数 */
export const LEGACY_ERP_TOTAL_PAGES = 3;
