/**
 * Day 18 · Inngest 编排客户端与「星辰大额审批流」函数
 * 溯源：FIN-001（步骤 2 必须挂起等待具名人工审批，最长 7 天）；
 *      AGENTS.md 红区（批准后只生成审计凭据 + 通知下游，严禁任何打款动作）。
 *
 * 三步编排：
 *   步骤 1  step.run          单据入库与算术校验（确定性计算，失败不进入挂起）
 *   步骤 2  step.waitForEvent 挂起等待林总审批事件（最长 7 天，持久层等待，不占内存）
 *   步骤 3  step.run          收到批准事件 → 生成审计凭据 + 通知下游
 *
 * 本地启动：npx inngest-cli@latest dev   （Dev Server 默认 http://127.0.0.1:8288，
 * 自动发现 Next.js 的 /api/inngest 端点；未启动时 /api/workflows 会自动降级到
 * 等价演练模式——Postgres 状态机，行为同构。）
 */

import { Inngest, type EventPayload } from "inngest";
import {
  completeRun,
  createRunQueued,
  expireRun,
  rejectRun,
  runIntakeStep,
  type CreateRunInput,
} from "./engine";

/**
 * Inngest 客户端（本地 Dev Server 模式：isDev + baseUrl 指向 npx inngest-cli dev 的默认地址；
 * 生产部署时移除 isDev，并改由 INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY 环境变量提供，密钥不硬编码。）
 */
export const inngest = new Inngest({
  id: "workbot",
  isDev: true,
  baseUrl: process.env.INNGEST_DEV_SERVER_URL ?? "http://127.0.0.1:8288",
});

/** 触发审批流的事件（携带完整单据数据） */
export const WORKFLOW_REQUESTED_EVENT = "workflow/star.requested";
/** 审批决定事件（match data.runId 精确唤醒对应挂起实例） */
export const WORKFLOW_DECIDED_EVENT = "workflow/star.decided";

/** 请求事件的数据结构（与 CreateRunInput 同构 + runId） */
export interface WorkflowRequestedData extends CreateRunInput {
  runId: string;
}

/** 审批决定事件的数据结构 */
export interface WorkflowDecidedData {
  runId: string;
  action: "approve" | "reject";
  approver: string;
}

/** 类型守卫：未知事件数据 → WorkflowRequestedData（边界处收窄，禁 any） */
function isRequestedData(data: unknown): data is WorkflowRequestedData {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d.runId === "string" && Array.isArray(d.items);
}

/** 类型守卫：未知事件数据 → WorkflowDecidedData */
function isDecidedData(data: unknown): data is WorkflowDecidedData {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.runId === "string" &&
    (d.action === "approve" || d.action === "reject") &&
    typeof d.approver === "string"
  );
}

/** 星辰大额审批流（Inngest 持久化函数：每一步的执行结果都记入 Inngest 持久层，断电可续） */
export const starApprovalFlow = inngest.createFunction(
  { id: "star-approval-flow", retries: 2, triggers: [{ event: WORKFLOW_REQUESTED_EVENT }] },
  async ({ event, step }) => {
    if (!isRequestedData(event.data)) {
      throw new Error("审批流事件数据不完整，已拒绝执行。");
    }
    const runId = event.data.runId;

    // 步骤 1：单据入库与算术校验（step 结果持久化；校验不过则流程在此终止）
    const detail = await step.run("step1-intake-validate", async () => {
      return runIntakeStep(runId);
    });

    if (!detail.ok) {
      return { runId, outcome: "invalid", reason: "算术校验不过，流程终止" };
    }

    // 步骤 2：挂起等待林总审批（最长 7 天；等待状态在 Inngest 持久层，不占内存；
    // match 保证只被「同一 runId」的决定事件唤醒。返回值经类型守卫收窄。）
    const decision: unknown = await step.waitForEvent("step2-wait-for-lin", {
      event: WORKFLOW_DECIDED_EVENT,
      match: "data.runId",
      timeout: "7d",
    });

    // 步骤 3：按决定收尾（批准 → 凭据 + 通知；退回 / 7 天超时 → 终止并留痕）
    return step.run("step3-audit-and-notify", async () => {
      if (!decision) {
        await expireRun(runId, "超过 7 天无人审批（Inngest waitForEvent 超时）");
        return { runId, outcome: "expired" as const };
      }
      if (!isDecidedData(decision)) {
        await expireRun(runId, "审批决定事件数据不完整，按过期保护处理");
        return { runId, outcome: "expired" as const };
      }
      if (decision.action === "reject") {
        await rejectRun(runId, decision.approver);
        return { runId, outcome: "rejected" as const };
      }
      const result = await completeRun(runId, decision.approver);
      return {
        runId,
        outcome: "completed" as const,
        auditCredential: result.auditCredential,
      };
    });
  },
);

/** 向 Inngest Dev Server 投递事件（Dev Server 未启动时抛错，由调用方降级） */
export async function sendInngestEvent(
  name: typeof WORKFLOW_REQUESTED_EVENT | typeof WORKFLOW_DECIDED_EVENT,
  data: WorkflowRequestedData | WorkflowDecidedData,
): Promise<void> {
  const payload: EventPayload = { name, data };
  const result = await inngest.send(payload);
  if (!result.ids || result.ids.length === 0) {
    throw new Error("Inngest 未接受该事件（Dev Server 可能未启动）。");
  }
}

export { createRunQueued };
