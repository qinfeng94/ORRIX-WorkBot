/**
 * security/kill-switch.ts —— Day 30 物理急停总电闸（唯一真源）
 * 语义（AGENTS.md「物理 Kill Switch 优先」红线）：
 *  - 生产开关 = 服务端环境变量 WORKBOT_KILL_SWITCH，只有运维能改，AI 与前端都碰不到；
 *  - 每次写操作执行前实时读取（零缓存）→ 环境变量被置位后 ≤1 秒内，所有 AI 写操作全部锁死；
 *  - 锁死范围：一切黄区动作（Dry-Run 起草也算——它是写操作的前置）与审批落账；
 *    绿区只读不受影响（急停不断日志、不断只读）；
 *  - 演习开关（setKillSwitchOverride）只存在于内存，重启即失效，仅供靶场演示与单元测试；
 *    两者任一开启即视为电闸合上（fail-closed）。
 */

/** 生产环境变量名（唯一入口；仅服务端可读，绝不能带 NEXT_PUBLIC_ 前缀） */
export const KILL_SWITCH_ENV_VAR = "WORKBOT_KILL_SWITCH";

/** 视为「电闸合上」的环境变量取值（1/true/on/yes/开；其余一律视为关，包括 unset） */
const ON_VALUES: ReadonlySet<string> = new Set(["1", "true", "on", "yes", "开", "开启"]);

export class KillSwitchError extends Error {
  readonly source: string;
  readonly action: string;

  constructor(source: string, action: string) {
    super(
      `物理急停总电闸已开启：AI 写操作已全部锁死（来源：${source} · 动作：${action}）。` +
        `请由运维在服务端环境变量 ${KILL_SWITCH_ENV_VAR} 中解除后恢复。`,
    );
    this.name = "KillSwitchError";
    this.source = source;
    this.action = action;
  }
}

/** 演习开关状态（内存级；null = 不干预，跟随环境变量） */
let drillOverride: boolean | null = null;

/** 生产环境变量口径：每次调用实时读 process.env，零缓存 → 置位后 ≤1 秒生效 */
export function isEnvKillSwitchOn(): boolean {
  const raw = (process.env[KILL_SWITCH_ENV_VAR] ?? "").trim().toLowerCase();
  return ON_VALUES.has(raw);
}

/** 实时综合判定：环境变量或演习开关任一开启即为开（fail-closed） */
export function isKillSwitchOn(): boolean {
  return isEnvKillSwitchOn() || (drillOverride ?? false);
}

/** 强制校验：电闸开启时抛 KillSwitchError（写路径调用前必须先过这一道） */
export function assertWriteAllowed(source: string, action: string): void {
  if (isKillSwitchOn()) {
    throw new KillSwitchError(source, action);
  }
}

/**
 * 演习开关（仅内存，重启即失效）：true = 强制合闸；false = 强制开闸；null = 跟随环境变量。
 * 只供靶场面板「电闸演习」与单元测试使用；生产解锁永远走服务端环境变量。
 */
export function setKillSwitchOverride(on: boolean | null): void {
  drillOverride = on;
}

/** 靶场/运维面板展示口径 */
export function killSwitchStatus(): {
  envVar: string;
  envOn: boolean;
  drillOverride: boolean | null;
  effectiveOn: boolean;
} {
  return {
    envVar: KILL_SWITCH_ENV_VAR,
    envOn: isEnvKillSwitchOn(),
    drillOverride,
    effectiveOn: isKillSwitchOn(),
  };
}

/** 启动自检：合闸必须锁死、开闸必须放行，错了拒绝服务 */
export function assertKillSwitchHealthy(): void {
  const prev = drillOverride;
  try {
    setKillSwitchOverride(true);
    if (!isKillSwitchOn()) {
      throw new Error("WorkBot 电闸自检失败：合闸后写操作仍被放行");
    }
    let threw = false;
    try {
      assertWriteAllowed("自检", "dryRunTool");
    } catch (err: unknown) {
      threw = err instanceof KillSwitchError;
      if (!threw) throw err;
    }
    if (!threw) {
      throw new Error("WorkBot 电闸自检失败：合闸后 assertWriteAllowed 未抛 KillSwitchError");
    }
    setKillSwitchOverride(false);
    if (isKillSwitchOn()) {
      throw new Error("WorkBot 电闸自检失败：开闸后写操作仍被锁死");
    }
    assertWriteAllowed("自检", "dryRunTool"); // 开闸放行：不抛即通过
  } finally {
    setKillSwitchOverride(prev);
  }
}
