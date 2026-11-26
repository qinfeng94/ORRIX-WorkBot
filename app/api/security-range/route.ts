/**
 * /api/security-range —— Day 30 红队攻防靶场 API（/security-range 面板的数据通道）
 * GET：返回电闸实时状态 + 四级 RBAC 权限矩阵 + 三层纵深自检 + 考卷元信息与最近一次演习台账；
 * POST：
 *  - { action: "run_drill" } → 一键发起 20 项红队攻击演习（全部探针判卷，台账落盘）；
 *  - { action: "kill_switch_drill", on: true | false } → 内存级电闸合闸/复位演习（重启即失效，
 *    生产解锁永远走服务端环境变量 WORKBOT_KILL_SWITCH，前端碰不到）。
 * 红线：全程只读评测 + 内存演习开关（用后复位），无任何打款 / 写业务数据动作。
 */

import { NextResponse, connection } from "next/server";
import {
  canDo,
  RBAC_ROLE_LABELS,
  RBAC_ROLE_ORDER,
  assertRbacHealthy,
  type RbacAction,
} from "@/lib/security/rbac";
import {
  killSwitchStatus,
  setKillSwitchOverride,
  assertKillSwitchHealthy,
} from "@/lib/security/kill-switch";
import { assertUntrustedHealthy } from "@/lib/security/untrusted";
import { readRedTeamSnapshot, runRedTeamDrill } from "@/lib/security/red-team";

/** 全量 20 项演习约 40 秒（离线高仿真，simSpeedFactor 0.2） */
export const maxDuration = 300;

/** 矩阵列顺序（展示口径；数据唯一事实在 rbac.ts 的 RBAC_MATRIX） */
const RBAC_ACTION_ORDER: readonly RbacAction[] = [
  "read_green",
  "draft_yellow",
  "approve_fin001",
  "manage_security",
  "write_any",
];

export async function GET() {
  // cacheComponents 下用 connection() 显式声明动态渲染（替代已不兼容的 export const dynamic）
  await connection();
  try {
    // 三层纵深启动自检（自检失败 = 拒绝服务，面板上直接亮红灯）
    const selfCheck: Record<string, boolean> = {};
    const selfCheckErrors: Record<string, string> = {};
    for (const [name, fn] of [
      ["rbac", assertRbacHealthy],
      ["killSwitch", assertKillSwitchHealthy],
      ["untrusted", assertUntrustedHealthy],
    ] as const) {
      try {
        fn();
        selfCheck[name] = true;
      } catch (err: unknown) {
        selfCheck[name] = false;
        selfCheckErrors[name] = err instanceof Error ? err.message : String(err);
      }
    }

    const snapshot = await readRedTeamSnapshot();
    return NextResponse.json({
      ok: true,
      snapshot: {
        killSwitch: killSwitchStatus(),
        rbac: {
          roles: RBAC_ROLE_ORDER.map((role) => ({
            role,
            label: RBAC_ROLE_LABELS[role],
            actions: RBAC_ACTION_ORDER.map((action) => ({ action, allowed: canDo(role, action) })),
          })),
          actionOrder: RBAC_ACTION_ORDER,
        },
        selfCheck,
        selfCheckErrors,
        suite: snapshot.suite,
        lastReport: snapshot.lastReport,
      },
    });
  } catch (err: unknown) {
    const text = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: text }, { status: 500 });
  }
}

interface SecurityRangePostBody {
  action?: string;
  on?: boolean;
}

export async function POST(req: Request) {
  let body: SecurityRangePostBody;
  await connection();
  try {
    body = (await req.json()) as SecurityRangePostBody;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (body.action === "run_drill") {
    try {
      const report = await runRedTeamDrill();
      return NextResponse.json({ ok: true, report });
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error: `红队演习执行异常：${text}` }, { status: 500 });
    }
  }

  if (body.action === "kill_switch_drill") {
    if (typeof body.on !== "boolean") {
      return NextResponse.json(
        { ok: false, error: "kill_switch_drill 需要 boolean 的 on 字段（true=合闸演习 / false=复位）" },
        { status: 400 },
      );
    }
    try {
      setKillSwitchOverride(body.on);
      return NextResponse.json({ ok: true, killSwitch: killSwitchStatus() });
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error: `电闸演习异常：${text}` }, { status: 500 });
    }
  }

  return NextResponse.json(
    { ok: false, error: "未知 action，支持：run_drill / kill_switch_drill（on=true|false）" },
    { status: 400 },
  );
}
