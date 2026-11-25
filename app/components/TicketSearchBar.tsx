"use client";

/**
 * ENG-102 · 搜索过滤条组件
 * 溯源：03 方案书第一节（一线效率诉求）；01 号文档王主管沟通策略
 * 边界：受控组件，筛选状态由 ENG-105 统一持有；
 *      Props 类型本地声明，不 import 其他组件（正交性要求）。
 */

interface TicketSearchBarProps {
  /** 当前搜索关键词 */
  keyword: string;
  /** 关键词变化回调 */
  onKeywordChange: (value: string) => void;
  /** 当前选中的部门筛选 */
  department: string;
  /** 部门筛选变化回调 */
  onDepartmentChange: (value: string) => void;
}

// 部门筛选标签（本地常量，与 ENG-105 的部门字段字符串一致）
const DEPARTMENTS = ["全部", "运营部", "财务部", "客服部"] as const;

export default function TicketSearchBar({
  keyword,
  onKeywordChange,
  department,
  onDepartmentChange,
}: TicketSearchBarProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      {/* 关键词搜索：即时过滤，无需按钮 */}
      <label className="relative block sm:w-72">
        <span className="sr-only">搜索工单</span>
        <input
          type="search"
          value={keyword}
          onChange={(e) => onKeywordChange(e.target.value)}
          placeholder="输入工单号或摘要关键词…"
          className="w-full rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none"
        />
      </label>

      {/* 部门筛选标签，可与关键词搜索叠加 */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="部门筛选">
        {DEPARTMENTS.map((d) => (
          <button
            key={d}
            onClick={() => onDepartmentChange(d)}
            aria-pressed={department === d}
            className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
              department === d
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-300 bg-white text-zinc-600 hover:border-zinc-500"
            }`}
          >
            {d}
          </button>
        ))}
      </div>
    </div>
  );
}
