"use client";

/**
 * ENG-102 · 搜索过滤条组件
 * 溯源：03 方案书第一节（一线效率诉求）；01 号文档王主管沟通策略
 * 边界：受控组件，筛选状态由 ENG-105 统一持有；
 *      Props 类型本地声明（分段控件为纯展示子组件，Props 契约不变）。
 */

import SegmentedControl from "./ui/SegmentedControl";

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
      {/* 关键词搜索：即时过滤，无需按钮（磨砂胶囊 + 聚焦微光） */}
      <label className="relative block sm:w-72">
        <span className="sr-only">搜索工单</span>
        <input
          type="search"
          value={keyword}
          onChange={(e) => onKeywordChange(e.target.value)}
          placeholder="输入工单号或摘要关键词…"
          className="aurora-focus w-full rounded-full border border-hairline bg-white/80 px-4 py-2 text-sm text-ink outline-none transition placeholder:text-ink-3"
        />
      </label>

      {/* 部门筛选：macOS 分段药丸控件，可与关键词搜索叠加 */}
      <SegmentedControl
        ariaLabel="部门筛选"
        options={DEPARTMENTS.map((d) => ({ value: d, label: d }))}
        value={department}
        onChange={onDepartmentChange}
      />
    </div>
  );
}
