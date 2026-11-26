/**
 * App Shell · 导航配置（单一数据真源）
 * SideDock 侧边坞与 Spotlight ⌘K 面板共用本清单；新增路由只改这里。
 * 四大分组：日常协同与受理 / 智能体与洞察 / 治理安全与架构 / 经营交付与路演。
 */

export interface ShellRoute {
  /** 路由路径（/ 为根） */
  readonly href: string;
  /** 中文导航名 */
  readonly label: string;
}

export interface ShellRouteGroup {
  /** 分组名（Keynote 小标题排版用） */
  readonly title: string;
  readonly routes: readonly ShellRoute[];
}

export const SHELL_NAV_GROUPS: readonly ShellRouteGroup[] = [
  {
    title: "日常协同与受理",
    routes: [
      { href: "/", label: "异常工单协同台" },
      { href: "/chat", label: "透明对话工作台" },
      { href: "/doc-intake", label: "文档接入台" },
      { href: "/extraction", label: "单据抽取台" },
      { href: "/multimodal", label: "多模态工作台" },
      { href: "/channels", label: "全渠道网关" },
    ],
  },
  {
    title: "智能体与洞察",
    routes: [
      { href: "/studio", label: "生成式 UI 工作台" },
      { href: "/investigate", label: "自主调查引擎" },
      { href: "/multi-agent", label: "客服专班流水线" },
      { href: "/rag-lab", label: "检索实验室" },
      { href: "/browser-lab", label: "浏览器实验室（老ERP）" },
      { href: "/research-analyst", label: "尽调研究台" },
      { href: "/fleet", label: "代理军团" },
    ],
  },
  {
    title: "治理安全与架构",
    routes: [
      { href: "/config-studio", label: "配置工作台" },
      { href: "/workflows", label: "持久审批流" },
      { href: "/security-range", label: "红队靶场" },
      { href: "/eval-loop", label: "评测门禁" },
      { href: "/arch-audit", label: "架构体检" },
      { href: "/architecture-hub", label: "架构中心" },
      { href: "/observability", label: "生产可观测" },
      { href: "/sandbox-legacy-erp", label: "老ERP只读沙盒" },
    ],
  },
  {
    title: "经营交付与路演",
    routes: [
      { href: "/adoption-ops", label: "灰度采用台" },
      { href: "/analytics-agent", label: "ROI 分析代理" },
      { href: "/queue-lab", label: "并发压测台" },
      { href: "/sandbox-demo", label: "沙箱演示" },
    ],
  },
] as const;
