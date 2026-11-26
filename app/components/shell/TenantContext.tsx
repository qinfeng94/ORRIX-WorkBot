"use client";

/**
 * 多租户热切上下文（表现层换肤专用）
 * 仅控制 --tenant-accent 主题色（星辰跨境 #0071E3 / 瑞康医疗 #0D9488）；
 * 业务级租户配置（阈值 / 部门 / 提示词 / 审批人）仍由服务端 config/tenants 动态加载，互不影响。
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

export type TenantId = "xingchen" | "ruikang";

export interface TenantMeta {
  readonly id: TenantId;
  /** 展示名 */
  readonly name: string;
  /** 胶囊短名 */
  readonly shortName: string;
  /** 主题色（与 globals.css 的 html[data-tenant] 保持一致） */
  readonly accent: string;
}

export const TENANTS: readonly TenantMeta[] = [
  { id: "xingchen", name: "星辰跨境企服集团", shortName: "星辰跨境", accent: "#0071E3" },
  { id: "ruikang", name: "瑞康医疗集团", shortName: "瑞康医疗", accent: "#0D9488" },
] as const;

interface TenantContextValue {
  readonly tenant: TenantId;
  readonly setTenant: (tenant: TenantId) => void;
}

const TenantContext = createContext<TenantContextValue | null>(null);

const STORAGE_KEY = "wb-tenant";

export function TenantProvider({ children }: { readonly children: ReactNode }) {
  const [tenant, setTenantState] = useState<TenantId>("xingchen");

  // 挂载后读取本地记忆；初始 SSR 与默认值一致，避免闪烁
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "xingchen" || saved === "ruikang") {
      setTenantState(saved);
    }
  }, []);

  // 主题换肤：写 html[data-tenant]，globals.css 据此切换 --tenant-accent
  useEffect(() => {
    document.documentElement.dataset.tenant = tenant;
  }, [tenant]);

  const setTenant = useCallback((next: TenantId) => {
    setTenantState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return <TenantContext.Provider value={{ tenant, setTenant }}>{children}</TenantContext.Provider>;
}

export function useTenant(): TenantContextValue {
  const ctx = useContext(TenantContext);
  if (!ctx) {
    throw new Error("useTenant 必须在 <TenantProvider> 内使用");
  }
  return ctx;
}

export function currentTenantMeta(id: TenantId): TenantMeta {
  const meta = TENANTS.find((t) => t.id === id);
  return meta ?? TENANTS[0];
}
