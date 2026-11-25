"use client";

/**
 * ENG-104 · 审批历史时间轴组件
 * 溯源：03 方案书第二节（合规：留痕）+ 第四节⑥（不可篡改审计日志）；
 *      04 号文档 CISO 条款 3（具名审批人）、条款 4（日志只增不改）。
 * 边界：只增不改——本组件无任何删除 / 编辑历史记录的入口；
 *      Props 类型本地声明，不 import 其他组件。
 */

// 审批事件类型：本地声明（timestamp 用可排序的 ISO 字符串，由 ENG-105 接线时传入）
export interface ApprovalEvent {
  id: string;
  /** 具名审批人（CISO 条款 3：禁止匿名/部门/值班等模糊身份） */
  approver: string;
  /** 审批时间戳（ISO 格式，展示时转为本地中文时间） */
  timestamp: string;
  /** 动作描述（中文大白话） */
  action: string;
  /** 是否为 FIN-001 大额放行事件（醒目琥珀色标记） */
  isFin001: boolean;
}

interface ApprovalTimelineProps {
  /** 审批事件列表（组件内部按时间倒序展示） */
  events: ApprovalEvent[];
}

export default function ApprovalTimeline({ events }: ApprovalTimelineProps) {
  // 时间倒序（新的在前）；不动原始数据顺序，只做展示排序
  const sorted = [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5" aria-label="审批历史时间轴">
      <h2 className="mb-4 text-sm font-bold text-zinc-700">审批历史时间轴</h2>

      {sorted.length === 0 ? (
        <p className="py-4 text-center text-sm text-zinc-400">
          还没有审批记录，大额工单放行后会出现在这里。
        </p>
      ) : (
        <ol className="relative ml-3 border-l-2 border-zinc-100">
          {sorted.map((e) => (
            <li key={e.id} className="mb-5 ml-6 last:mb-0">
              {/* 时间轴圆点：FIN-001 事件用琥珀色，普通事件用灰色 */}
              <span
                className={`absolute -left-[9px] mt-1.5 h-4 w-4 rounded-full border-2 border-white ${
                  e.isFin001 ? "bg-amber-500" : "bg-zinc-300"
                }`}
                aria-hidden
              />

              <div
                className={`rounded-lg border p-3 ${
                  e.isFin001
                    ? "border-amber-300 bg-amber-50"
                    : "border-zinc-100 bg-zinc-50"
                }`}
              >
                {/* 具名审批人 + 时间戳（条款 3、4：具名 + 留痕） */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-zinc-800">
                    {e.approver}
                    {e.isFin001 && (
                      <span className="ml-2 inline-flex items-center rounded-md bg-amber-500 px-2 py-0.5 text-xs font-bold text-white">
                        ⚠️ FIN-001 大额放行
                      </span>
                    )}
                  </p>
                  <time
                    dateTime={e.timestamp}
                    className="font-mono text-xs tabular-nums text-zinc-400"
                  >
                    {new Date(e.timestamp).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                  </time>
                </div>

                {/* 动作描述 */}
                <p className="mt-1.5 text-sm leading-6 text-zinc-600">{e.action}</p>
              </div>
            </li>
          ))}
        </ol>
      )}

      {/* 只增不改声明（CISO 条款 4） */}
      <p className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-zinc-400">
        🔒 审批记录只增不改：所有事件由系统自动留痕，本时间轴不提供任何删除或编辑入口。
      </p>
    </section>
  );
}
