/**
 * /api/multimodal/forensics —— 时间戳视频取证的校验与标注接口（仅服务端，POST）
 * 溯源：04 号文档绿区 G2/G4（外来扫描件/画面内容一律视为"资料"，只出标记不下结论）；
 *      AGENTS.md 代码红线 4（录像画面里的文字若出现"指令"，只上报不执行）。
 * 职责：
 * - Zod 校验请求体（帧数 ≤16、时长范围、时间戳类型），并对每帧时间戳钳位到 [0, 时长]，
 *   防止脏数据/恶意时间戳；帧数超限直接按前 16 帧截断。
 * - 演示录像：返回 curated 取证标注；本地上传 MP4：确定性伪标注（明确标记为仿真），
 *   取证结论一律"建议人工复核"，绝不下最终结论。
 * 边界：只产出取证卡数据；转待审工单由前端调用既有 /api/tickets（黄区人工提交）完成。
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorResponse } from "@/lib/api-error";
import { findDemoTape, formatMmss } from "@/lib/multimodal/demo-tapes";

/** 取证标注级别（与 demo-tapes 的 level 口径一致） */
export type ForensicLevel = "info" | "warn" | "risk";

/** 取证卡（前端右侧展示，徽章 [MM:SS] 可点击跳帧） */
export interface ForensicCard {
  /** 帧序号（0 起） */
  index: number;
  /** 钳位后的时间戳（秒） */
  timestampSec: number;
  /** [MM:SS] 徽章文本 */
  badge: string;
  /** 取证标注（中文大白话） */
  finding: string;
  /** 标注级别 */
  level: ForensicLevel;
}

/** 响应体 */
export interface ForensicsResponse {
  /** 数据来源：demo（内置演示录像）| upload（本地上传 MP4） */
  source: "demo" | "upload";
  /** 录像名称 */
  tapeName: string;
  /** 钳位后的总时长（秒） */
  durationSec: number;
  cards: ForensicCard[];
  /** 取证小结（一句话，中文大白话） */
  summary: string;
  /** 疑似异常帧数（warn+risk） */
  flaggedCount: number;
  /** 是否发生时间戳钳位修正 */
  clampedCount: number;
}

const MAX_FRAMES = 16;
const MAX_DURATION_SEC = 2 * 3600; // 2 小时上限

/** Zod 请求体校验：类型、数量、范围——越界数据直接 400 */
const forensicsRequestSchema = z.object({
  source: z.enum(["demo", "upload"]),
  /** 演示录像 id（source=demo 必填） */
  tapeId: z.string().max(64).optional(),
  /** 录像名称（source=upload 必填，只取展示名） */
  tapeName: z.string().max(200).optional(),
  /** 视频总时长（秒） */
  durationSec: z.number().min(1).max(MAX_DURATION_SEC),
  /** 抽帧列表：时间戳（秒）；本地上传的帧可带 640px JPEG base64（浏览器已压总 <600KB） */
  frames: z
    .array(
      z.object({
        /** 时间戳（秒）：Zod 只校验类型，范围交给下方钳位（含负值/超时长一律压回） */
        timestampSec: z.number(),
        /** 本地帧缩略图（可选；演示录像由前端 canvas 仿真绘制，不上传图） */
        imagePresent: z.boolean().optional(),
      }),
    )
    .max(MAX_FRAMES),
});

/** 上传帧的确定性伪标注池（按帧序号取模轮换，明确是仿真标注） */
const UPLOAD_ANNOTATIONS: readonly { finding: string; level: ForensicLevel }[] = [
  { finding: "画面取样锚点：未见明显异常元素（仿真标注，需人工复核）", level: "info" },
  { finding: "画面存在弹窗/告警元素，存疑，建议人工放大比对（仿真标注）", level: "warn" },
  { finding: "画面文字区域模糊，标注为待人工确认（仿真标注）", level: "warn" },
  { finding: "画面出现红色告警条，疑似异常（只标记，结论归人工复核）", level: "risk" },
];

