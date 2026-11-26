/**
 * demo-tapes.ts —— 多模态工作台 Tab 2 内置的两份仿真企业演示录像（纯数据，前后端共用）
 * 边界：全部为虚构演示数据（AGENTS.md 代码红线 3）；取证结论只出"标记/建议"，
 *      不下最终结论（04 号文档绿区 G4）；转工单一律走黄区人工审批，绝无自动放行。
 * 客户姓名与银行账号在展示层脱敏；金额口径为元（整数）。
 */

/** 单帧场景：title/lines 用于前端 canvas 仿真画面绘制；finding 为取证标注 */
export interface DemoTapeFrame {
  /** 时间戳（秒，服务端会钳位到 [0, durationSec]） */
  timestampSec: number;
  /** 仿真画面主标题（如告警弹窗标题） */
  sceneTitle: string;
  /** 仿真画面正文行 */
  sceneLines: string[];
  /** 场景强调色（仿真画面边框/标题色） */
  accent: string;
  /** 取证标注（中文大白话） */
  finding: string;
  /** 标注级别：info（正常）| warn（存疑）| risk（疑似异常，只标记不下结论） */
  level: "info" | "warn" | "risk";
}

export interface DemoTape {
  /** 录像标识（传给后端取证接口） */
  id: string;
  /** 录像名称（含时长，中文） */
  name: string;
  /** 总时长（秒） */
  durationSec: number;
  /** 描述 */
  description: string;
  /** 转待审工单默认部门 */
  department: "财务部" | "运营部" | "客服部";
  /** 转待审工单默认金额（元） */
  amount: number;
  /** 转待审工单默认摘要 */
  summary: string;
  frames: DemoTapeFrame[];
}

export const DEMO_TAPES: readonly DemoTape[] = [
  {
    id: "cold-chain-0320",
    name: "仓库冷链异常录屏 03:20",
    durationSec: 200,
    description:
      "仿真场景：DE 仓冷链温控巡检录屏。画面依次出现温控面板、温度跳变、告警弹窗与手工台账。",
    department: "运营部",
    amount: 32000,
    summary:
      "DE 仓冷链温度超过 -18℃ 阈值且告警未按 SOP 处置，疑似异常批次上架隔离区，需人工复核",
    frames: [
      {
        timestampSec: 12,
        sceneTitle: "温控面板 · 1 号冷库",
        sceneLines: ["当前温度：-18.0℃", "目标阈值：-18℃", "状态：正常运行"],
        accent: "#16a34a",
        finding: "画面取样锚点：温控面板显示正常，未见异常元素",
        level: "info",
      },
      {
        timestampSec: 65,
        sceneTitle: "温度曲线 · 出现跳变",
        sceneLines: ["01:04 温度：-2.3℃", "波动幅度：+15.7℃", "建议：核对制冷机组日志"],
        accent: "#f59e0b",
        finding: "温度曲线出现 15.7℃ 跳变，存疑，建议人工核对制冷机组日志",
        level: "warn",
      },
      {
        timestampSec: 107,
        sceneTitle: "⚠ 告警弹窗 · 未确认",
        sceneLines: ["告警编号：ALM-COLD-0912", "实测：-1.8℃（阈值 -18℃）", "确认人：（空）"],
        accent: "#dc2626",
        finding: "告警弹窗无具名确认人，疑似未按 SOP 处置（只标记，结论归人工）",
        level: "risk",
      },
      {
        timestampSec: 150,
        sceneTitle: "手工台账 · 纸质记录",
        sceneLines: ["记录时间：11-24 22:41", "记录温度：-16.2℃", "页脚：字迹与上一条不一致"],
        accent: "#f59e0b",
        finding: "手工台账温度与告警实测不一致，存在录入疑点，建议人工比对",
        level: "warn",
      },
      {
        timestampSec: 185,
        sceneTitle: "隔离区 · 批次上架",
        sceneLines: ["批次号：QA-2611", "操作：上架隔离区 A-03", "单据：无隔离审批单号"],
        accent: "#dc2626",
        finding: "疑似异常批次 QA-2611 上架隔离区但无审批单号，建议开立查验工单",
        level: "risk",
      },
    ],
  },
  {
    id: "vip-error-0215",
    name: "VIP 报错录屏 02:15",
    durationSec: 135,
    description:
      "仿真场景：VIP 客户支付回调报错录屏。画面出现报错弹窗、重复扣款流水与工单关联提示。",
    department: "财务部",
    amount: 52800,
    summary:
      "VIP 客户（张*）支付回调报错 ERR_DUPLICATE_CHARGE，同一订单两笔扣款合计 ¥52,800，疑似重复扣款",
    frames: [
      {
        timestampSec: 8,
        sceneTitle: "订单页 · VIP 客户",
        sceneLines: ["客户：CUST-8842（张*）", "订单：ORD-1106-V88", "状态：支付中"],
        accent: "#16a34a",
        finding: "画面取样锚点：VIP 订单页正常进入支付流程",
        level: "info",
      },
      {
        timestampSec: 52,
        sceneTitle: "✖ 报错弹窗 · 支付回调",
        sceneLines: ["错误码：ERR_DUPLICATE_CHARGE", "渠道回调：第二次进入", "建议：人工核对流水"],
        accent: "#dc2626",
        finding: "支付回调出现 ERR_DUPLICATE_CHARGE 报错，疑似重复扣款（只标记，结论归人工）",
        level: "risk",
      },
      {
        timestampSec: 75,
        sceneTitle: "支付流水 · 两笔扣款",
        sceneLines: [
          "流水①：11-24 21:37  ¥26,400",
          "流水②：11-24 21:37  ¥26,400",
          "合计：¥52,800（超过 FIN-001 红线）",
        ],
        accent: "#dc2626",
        finding: "同一订单两笔扣款合计 ¥52,800，超过 FIN-001 红线，必须具名人工审批",
        level: "risk",
      },
      {
        timestampSec: 110,
        sceneTitle: "工单页 · 关联提示",
        sceneLines: ["关联工单：TCK-3117", "客户经理：已同步", "复核会议：待预约"],
        accent: "#f59e0b",
        finding: "画面已关联工单 TCK-3117，财务复核会议待预约，建议人工跟进",
        level: "warn",
      },
    ],
  },
];

/** 按 id 查演示录像（后端取证接口与前端共用） */
export function findDemoTape(id: string): DemoTape | undefined {
  return DEMO_TAPES.find((t) => t.id === id);
}

/** 秒 → [MM:SS] 徽章文本（前后端共用同一口径） */
export function formatMmss(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  return `[${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}]`;
}
