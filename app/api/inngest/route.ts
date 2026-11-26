/**
 * /api/inngest —— Inngest 与 Next.js 的握手端点（serve）
 * 本地用法：
 *   1. pnpm dev                     （启动 Next.js，默认 http://localhost:3000）
 *   2. npx inngest-cli@latest dev   （启动 Inngest Dev Server，自动发现本端点）
 *   3. 打开 http://127.0.0.1:8288   （Dev Server UI，可看函数 / 挂起 / 恢复时间线）
 * 未启动 Dev Server 时，/api/workflows 会自动降级到等价演练模式（Postgres 状态机）。
 */

import { serve } from "inngest/next";
import { inngest, starApprovalFlow } from "@/lib/workflow/inngest";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [starApprovalFlow],
});