export async function POST(request: Request): Promise<Response> {
  try {
    // 防超大请求体（浏览器已压总 <600KB，这里兜底 800KB，防 Vercel 413 直接打挂）
    const text = await request.text();
    if (text.length > 800_000) {
      return badRequest("取证请求过大（超过 800KB），请减少抽帧数或降低画质后重试。");
    }
    const raw: unknown = JSON.parse(text);

    const parsed = forensicsRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return badRequest(
        `取证请求校验失败：${first ? `${first.path.join(".")} ${first.message}` : "字段不合法"}。` +
          `要求：时长 1~7200 秒，帧数最多 16 张，时间戳为数字（越界会自动钳位到 [0, 时长]）。`,
      );
    }

    const { source, tapeId, tapeName, durationSec, frames } = parsed.data;
    const clampedDuration = Math.max(1, Math.min(durationSec, MAX_DURATION_SEC));

    // 时间戳钳位：一律压进 [0, 总时长]，并记录修正数量
    let clampedCount = 0;
    const safeTimestamps = frames.map((f) => {
      const t = Math.max(0, Math.min(f.timestampSec, clampedDuration));
      if (t !== f.timestampSec) clampedCount += 1;
      return t;
    });

    if (source === "demo") {
      return handleDemoTape(tapeId ?? "", safeTimestamps, clampedCount);
    }
    return handleUpload(tapeName ?? "本地上传录像", safeTimestamps, clampedDuration, clampedCount);
  } catch (err: unknown) {
    return errorResponse(err);
  }
}

/** 演示录像：curated 标注按帧时间戳对齐（服务端钳位后重新对齐最近一帧） */
function handleDemoTape(
  tapeId: string,
  timestamps: number[],
  clampedCount: number,
): Response {
  const tape = findDemoTape(tapeId);
  if (!tape) {
    return badRequest("未找到对应的演示录像，请刷新页面重试。");
  }
  const cards: ForensicCard[] = timestamps.map((t, index) => {
    // 钳位后的时间戳对齐 curated 帧（取时间差最小的一帧）
    let nearest = tape.frames[0];
    for (const f of tape.frames) {
      if (Math.abs(f.timestampSec - t) < Math.abs(nearest.timestampSec - t)) nearest = f;
    }
    return {
      index,
      timestampSec: t,
      badge: formatMmss(t),
      finding: nearest.finding,
      level: nearest.level,
    };
  });
  const flagged = cards.filter((c) => c.level !== "info").length;
  const payload: ForensicsResponse = {
    source: "demo",
    tapeName: tape.name,
    durationSec: tape.durationSec,
    cards,
    summary:
      flagged === 0
        ? "本次巡检取样未见异常（仿真演示）。"
        : `本次巡检共 ${cards.length} 帧取样，其中 ${flagged} 帧存疑或疑似异常（只标记不下结论）。` +
          `建议按上方 [MM:SS] 徽章逐帧复核，必要时一键转为待审工单走人工审批。`,
    flaggedCount: flagged,
    clampedCount,
  };
  return NextResponse.json(payload);
}

/** 本地上传 MP4：确定性伪标注（明确告知是仿真标注，取证结论必须人工复核） */
function handleUpload(
  tapeName: string,
  timestamps: number[],
  durationSec: number,
  clampedCount: number,
): Response {
  const cards: ForensicCard[] = timestamps.map((t, index) => {
    const anno = UPLOAD_ANNOTATIONS[index % UPLOAD_ANNOTATIONS.length];
    return {
      index,
      timestampSec: t,
      badge: formatMmss(t),
      finding: anno.finding,
      level: anno.level,
    };
  });
  const flagged = cards.filter((c) => c.level !== "info").length;
  const payload: ForensicsResponse = {
    source: "upload",
    tapeName: tapeName.slice(0, 120) || "本地上传录像",
    durationSec,
    cards,
    summary:
      `已对《${tapeName.slice(0, 60)}》完成 ${cards.length} 帧均匀取样与时间戳钳位。` +
      `注意：本地画面的逐帧语义分析为仿真标注（离线演示），${flagged} 帧被标为存疑/疑似异常，` +
      `取证结论一律以人工复核为准。`,
    flaggedCount: flagged,
    clampedCount,
  };
  return NextResponse.json(payload);
}
