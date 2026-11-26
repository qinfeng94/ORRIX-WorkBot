/**
 * fleet-scheduler.d.ts — Day 22 并发代理军团调度器类型声明
 * 供 Next.js（app/ 下任意 Route Handler）import 复用：
 *   import { runFleet, buildFleetBatch } from '@/lib/day22/fleet-scheduler.mjs';
 */

export interface FleetTicket {
  ticketId: string;
  customerId: string;
  /** 已脱敏（王*） */
  customerName: string;
  dept: 'finance' | 'service' | 'logistics';
  deptLabel: string;
  amountCny: number;
  issue: string;
  issueDate: string;
  splitGroup: string | null;
}

export type FleetTicketStatus = 'done' | 'fin001_intercepted' | 'failed';

export interface FleetTicketResult {
  ticketId: string;
  customerId: string;
  customerName: string;
  deptLabel: string;
  amountCny: number;
  issue: string;
  status: FleetTicketStatus;
  fin001Triggered: boolean;
  fin001Reason: string;
  mergedAmountCny: number | null;
  attempts: number;
  retries: number;
  /** 单笔端到端耗时（含重试退避），毫秒 */
  durationMs: number;
  /** 含失败尝试的累计费用（美元） */
  costUsd: number;
  note: string;
}

export interface FleetStats {
  totalElapsedMs: number;
  avgPerTicketMs: number;
  p95PerTicketMs: number;
  maxPerTicketMs: number;
  totalCostUsd: number;
  fin001Intercepted: number;
  succeeded: number;
  failed: number;
  totalRetries: number;
  throughputPerMinute: number;
}

export interface FleetReport {
  runId: string;
  runBy: 'cli' | 'web';
  startedAt: string;
  finishedAt: string;
  config: { total: number; concurrency: number; maxAttempts: number; seed: number };
  stats: FleetStats;
  tickets: FleetTicketResult[];
}

export type FleetEventType =
  | 'fleet_start'
  | 'ticket_start'
  | 'ticket_retry'
  | 'ticket_done'
  | 'fleet_done';

export interface FleetEvent {
  type: FleetEventType;
  total?: number;
  concurrency?: number;
  ticketId?: string;
  done?: number;
  attempt?: number;
  waitMs?: number;
  reason?: string;
  status?: FleetTicketStatus;
  fin001Triggered?: boolean;
  durationMs?: number;
  costUsd?: number;
  report?: FleetReport;
  /** 调度器异常熔断原因（正常跑批不出现，网页端如实上报） */
  fatal?: string;
}

export interface RunFleetOptions {
  total?: number;
  concurrency?: number;
  maxAttempts?: number;
  seed?: number;
  runBy?: 'cli' | 'web';
  onEvent?: (event: FleetEvent) => void;
}

/** 生成确定性异常单据批量（同 seed 完全可复现） */
export declare function buildFleetBatch(total?: number, seed?: number): FleetTicket[];

/** 跑一批异常单据初审：并发池 + 指数退避重试 + FIN-001 拦截 + 用量统计 */
export declare function runFleet(opts?: RunFleetOptions): Promise<FleetReport>;

/** FIN-001 判定（确定性规则）：直接大额或疑似拆单合并超限 */
export declare function checkFin001(
  t: FleetTicket,
  splitGroups: Map<string, number>,
): { triggered: boolean; reason: string; mergedAmountCny: number | null };

/** 疑似拆单组预计算：同客户同日多笔、合并金额超过红线的组 */
export declare function buildSplitGroups(tickets: FleetTicket[]): Map<string, number>;

/** 确定性伪随机（mulberry32）：同 seed 重跑结果完全可复现 */
export declare function mulberry32(seed: number): () => number;
