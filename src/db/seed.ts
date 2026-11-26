/**
 * 首次启动种子数据：预置 6 张工单 + 2 条历史审批事件（全部虚构，幂等可重复执行）
 * 溯源：ENG-105 挂载层原 INITIAL_TICKETS / INITIAL_EVENTS 迁移入库；
 *      测试数据一律虚构（AGENTS.md 代码红线 3）。
 */

import { sql } from "drizzle-orm";
import type { WorkBotDatabase } from "@/db";
import { approvalAuditLogs, intakeRequests } from "@/db/schema";

const SEED_TICKETS = [
  {
    ticketNo: "T-2026-1101",
    department: "财务部",
    amount: 68500,
    summary:
      "德国仓滞销库存退货款，供应商发票合计与明细相差 ¥210，算术核对未通过，已标记疑似错账。",
    status: "待林总审批",
    customerName: "陈建国",
    bankAccount: "6222020200112341234",
    isFin001: true,
  },
  {
    ticketNo: "T-2026-1102",
    department: "财务部",
    amount: 52300,
    summary:
      "PayPal 收款汇率差额批量退款，涉及 3 个境外收款账户，需按现行 FIN-001 制度具名审批。",
    status: "待林总审批",
    customerName: "周文彬",
    bankAccount: "6217000010087654321",
    isFin001: true,
  },
  {
    ticketNo: "T-2026-1103",
    department: "财务部",
    amount: 49800,
    summary:
      "深圳物流商 Q4 运费对账争议退款。金额刚好低于 ¥50,000 红线，不触发 FIN-001。",
    status: "处理中",
    customerName: "吴晓岚",
    bankAccount: "6222081002234567890",
    isFin001: false,
  },
  {
    ticketNo: "T-2026-1104",
    department: "运营部",
    amount: 12000,
    summary:
      "广告投放误充值退款：德国站 CampA 系统多扣 5 天预算，运营部申请原路退回。",
    status: "待财务复核",
    customerName: "郑海涛",
    bankAccount: "6225880137788899001",
    isFin001: false,
  },
  {
    ticketNo: "T-2026-1105",
    department: "客服部",
    amount: 860,
    summary:
      "客户 FR-1042 反映订单少发一件商品，客服与仓库核实后按缺件部分退款。",
    status: "处理中",
    customerName: "马静怡",
    bankAccount: "6226090219988776655",
    isFin001: false,
  },
  {
    ticketNo: "T-2026-1106",
    department: "客服部",
    amount: 3200,
    summary:
      "美国客户尺码不符申请退货，全额退款含原运费，需等包裹寄回仓库验收后放款。",
    status: "待寄回验收",
    customerName: "何雨欣",
    bankAccount: "6228480402564890011",
    isFin001: false,
  },
];

const SEED_EVENTS = [
  {
    ticketNo: "T-2026-1096",
    approver: "林总",
    action: "放行工单 T-2026-1096（¥61,200）：德国仓退货款，已确认发票明细核对通过。",
    isFin001: true,
  },
  {
    ticketNo: "T-2026-1097",
    approver: "王主管",
    action: "确认发送工单 T-2026-1097 的退款结果通知客户。",
    isFin001: false,
  },
];

/** 顾问锁 key（任取的固定整数，仅用于「只播一次种」的并发互斥） */
const SEED_LOCK_KEY = 918273645;

/** 表为空时写入种子；事务 + 顾问锁保证并发下只执行一次 */
export async function seedIfEmpty(db: WorkBotDatabase): Promise<void> {
  await db.transaction(async (tx) => {
    // 会话级互斥：并发请求在此排队，锁在事务结束时自动释放
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY})`);

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(intakeRequests);
    if (count > 0) return;

    await tx.insert(intakeRequests).values(SEED_TICKETS).onConflictDoNothing();
    await tx.insert(approvalAuditLogs).values(SEED_EVENTS).onConflictDoNothing();
  });
}
