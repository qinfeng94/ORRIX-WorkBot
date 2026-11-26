"use client";

/**
 * Day 36 · BYOK 客户密钥主权控制台（/config-studio 内独立板块）
 * 溯源：用户需求「展示星辰与瑞康各自的加密密钥状态 + 红色 1 秒 Kill Key 开关 +
 *       刷新工单列表亲眼看到该租户敏感数据锁定、另一租户不受影响」。
 * 边界：纯展示与人工运维动作，不包含任何 AI 自动操作；数据接口唯一来源
 *       /api/security/byok；解密值在服务端已脱敏，本组件不做二次处理。
 */

import { useCallback, useEffect, useState } from "react";
import type {
  ByokConsoleData,
  ByokTenantView,
} from "../api/security/byok/route";

interface ActionResponse {
  ok?: boolean;
  action?: string;
  tenantId?: string;
  /** 拔钥匙动作本身耗时（达标判定口径） */
  killMs?: number;
  /** 拔钥匙 → 实测拒绝解密 全程耗时（含环境开销） */
  lockMs?: number;
  restoreMs?: number;
  message?: string;
  error?: string;
}

/** 模块级取数函数：纯 fetch，供首屏 effect 与手动刷新共用 */
async function fetchConsole(): Promise<ByokConsoleData | null> {
  try {
    const res = await fetch("/api/security/byok", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as ByokConsoleData;
  } catch {
    return null;
  }
}

function shortFp(fp: string): string {
  return fp.length >= 16 ? `SHA-256:${fp.slice(0, 16)}…` : `SHA-256:${fp}`;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

const TIMELINE_LABELS: Readonly<Record<string, string>> = {
  activated: "密钥在位",
  kill: "拔钥匙",
  restore: "重新交付",
};

export default function ByokConsole() {
  const [data, setData] = useState<ByokConsoleData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyTenant, setBusyTenant] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [lastLockMs, setLastLockMs] = useState<number | null>(null);
  const [showTimeline, setShowTimeline] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await fetchConsole();
    if (next === null) {
      setLoadError("BYOK 控制台数据加载失败，请确认数据库与密钥仓可用后重试。");
      return;
    }
    setLoadError(null);
    setData(next);
  }, []);

  // 首屏加载：全部 setState 均发生在 await 之后（React 19 hooks 规则）
  useEffect(() => {
    let alive = true;
    (async () => {
      const first = await fetchConsole();
      if (!alive) return;
      if (first === null) {
        setLoadError("BYOK 控制台数据加载失败，请确认数据库与密钥仓可用后重试。");
        return;
      }
      setData(first);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const handleAction = useCallback(
    async (tenantId: string, action: "kill" | "restore") => {
      setBusyTenant(tenantId);
      setMsg(null);
      try {
        const res = await fetch("/api/security/byok", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, tenantId }),
        });
        const json = (await res.json()) as ActionResponse;
        if (!res.ok) {
          setMsg({ kind: "err", text: json.error ?? "操作失败（fail-closed）。" });
          return;
        }
        if (action === "kill" && typeof json.killMs === "number") {
          setLastLockMs(json.killMs);
        }
        setMsg({ kind: "ok", text: json.message ?? "操作完成。" });
        await refresh();
      } catch {
        setMsg({ kind: "err", text: "网络错误，密钥仓状态未确认，请重试。" });
      } finally {
        setBusyTenant(null);
      }
    },
    [refresh],
  );

  return (
    <section
      className="mt-6 rounded-2xl border-2 border-zinc-300 bg-white p-5 shadow-sm"
      aria-label="BYOK 客户密钥主权控制台"
    >
      {/* 标题与算法说明 */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">BYOK 客户密钥主权控制台</h2>
        <span className="rounded-full bg-zinc-900 px-2.5 py-0.5 text-[11px] font-bold text-white">
          Day 36 · 信封加密
        </span>
        {lastLockMs !== null && (
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white ${
              lastLockMs < 1000 ? "bg-emerald-600" : "bg-red-600"
            }`}
          >
            上次拔钥匙动作实测 {lastLockMs}ms · {lastLockMs < 1000 ? "≤1 秒达标" : "超时异常"}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-sm text-zinc-600">
        {data?.algorithm ??
          "AES-256-GCM 信封加密：每条敏感单据一把独立 DEK 加密内容，客户自带的 KEK 包裹 DEK；WorkBot 只存密文。"}
      </p>
      <div className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
        <b>钥匙主权归客户：</b>
        星辰与瑞康各自持有一把客户密钥（KEK）。WorkBot 侧只保存信封密文与 KEK 副本——
        客户随时可以<b>拔走钥匙</b>（吊销 KEK），该租户全部敏感单据瞬间拒绝解密，
        而另一家租户的业务完全不受影响；重新交付同一把密钥后，旧密文立即恢复可读（数据从未被动过）。
        本控制台为人工运维动作，不涉及任何 AI 自动打款或写业务系统数据。
      </div>

      {/* 全局消息 */}
      {msg && (
        <div
          role="status"
          className={`mt-3 rounded-xl px-3 py-2 text-sm font-semibold ${
            msg.kind === "ok"
              ? "bg-emerald-50 text-emerald-800"
              : "bg-red-50 text-red-700"
          }`}
        >
          {msg.text}
        </div>
      )}
      {loadError && (
        <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
          {loadError}
          <button
            type="button"
            onClick={() => void refresh()}
            className="ml-2 underline"
          >
            重试
          </button>
        </div>
      )}

      {/* 双租户密钥卡 */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {data?.tenants.map((tenant) => (
          <TenantKeyCard
            key={tenant.tenantId}
            tenant={tenant}
            busy={busyTenant === tenant.tenantId}
            onAction={handleAction}
            timelineOpen={showTimeline === tenant.tenantId}
            onToggleTimeline={() =>
              setShowTimeline((v) => (v === tenant.tenantId ? null : tenant.tenantId))
            }
          />
        ))}
      </div>

      <footer className="mt-4 text-center text-[11px] text-zinc-400">
        信封密文落库于 byok_secure_docs（明文永不落库）· 密钥操作台账 byok-audit.jsonl 只增不改 ·
        演示数据均为虚构
      </footer>
    </section>
  );
}

/* ================================================================
 * 单租户密钥卡
 * ================================================================ */

function TenantKeyCard(props: {
  tenant: ByokTenantView;
  busy: boolean;
  onAction: (tenantId: string, action: "kill" | "restore") => Promise<void>;
  timelineOpen: boolean;
  onToggleTimeline: () => void;
}) {
  const { tenant, busy, onAction, timelineOpen, onToggleTimeline } = props;
  const revoked = tenant.key.status === "revoked";
  const decryptedCount = tenant.docs.filter((d) => d.state === "decrypted").length;
  const lockedCount = tenant.docs.length - decryptedCount;

  return (
    <div
      className="rounded-2xl border-2 bg-zinc-50 p-4"
      style={{ borderColor: revoked ? "#dc2626" : `${tenant.primaryHex}55` }}
    >
      {/* 头部：公司 + 状态徽章 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-bold">{tenant.companyDisplayName}</h3>
        {revoked ? (
          <span className="rounded-full bg-red-600 px-3 py-1 text-xs font-bold text-white">
            已拔除 · 数据锁定
          </span>
        ) : (
          <span
            className="rounded-full px-3 py-1 text-xs font-bold text-white"
            style={{ backgroundColor: tenant.primaryHex }}
          >
            钥匙在位 · 加密中
          </span>
        )}
      </div>
      <p className="mt-1.5 font-mono text-xs text-zinc-500">
        KEK 指纹：{shortFp(tenant.key.fingerprint)}
      </p>
      <p className="mt-0.5 text-xs text-zinc-500">
        敏感单据 {tenant.docs.length} 条 ·{" "}
        {revoked ? (
          <span className="font-bold text-red-600">锁定 {lockedCount} 条 · 解密 0 条</span>
        ) : (
          <>
            已解密 <span className="font-bold text-emerald-700">{decryptedCount}</span> 条
            {lockedCount > 0 && ` · 异常锁定 ${lockedCount} 条`}
          </>
        )}
        {" "}· 本轮判定 {tenant.decryptMs}ms
      </p>
      {tenant.notice && (
        <p className="mt-1.5 rounded-lg bg-red-50 px-2 py-1.5 text-xs font-semibold text-red-700">
          {tenant.notice}
        </p>
      )}

      {/* 红色 Kill Key 开关 / 恢复按钮 */}
      <div className="mt-3">
        {revoked ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void onAction(tenant.tenantId, "restore")}
            className="w-full rounded-xl border-2 border-zinc-400 bg-white px-4 py-2.5 text-sm font-bold text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
          >
            {busy ? "客户密钥交付中…" : "重新交付密钥（客户侧自管 KMS 原样上传）"}
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void onAction(tenant.tenantId, "kill")}
              className="w-full rounded-xl bg-red-600 px-4 py-3 text-base font-black text-white shadow-lg shadow-red-200 transition hover:bg-red-700 active:scale-[0.99] disabled:opacity-50"
            >
              {busy ? "正在拔除密钥…" : "1 秒吊销租户密钥（Kill Key）"}
            </button>
            <p className="mt-1.5 text-center text-[11px] text-red-600">
              点击瞬间吊销该租户 KEK：该租户全部敏感单据立即拒绝解密，另一租户不受影响。
              客户重新交付同一把密钥即可无损恢复。
            </p>
          </>
        )}
      </div>

      {/* 时间线 */}
      <div className="mt-3">
        <button
          type="button"
          onClick={onToggleTimeline}
          className="text-xs font-semibold text-zinc-500 underline"
        >
          {timelineOpen ? "收起" : "查看"}密钥操作时间线（最近 10 条，台账留痕）
        </button>
        {timelineOpen && (
          <ul className="mt-1.5 space-y-1 rounded-xl bg-white p-2.5">
            {tenant.key.timeline.map((entry) => (
              <li key={`${entry.action}-${entry.at}`} className="text-[11px] leading-relaxed">
                <span
                  className={`mr-1.5 rounded px-1.5 py-0.5 font-bold text-white ${
                    entry.action === "kill"
                      ? "bg-red-600"
                      : entry.action === "restore"
                        ? "bg-zinc-500"
                        : "bg-emerald-600"
                  }`}
                >
                  {TIMELINE_LABELS[entry.action] ?? entry.action}
                </span>
                <span className="text-zinc-400">{fmtTime(entry.at)} · </span>
                {entry.detail}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 工单列表（敏感单据） */}
      <div className="mt-3 rounded-xl border border-zinc-200 bg-white">
        <div className="border-b border-zinc-200 px-3 py-2 text-xs font-bold text-zinc-600">
          敏感单据列表（信封密文库 · 展示层已脱敏）
        </div>
        {tenant.docs.length === 0 ? (
          <p className="px-3 py-3 text-xs text-zinc-400">
            暂无单据：密钥在位后访问本页会自动补种加密。
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {tenant.docs.map((doc) => (
              <li
                key={doc.ticketNo}
                className={`px-3 py-2.5 ${
                  doc.state === "locked"
                    ? "bg-red-50/70"
                    : "bg-white"
                }`}
                style={
                  doc.state === "decrypted"
                    ? { borderLeft: "3px solid #059669" }
                    : { borderLeft: "3px solid #dc2626" }
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="font-mono text-xs font-bold text-zinc-700">
                    {doc.ticketNo}
                  </span>
                  {doc.state === "decrypted" ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                      已解密
                    </span>
                  ) : (
                    <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">
                      锁定 · 拒绝解密
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {doc.department} · ¥{doc.amount.toLocaleString("zh-CN")} · {doc.summary}
                </p>
                {doc.state === "decrypted" ? (
                  <p className="mt-1 text-xs text-zinc-700">
                    {tenant.sensitiveLabels.name}：<b>{doc.name}</b>
                    <span className="mx-2 text-zinc-300">|</span>
                    {tenant.sensitiveLabels.account}：
                    <span className="font-mono">{doc.account}</span>
                  </p>
                ) : (
                  <p className="mt-1 text-xs font-semibold text-red-700">
                    {tenant.sensitiveLabels.name}：🔒 已锁定
                    <span className="mx-2 text-zinc-300">|</span>
                    {tenant.sensitiveLabels.account}：🔒 已锁定
                    <span className="ml-2 font-normal text-red-500">{doc.error}</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
