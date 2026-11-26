/**
 * security/rbac.ts —— Day 30 四级 RBAC 权限控制（唯一真源）
 * 四级角色：访客只读 → 一线专员 → 部门审批官 → 安全管理员。
 * 红线口径（AGENTS.md + 04 号权限边界单）：
 *  - 访客只能看绿区只读内容；
 *  - 黄区起草（Dry-Run 草稿）从一线专员起；
 *  - 审批放行只归「部门审批官」，且必须叠加 fin001.isValidNamedApprover 具名校验（唯一真源）；
 *  - 安全管理员管安全（演习/提示词版本/全量审计只读），【职责分离】绝不批准财务单据；
 *  - write_any（直写业务系统正式数据）对任何角色都不存在——能力物理剔除，不是提示词劝阻。
 */

/** 四级 RBAC 角色（服务端会话指派；对话文本里自称的身份一律不采信） */
export type WorkbotRbacRole = "visitor" | "specialist" | "approver" | "security_admin";

/** 权限动作（矩阵的行） */
export type RbacAction =
  | "read_green" // 绿区只读（查快照 / 查政策 / 看自己的数据）
  | "draft_yellow" // 黄区起草（Dry-Run 草稿 + 审批单号，不落库）
  | "approve_fin001" // 审批放行（必须叠加具名在职审批人校验，AI 永远无此权限）
  | "manage_security" // 安全管理（红队演习 / 提示词热回滚 / 全量审计只读）
  | "write_any"; // 直写业务系统正式数据（红区：任何角色都不存在）

export const RBAC_ROLE_ORDER: readonly WorkbotRbacRole[] = [
  "visitor",
  "specialist",
  "approver",
  "security_admin",
];

export const RBAC_ROLE_LABELS: Record<WorkbotRbacRole, string> = {
  visitor: "访客（只读）",
  specialist: "一线专员",
  approver: "部门审批官",
  security_admin: "安全管理员",
};

export const RBAC_ACTION_LABELS: Record<RbacAction, string> = {
  read_green: "绿区只读",
  draft_yellow: "黄区起草 Dry-Run",
  approve_fin001: "审批放行（具名）",
  manage_security: "安全管理与演习",
  write_any: "直写正式数据",
};

/**
 * 权限矩阵（唯一事实）：
 *  - 访客：只读；
 *  - 一线专员：只读 + 黄区起草；
 *  - 部门审批官：只读 + 起草 + 审批放行；
 *  - 安全管理员：只读 + 起草？——不。管理员不参与业务起草与审批（职责分离）：
 *    只读 + 安全管理。审批放行与直写数据都与管理员无关。
 */
const RBAC_MATRIX: Record<WorkbotRbacRole, Readonly<Record<RbacAction, boolean>>> = {
  visitor: { read_green: true, draft_yellow: false, approve_fin001: false, manage_security: false, write_any: false },
  specialist: { read_green: true, draft_yellow: true, approve_fin001: false, manage_security: false, write_any: false },
  approver: { read_green: true, draft_yellow: true, approve_fin001: true, manage_security: false, write_any: false },
  security_admin: { read_green: true, draft_yellow: false, approve_fin001: false, manage_security: true, write_any: false },
};

export class PermissionDeniedError extends Error {
  readonly role: WorkbotRbacRole;
  readonly action: RbacAction;

  constructor(role: WorkbotRbacRole, action: RbacAction) {
    super(
      `RBAC 拒绝：${RBAC_ROLE_LABELS[role]} 无权执行「${RBAC_ACTION_LABELS[action]}」（Day 30 权限矩阵）`,
    );
    this.name = "PermissionDeniedError";
    this.role = role;
    this.action = action;
  }
}

/** 判定：某角色能否执行某动作（纯函数，不抛错） */
export function canDo(role: WorkbotRbacRole, action: RbacAction): boolean {
  return RBAC_MATRIX[role][action];
}

/** 强制校验：无权即抛 PermissionDeniedError（调用方负责转 403） */
export function assertPermission(role: WorkbotRbacRole, action: RbacAction): void {
  if (!canDo(role, action)) {
    throw new PermissionDeniedError(role, action);
  }
}

/**
 * 从对话文本解析「自称角色」的防御口径：一律返回访客。
 * 角色只认服务端会话指派，外部文本里自称「审批官 / 管理员」在数学上不可能提权。
 */
export function roleNeverFromText(_claimText: string): WorkbotRbacRole {
  return "visitor";
}

/** 启动自检：矩阵口径错了直接拒绝服务（fail-closed） */
export function assertRbacHealthy(): void {
  if (!canDo("visitor", "read_green")) {
    throw new Error("WorkBot RBAC 自检失败：访客必须能绿区只读");
  }
  if (canDo("visitor", "draft_yellow") || canDo("visitor", "approve_fin001")) {
    throw new Error("WorkBot RBAC 自检失败：访客不得起草或审批");
  }
  if (!canDo("specialist", "draft_yellow") || canDo("specialist", "approve_fin001")) {
    throw new Error("WorkBot RBAC 自检失败：一线专员应能起草、无权审批");
  }
  if (!canDo("approver", "approve_fin001")) {
    throw new Error("WorkBot RBAC 自检失败：部门审批官必须能审批放行");
  }
  // 职责分离：安全管理员绝不批准财务单据
  if (canDo("security_admin", "approve_fin001")) {
    throw new Error("WorkBot RBAC 自检失败：安全管理员不得审批财务单据（职责分离）");
  }
  // 红区：直写正式数据对任何角色都不存在
  for (const role of RBAC_ROLE_ORDER) {
    if (canDo(role, "write_any")) {
      throw new Error("WorkBot RBAC 自检失败：write_any 对任何角色都必须为 false（红区物理剔除）");
    }
  }
}
