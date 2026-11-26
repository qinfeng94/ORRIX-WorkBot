/**
 * Day 29 配置工作台（页面薄壳）
 * 数据读取在客户端经 GET /api/config-studio/tenants 完成（与全站页面惯例一致），
 * 主题色、部门标签、审批红线、红线 DSL 全部随租户一键切换。
 */

import type { Metadata } from "next";
import type { ReactElement } from "react";
import ConfigStudioClient from "./config-studio-client";

export const metadata: Metadata = {
  title: "配置工作台 · WorkBot",
  description: "零代码多租户规则引擎与 30 秒上架向导（虚构演示）",
};

export default function ConfigStudioPage(): ReactElement {
  return <ConfigStudioClient />;
}
