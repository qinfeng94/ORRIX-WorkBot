/**
 * FIN-001 判定：全站单点唯一来源
 * 溯源：AGENTS.md 业务红线 FIN-001——单笔「超过」¥50,000 才触发，「等于」不触发；
 *      2025 年旧版 10 万额度制度已废止，本文件不得出现 100000 阈值。
 * 服务端（建单落库）与客户端（卡片高亮）共用本函数，禁止任何副本。
 */

/** 红线阈值（单位：元） */
export const FIN001_THRESHOLD_YUAN = 50000;

/** FIN-001 触发的最小金额（超 5 万，不含等于） */
export function isLargeAmount(t: { department: string; amount: number }): boolean {
  return t.department === "财务部" && t.amount > FIN001_THRESHOLD_YUAN;
}

/** 具名审批人校验（CISO 条款 3：AI / 匿名 / 部门 / 值班一律无效） */
export function isValidNamedApprover(approver: string): boolean {
  const forbidden = ["ai", "机器人", "自动", "系统", "值班"];
  const name = approver.trim();
  if (name.length === 0 || name.length > 20) return false;
  return !forbidden.some((word) => name.toLowerCase().includes(word.toLowerCase()));
}
