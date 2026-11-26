"use client";

/**
 * 老 ERP 手工录入表单（客户端）：仿真沙盒的人工录入通道。
 * 提交目标：/api/sandbox-legacy-erp/submit（进程内沙盒存储，非任何生产库）。
 */

import { useState } from "react";

interface SubmitResponse {
  ok: boolean;
  receiptNo: string;
  sandboxTotal: number;
  error?: string;
}

const EMPTY_FORM = { supplier: "", invoiceNo: "", amount: "", dueDate: "", remark: "" };

export default function EntryForm() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [receipt, setReceipt] = useState<SubmitResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const update = (key: keyof typeof EMPTY_FORM, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    setReceipt(null);
    try {
      const res = await fetch("/api/sandbox-legacy-erp/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, source: "人工录入" }),
      });
      const data: unknown = await res.json();
      const parsed = data as SubmitResponse;
      if (!res.ok || !parsed.ok) {
        setReceipt({ ok: false, receiptNo: "", sandboxTotal: 0, error: parsed.error ?? "提交失败" });
      } else {
        setReceipt(parsed);
        setForm(EMPTY_FORM);
      }
    } catch {
      setReceipt({ ok: false, receiptNo: "", sandboxTotal: 0, error: "网络异常，请重试" });
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    "w-full rounded border border-emerald-700 bg-[#071c0f] px-2 py-1.5 text-xs text-emerald-200 outline-none placeholder:text-emerald-800 focus:border-emerald-400";

  return (
    <form onSubmit={handleSubmit} className="max-w-xl">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <label className="col-span-2 text-[11px] text-emerald-400">
          供应商名称 *
          <input
            required
            value={form.supplier}
            onChange={(e) => update("supplier", e.target.value)}
            placeholder="如：东莞恒达五金制品厂"
            className={inputCls}
          />
        </label>
        <label className="text-[11px] text-emerald-400">
          发票号 *
          <input
            required
            value={form.invoiceNo}
            onChange={(e) => update("invoiceNo", e.target.value)}
            placeholder="如：INV-2026-0901"
            className={inputCls}
          />
        </label>
        <label className="text-[11px] text-emerald-400">
          金额（元）*
          <input
            required
            type="number"
            min="1"
            value={form.amount}
            onChange={(e) => update("amount", e.target.value)}
            placeholder="如：18240"
            className={inputCls}
          />
        </label>
        <label className="text-[11px] text-emerald-400">
          到期日 *
          <input
            required
            type="date"
            value={form.dueDate}
            onChange={(e) => update("dueDate", e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="text-[11px] text-emerald-400">
          付款备注
          <input
            value={form.remark}
            onChange={(e) => update("remark", e.target.value)}
            placeholder="选填"
            className={inputCls}
          />
        </label>
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="mt-3 rounded border border-emerald-500 bg-emerald-800 px-4 py-1.5 text-xs font-bold text-emerald-100 hover:bg-emerald-700 disabled:opacity-50"
      >
        {submitting ? "保存中..." : "【提交保存】"}
      </button>

      {receipt && (
        <p
          className={`mt-3 rounded border px-3 py-2 text-xs ${
            receipt.ok
              ? "border-emerald-600 bg-emerald-950 text-emerald-300"
              : "border-red-500 bg-red-950 text-red-300"
          }`}
        >
          {receipt.ok
            ? `✔ 已保存（仿真沙盒）· 回执号 ${receipt.receiptNo} · 沙盒累计 ${receipt.sandboxTotal} 笔（进程内存，重启即清空）`
            : `✘ ${receipt.error}`}
        </p>
      )}
    </form>
  );
}
