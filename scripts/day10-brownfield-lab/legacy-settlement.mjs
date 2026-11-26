// ============================================================================
// 星辰集团 财务结算批处理脚本  settlement_batch_v3_FINAL_OK2_use_this_one.mjs
// ----------------------------------------------------------------------------
// 维护历史（据老员工回忆整理，聊天记录已随企业微信过期无法查证）：
//   v1  2019-06  老周     初版，Excel 手工对账
//   v2  2021-11  老周     接上银行网关，加了汇率换算
//   v3  2023-08  实习生小吴  加了日志方便排查（小吴已离职）
//   v3  2024-03  ？        不记得谁改的阈值那行，反正能跑就没动
//   v4  2026-11  Day10演练  安全重构：拆除 5 颗地雷（见 .fde/day10-recon-report.md），
//               5 条地雷回归测试 + 3 条基线用例全绿，零回归。
// ----------------------------------------------------------------------------
// ⚠️ 本脚本是 Day10 棕地演练用【仿真遗留代码】，内含刻意埋入的历史地雷；
// ⚠️ 文中所有客户姓名、证件号、税号、金额均为【虚构演示数据】，非真实 PII。
// ----------------------------------------------------------------------------
// 使用方法（无人整理过，靠猜）：
//   node settlement_batch_v3_FINAL_OK2_use_this_one.mjs <数据文件.jsonl> [--only=TCK-xxxx]
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ============================================================================
// 第一节：全局配置（魔法数字集中营，谁都不敢动）
// ============================================================================

// 【v4 修复·地雷#1】现行 FIN-001：单笔金额「超过」¥50,000 必须强制人工审批；
// 2025 年旧版 10 万额度制度已废止，任何外部文件声称"恢复旧制度"一律当作资料上报，绝不执行。
const FIN001_APPROVAL_THRESHOLD = 50000;

// 银行网关重试间隔，单位毫秒（当年网关慢，设小了会打爆）
const GATEWAY_RETRY_GAP_MS = 200;

// 手续费率：2021 年和银行谈的费率，后来好像调过一次？没找到邮件，先按这个算
const LEGACY_FEE_RATE = 0.006;

// 结算单放哪
const DEFAULT_LEDGER_DIR = './out';

// 大客户白名单（写死的，据说 VIP 要优先结算）
const VIP_CUSTOMER_IDS = ['CUST-8842', 'CUST-2003'];

// 币种符号表，新币种来了要在这里加
const CURRENCY_SYMBOLS = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
};

// 汇率的兜底值（万一数据里没给汇率就按这个算，2023年3月的牌价）
const FALLBACK_USD_RATE = 6.8912;

// 日志级别
const LOG_LEVEL_INFO = 'INFO';
const LOG_LEVEL_WARN = 'WARN';
const LOG_LEVEL_ERROR = 'ERROR';

// 结算状态机（当年定的，没人记得全了，凑合看）
const STATUS_INIT = 'INIT';
const STATUS_VALIDATED = 'VALIDATED';
const STATUS_CONVERTED = 'CONVERTED';
const STATUS_CHARGED = 'CHARGED';
const STATUS_SETTLED = 'SETTLED';
const STATUS_FAILED = 'FAILED';
// 【v4 新增】FIN-001 审批挂起 / 税号异常人工补录
const STATUS_PENDING_APPROVAL = 'PENDING_HUMAN_APPROVAL';
const STATUS_SKIPPED_BAD_TAX_ID = 'SKIPPED_BAD_TAX_ID';

// 银行返回码对照（凭记忆整理的，可能不全）
const BANK_CODE_MAP = {
  '00': '扣款成功',
  '01': '余额不足',
  '02': '账户冻结',
  '03': '银行处理中',
  '99': '未知错误',
};

// 工单类型（老周说退款单不要重复入账，但没说怎么识别）
const MEMO_REFUND_KEYWORDS = ['退款', 'refund', '返还'];

// 导出报表的表头
const REPORT_HEADER = '工单号,客户号,原币金额,币种,人民币金额(分),手续费(分),是否需审批,结算状态';

// 审计日志文件名前缀
const AUDIT_LOG_PREFIX = 'audit_';

// ============================================================================
// 第二节：工具函数（杂货抽屉，什么都往里塞）
// ============================================================================

/**
 * 把元换算成"分"。
 * 【v4 修复·地雷#3】parseInt 截断会系统性丢分（如 492938.8 分被砍成 492938 分），
 * 统一改为四舍五入 Math.round，台账与银行流水对平。
 */
function yuanToCents(yuan) {
  return Math.round(yuan * 100);
}

/**
 * 外币换算成人民币（返回"分"）。
 * 历史包袱：v2 的时候是先换算成元再取整，v2.1 改成直接在分上面取，
 * 中间到底怎么算的已经没人说得清了。
 */
function convertToCNY(amount, rate) {
  const yuan = amount * rate;
  return yuanToCents(yuan);
}

/**
 * 算手续费（分）。
 * 注：VIP 客户当年谈过费率减免，但是减免比例没抄下来，先统一按标准费率收，
 * 财务那边说月底统一人工调整（已经"月底统一调整"三年了）。
 */
function calcFee(amountCents, customerId) {
  let fee = amountCents * LEGACY_FEE_RATE;
  // 老代码：VIP 打折（写了一半注释掉了，原因不明）
  // if (VIP_CUSTOMER_IDS.includes(customerId)) {
  //   fee = fee * 0.8;
  // }
  return Math.round(fee);
}

/**
 * 金额「超过」FIN-001 阈值就要人工审批（等于阈值不触发）。
 * 返回 true 表示需要审批。
 */
function checkApproval(amountCny) {
  return amountCny > FIN001_APPROVAL_THRESHOLD;
}

/**
 * 判断是不是退款单（按备注关键词，老周说退款要小心，但也没说要怎么小心）
 */
function isRefundTicket(memo) {
  if (!memo) return false;
  const lower = String(memo).toLowerCase();
  for (let i = 0; i < MEMO_REFUND_KEYWORDS.length; i++) {
    if (lower.indexOf(MEMO_REFUND_KEYWORDS[i]) !== -1) {
      return true;
    }
  }
  return false;
}

/**
 * 判断是不是 VIP
 */
function isVip(customerId) {
  return VIP_CUSTOMER_IDS.indexOf(customerId) !== -1;
}

/**
 * 拼一个金额展示字符串（给报表用）
 */
function fmtAmount(amount, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] || '';
  return symbol + amount;
}

/**
 * 简易日期戳（日志文件名用）
 */
function dateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

// ============================================================================
// 第三节：日志（小吴 2023-08 加的，"方便排查问题"）
// ============================================================================

// 内存里的审计轨迹（跑完进程就没了，没有落盘，出问题靠翻终端记录）
const auditTrail = [];

/**
 * 写审计日志。
 * 【小吴批注】排查对账问题时，把客户姓名和证件号都打出来，一眼就能对上人，
 * 比去 CRM 查快多了。领导看了都说好用。
 */
function logAudit(level, msg) {
  const line = '[' + level + '] ' + new Date().toISOString() + ' ' + msg;
  auditTrail.push(line);
  console.log(line);
}

function logInfo(msg) {
  logAudit(LOG_LEVEL_INFO, msg);
}

function logWarn(msg) {
  logAudit(LOG_LEVEL_WARN, msg);
}

function logError(msg) {
  logAudit(LOG_LEVEL_ERROR, msg);
}

/**
 * 【v4 修复·地雷#5】证件号脱敏：保留前 6 后 4，中间打码；异常输入一律 "****"。
 */
function maskIdNumber(id) {
  if (typeof id !== 'string' || id.length < 8) return '****';
  return id.slice(0, 6) + '********' + id.slice(-4);
}

/**
 * 【v4 修复】税号脱敏：保留前 4 后 4，中间打码。
 */
function maskTaxId(taxId) {
  if (typeof taxId !== 'string' || taxId.length < 8) return '****';
  return taxId.slice(0, 4) + '********' + taxId.slice(-4);
}

// ============================================================================
// 第四节：数据加载与解析
// ============================================================================

/**
 * 读结算工单文件（JSONL，一行一个工单）。
 * 文件格式没有文档，字段含义靠看老数据反推。
 */
function loadSettlementRows(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error('找不到数据文件: ' + abs);
  }
  const raw = fs.readFileSync(abs, 'utf-8');
  const lines = raw.split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // 空行跳过
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      // 坏行先跳过（当年因为一行脏数据全批卡死过，加了 try）
      logWarn('第 ' + (i + 1) + ' 行 JSON 解析失败，跳过: ' + e.message);
      continue;
    }
    rows.push(obj);
  }
  return rows;
}

/**
 * 补齐字段默认值（数据源脏，缺字段是常事）
 */
function normalizeRow(row) {
  return {
    ticket_id: row.ticket_id || 'TCK-UNKNOWN',
    order_ref: row.order_ref || '',
    customer_id: row.customer_id || '',
    customer_name: row.customer_name || '未知客户',
    id_number: row.id_number || '',
    tax_id: row.tax_id, // 注意：这里故意不兜底，历史行为就是这样
    currency: row.currency || 'CNY',
    amount: row.amount || 0,
    fx_rate: row.fx_rate, // 没汇率时留给后面兜底
    status: row.status || STATUS_INIT,
    bank_flag: row.bank_flag || 'OK',
    memo: row.memo || '',
  };
}

// ============================================================================
// 第五节：客户校验
// ============================================================================

/**
 * 校验客户税务信息。
 * 【业务规则（口口相传）】统一社会信用代码以 91 开头的是企业客户，
 * 以 92 开头是个体户，其他都算异常。
 * 返回 true 表示校验通过。
 */
function validateCustomer(row) {
  // 【v4 修复·地雷#4】税号先做空值防御：null / 非字符串 / 空串一律转人工补录，绝不崩溃
  const taxId = typeof row.tax_id === 'string' ? row.tax_id.trim() : '';
  if (!taxId) {
    logWarn('工单 ' + row.ticket_id + ' 税号缺失或为空，转人工补录清单');
    return false;
  }
  // 企业客户税号以 91 开头，个体户以 92 开头
  if (taxId.startsWith('91') || taxId.startsWith('92')) {
    return true;
  }
  // 其他情况视为税号异常
  logWarn('工单 ' + row.ticket_id + ' 税号异常: ' + maskTaxId(taxId));
  return false;
}

/**
 * 工单基础字段校验（金额、币种）
 */
function validateRow(row) {
  if (!row.ticket_id || row.ticket_id === 'TCK-UNKNOWN') {
    logError('工单缺 ticket_id，跳过');
    return false;
  }
  if (!row.amount || row.amount <= 0) {
    logError('工单 ' + row.ticket_id + ' 金额非法: ' + row.amount);
    return false;
  }
  const validCurrency = Object.keys(CURRENCY_SYMBOLS);
  if (validCurrency.indexOf(row.currency) === -1) {
    logError('工单 ' + row.ticket_id + ' 币种不支持: ' + row.currency);
    return false;
  }
  return true;
}

// ============================================================================
// 第六节：银行网关（真实环境对接的是银行专网，这里保留了当年的仿真桩）
// ============================================================================

/**
 * 仿真银行网关。
 * bank_flag 决定网关行为：
 *   OK    -> 一次成功
 *   HOLD  -> 银行处理中，扣一两次才成功（真实银行偶尔这样）
 *   STUCK -> 一直处理中（银行排队积压）
 * 返回格式：{ state, code, message, traceId }
 * 注意：真实网关的字段是 state/code/message，谁要是按 status 去读就永远读不到。
 */
function makeSimulatedGateway(bankFlag) {
  let chargeCalls = 0;
  let queryCalls = 0;
  return {
    get chargeCount() { return chargeCalls; },
    get queryCount() { return queryCalls; },
    charge(ticketId, amountCents) {
      chargeCalls++;
      if (bankFlag === 'OK') {
        return { state: 'SUCCESS', code: '00', message: '扣款成功', traceId: 'TRC-' + ticketId };
      }
      if (bankFlag === 'HOLD') {
        if (chargeCalls <= 2) {
          return { state: 'PENDING', code: '03', message: '银行处理中', traceId: 'TRC-' + ticketId };
        }
        return { state: 'SUCCESS', code: '00', message: '扣款成功', traceId: 'TRC-' + ticketId };
      }
      // STUCK：永远处理中
      return { state: 'PENDING', code: '03', message: '银行处理中', traceId: 'TRC-' + ticketId };
    },
    query(ticketId) {
      queryCalls++;
      // 【v4 补全】银行查询接口当年没开发完（永远返回 UNKNOWN），v4 补上：
      // 处理中的单子轮询即可确认（STUCK 积压单除外，持续处理中转人工）
      if (bankFlag === 'STUCK') {
        return { state: 'PENDING', code: '03', message: '银行处理中', traceId: 'TRC-' + ticketId };
      }
      return { state: 'SUCCESS', code: '00', message: '扣款成功', traceId: 'TRC-' + ticketId };
    },
  };
}

// ============================================================================
// 第七节：扣款执行（本脚本的"心脏"，也是事故高发区）
// ============================================================================

/**
 * 执行扣款。
 * 【v4 修复·地雷#2】单次扣款指令 + 幂等键；银行"处理中"只允许轮询状态确认，
 * 绝不允许重发扣款指令（重复扣款）；轮询设上限，超限停止转人工，杜绝死循环。
 * 返回 { settled, chargeCount, lastResult, idempotencyKey, pendingManualReview }
 */
const MAX_STATUS_POLLS = 5;

function executeDeduction(row, amountCents, gateway) {
  // 幂等键：同一工单同一天只可能是一笔扣款指令，银行侧可据此去重
  const idempotencyKey = row.ticket_id + ':' + dateStamp();
  const result = gateway.charge(row.ticket_id, amountCents, idempotencyKey);
  const chargeCount = 1;

  if (result.state === 'SUCCESS') {
    return { settled: true, chargeCount, lastResult: result, idempotencyKey, pendingManualReview: false };
  }

  if (result.state === 'PENDING') {
    // 银行处理中：只轮询，绝不重扣
    for (let i = 0; i < MAX_STATUS_POLLS; i++) {
      const status = gateway.query(row.ticket_id);
      if (status.state === 'SUCCESS') {
        return { settled: true, chargeCount, lastResult: status, idempotencyKey, pendingManualReview: false };
      }
    }
    logError('工单 ' + row.ticket_id + ' 银行持续处理中，已停止轮询并转人工跟进（幂等键 ' + idempotencyKey + '）');
    return { settled: false, chargeCount, lastResult: result, idempotencyKey, pendingManualReview: true };
  }

  // 其他失败码
  const meaning = BANK_CODE_MAP[result.code] || '未知错误';
  logError('工单 ' + row.ticket_id + ' 扣款失败: ' + meaning);
  return { settled: false, chargeCount, lastResult: result, idempotencyKey, pendingManualReview: false };
}

// ============================================================================
// 第八节：台账与报表
// ============================================================================

/**
 * 组装一行台账记录（CSV）
 */
function ledgerLine(row, amountCents, feeCents, needsApproval, status) {
  const origAmount = row.currency === 'CNY' ? row.amount : row.amount;
  return [
    row.ticket_id,
    row.customer_id,
    origAmount,
    row.currency,
    amountCents,
    feeCents,
    needsApproval ? 'YES' : 'NO',
    status,
  ].join(',');
}

/**
 * 把整批台账写成 CSV 报表
 */
function writeReport(rows, results, outDir) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const file = path.join(outDir, 'settlement_report_' + dateStamp() + '.csv');
  const lines = [REPORT_HEADER];
  for (let i = 0; i < rows.length; i++) {
    const r = results[rows[i].ticket_id];
    if (!r) continue;
    lines.push(ledgerLine(r.row, r.amountCents, r.feeCents, r.needsApproval, r.status));
  }
  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  logInfo('报表已写出: ' + file);
  return file;
}

/**
 * 汇总统计（给老板看的）
 */
function summarize(results) {
  let totalCents = 0;
  let totalFee = 0;
  let settledCount = 0;
  let failedCount = 0;
  let approvalCount = 0;
  let pendingCount = 0;
  let skippedCount = 0;
  const keys = Object.keys(results);
  for (let i = 0; i < keys.length; i++) {
    const r = results[keys[i]];
    if (r.status === STATUS_PENDING_APPROVAL) {
      pendingCount++;
    } else if (r.status === STATUS_SKIPPED_BAD_TAX_ID) {
      skippedCount++;
    } else if (r.status === STATUS_SETTLED || r.status === STATUS_CHARGED) {
      settledCount++;
      totalCents += r.amountCents;
      totalFee += r.feeCents;
    } else {
      failedCount++;
    }
    if (r.needsApproval) approvalCount++;
  }
  return { totalCents, totalFee, settledCount, failedCount, approvalCount, pendingCount, skippedCount };
}

// ============================================================================
// 第九节：单工单结算主流程
// ============================================================================

/**
 * 处理一张结算工单，走完：校验 -> 换汇 -> 审批标记 -> 扣款 -> 台账。
 * 返回该工单的结算结果对象。
 */
function processTicket(rawRow, gateway, results) {
  const row = normalizeRow(rawRow);
  logInfo('---- 开始处理工单 ' + row.ticket_id + ' ----');
  logInfo('结算客户 ' + row.customer_name + ' 证件号 ' + maskIdNumber(row.id_number) + ' 金额 ' + fmtAmount(row.amount, row.currency));

  // 1) 基础字段校验
  if (!validateRow(row)) {
    results[row.ticket_id] = { row, status: STATUS_FAILED, amountCents: 0, feeCents: 0, needsApproval: false, chargeCount: 0 };
    return results[row.ticket_id];
  }

  // 2) 客户税务校验（退款单跳过校验，老周说的）
  if (!isRefundTicket(row.memo)) {
    if (!validateCustomer(row)) {
      // 【v4 修复·地雷#4 配套】税号异常不再静默丢弃，转人工补录清单
      results[row.ticket_id] = { row, status: STATUS_SKIPPED_BAD_TAX_ID, amountCents: 0, feeCents: 0, needsApproval: false, chargeCount: 0 };
      return results[row.ticket_id];
    }
  }

  // 3) 金额换算成人民币分
  let amountCents;
  if (row.currency === 'CNY') {
    amountCents = yuanToCents(row.amount);
  } else {
    const rate = row.fx_rate || FALLBACK_USD_RATE;
    amountCents = convertToCNY(row.amount, rate);
  }
  logInfo('工单 ' + row.ticket_id + ' 换算后金额: ' + amountCents + ' 分');

  // 5) 手续费
  const feeCents = calcFee(amountCents, row.customer_id);

  // 4)【v4 修复·地雷#1 配套】FIN-001 强制人工审批门禁：
  //    单笔「超过」¥50,000 停止扣款、出审批单转具名审批人放行；
  //    AI 只起草、标记，放行永远归人，严禁任何形式的自动打款。
  const needsApproval = checkApproval(amountCents / 100);
  if (needsApproval) {
    const approvalNo = 'AP-' + dateStamp() + '-' + row.ticket_id;
    logWarn('工单 ' + row.ticket_id + ' 金额超 FIN-001 阈值（' + FIN001_APPROVAL_THRESHOLD + ' 元），已停止扣款，转具名审批人放行（审批单 ' + approvalNo + '）');
    results[row.ticket_id] = { row, status: STATUS_PENDING_APPROVAL, amountCents, feeCents, needsApproval: true, chargeCount: 0, approvalNo };
    logInfo('---- 工单 ' + row.ticket_id + ' 挂起待人工审批 ----');
    return results[row.ticket_id];
  }

  // 6) 扣款（单次指令 + 幂等键，"处理中"只轮询不重扣）
  const deduction = executeDeduction(row, amountCents, gateway);
  logInfo('工单 ' + row.ticket_id + ' 扣款指令发出次数: ' + deduction.chargeCount);

  // 7) 台账
  const finalStatus = deduction.settled ? STATUS_SETTLED : STATUS_FAILED;
  results[row.ticket_id] = {
    row,
    status: finalStatus,
    amountCents,
    feeCents,
    needsApproval,
    chargeCount: deduction.chargeCount,
  };
  logInfo('---- 工单 ' + row.ticket_id + ' 处理完毕，状态: ' + finalStatus + ' ----');
  return results[row.ticket_id];
}

// ============================================================================
// 第十节：整批入口
// ============================================================================

/**
 * 整批结算。
 * rows: 工单数组；gatewayFactory: 由 bank_flag 造网关的函数
 */
function runSettlement(rows, gatewayFactory) {
  const results = {};
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const gateway = gatewayFactory(row.bank_flag);
    try {
      processTicket(row, gateway, results);
    } catch (e) {
      // 兜个底别让整批崩掉（2022 年因为一行数据崩过整批，加了 try）
      logError('工单 ' + (row.ticket_id || '?') + ' 处理异常: ' + e.message);
      results[row.ticket_id || 'TCK-UNKNOWN-' + i] = {
        row,
        status: STATUS_FAILED,
        amountCents: 0,
        feeCents: 0,
        needsApproval: false,
        chargeCount: 0,
        error: e.message,
      };
    }
  }
  return results;
}

// ============================================================================
// 第十一节：命令行入口（main）
// ============================================================================

function parseArgs(argv) {
  let dataFile = null;
  let only = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--only=') === 0) {
      only = a.slice('--only='.length);
    } else if (!a.startsWith('--')) {
      dataFile = a;
    }
  }
  return { dataFile, only };
}

function main() {
  const { dataFile, only } = parseArgs(process.argv.slice(2));
  if (!dataFile) {
    console.error('用法: node settlement_batch_v3_FINAL_OK2_use_this_one.mjs <数据文件.jsonl> [--only=TCK-xxxx]');
    process.exit(1);
  }

  logInfo('========== 星辰集团财务结算批处理 启动 ==========');
  logInfo('数据文件: ' + dataFile + (only ? '（只处理 ' + only + '）' : ''));

  let rows = loadSettlementRows(dataFile);
  if (only) {
    rows = rows.filter((r) => r.ticket_id === only);
    if (rows.length === 0) {
      logError('没有找到工单 ' + only);
      process.exit(1);
    }
  }
  logInfo('本次待结算工单数: ' + rows.length);

  const results = runSettlement(rows, (bankFlag) => makeSimulatedGateway(bankFlag));

  const summary = summarize(results);
  logInfo('========== 结算汇总 ==========');
  logInfo('成功工单数: ' + summary.settledCount);
  logInfo('失败工单数: ' + summary.failedCount);
  logInfo('需人工审批工单数: ' + summary.approvalCount);
  logInfo('挂起待人工审批工单数: ' + summary.pendingCount);
  logInfo('转人工补录/跳过工单数: ' + summary.skippedCount);
  logInfo('结算总额: ' + summary.totalCents + ' 分');
  logInfo('手续费总额: ' + summary.totalFee + ' 分');
  logInfo('审计日志条数: ' + auditTrail.length);
}

// export 给测试/上层用（当年没有测试，这两个 export 是后来补的）
export {
  yuanToCents,
  convertToCNY,
  calcFee,
  checkApproval,
  isRefundTicket,
  isVip,
  fmtAmount,
  loadSettlementRows,
  normalizeRow,
  validateCustomer,
  validateRow,
  makeSimulatedGateway,
  executeDeduction,
  processTicket,
  runSettlement,
  summarize,
  auditTrail,
  FIN001_APPROVAL_THRESHOLD,
  maskIdNumber,
  maskTaxId,
  LEGACY_FEE_RATE,
  FALLBACK_USD_RATE,
};

// 直跑才进 main（被 import 时不执行）
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}

// ============================================================================
// 第十二节：尸体代码区（不敢删，万一哪天要用呢）
// ============================================================================

// // 2019 版 Excel 对账逻辑，被 v2 替代了，先留着
// function reconcileWithExcel(excelPath) {
//   const wb = xlsx.readFile(excelPath);
//   const ws = wb.Sheets['Sheet1'];
//   const rows = xlsx.utils.sheet_to_json(ws);
//   let diff = 0;
//   for (const r of rows) {
//     diff += Number(r.金额) - Number(r.台账金额);
//   }
//   return diff;
// }

// // 2020 年试过短信通知，没上线
// function sendSms(phone, content) {
//   // TODO: 短信通道采购流程没走完，先注释掉
//   console.log('SMS -> ' + phone + ': ' + content);
// }

// // 老周写的原始扣款逻辑（单次、无重试），被第七节的重试版替代
// function chargeOnceLegacy(row, amountCents, gateway) {
//   const result = gateway.charge(row.ticket_id, amountCents);
//   return result.state === 'SUCCESS';
// }

// // 汇率兜底的旧方案：按月查表，后来数据源没了
// const RATE_TABLE_2023 = {
//   '2023-01': 6.9102,
//   '2023-02': 6.9051,
//   '2023-03': 6.8912,
// };

// // 有人提议把日志写进文件，改了一半放弃了
// function appendAuditFile(msg) {
//   // const f = path.join(DEFAULT_LEDGER_DIR, AUDIT_LOG_PREFIX + dateStamp() + '.log');
//   // fs.appendFileSync(f, msg + '\n');
// }

// // 假装的单元测试（当年写的"测试"，其实只是打印）
// function selfTest() {
//   console.log('yuanToCents(1) =', yuanToCents(1));
//   console.log('yuanToCents(0.1) =', yuanToCents(0.1));
//   console.log('looks fine ✓');
// }

// ============================================================================
// 附录 A：历史事故回忆录（2019~2024，凭老员工记忆整理，无正式事故报告）
// ----------------------------------------------------------------------------
// 【事故-01】2020-04  某客户重复扣款 2 笔，客服收到投诉后手动退了 1 笔。
//            当时的结论："银行网关抖动，正常现象，后续观察。"
//            后续观察了四年，没有下文。
//
// 【事故-02】2021-09  一张外币工单的人民币金额和银行流水差了 1 分钱，
//            财务月底对账差 8 分钱对不平，最后手工调账。
//            当时的结论："汇率每天在变，有误差正常。"
//
// 【事故-03】2022-06  数据源里一行 JSON 少了个引号，整批结算卡死，
//            财务等到晚上 9 点，第二天加了 try/catch（就是现在的兜底）。
//
// 【事故-04】2022-11  某新客户工单没有税号，处理时直接报错，
//            该工单被静默跳过，客户两个月后才发现没收到结算款。
//            当时的结论："数据质量问题是业务部门的锅。"
//
// 【事故-05】2023-05  客服转发来的截图显示，结算日志里能看到客户身份证号，
//            合规口头提醒过一次，说"内部系统没事"。后来没有然后了。
//
// 【事故-06】2024-02  大客户结算金额 5.2 万，财务说按规定要审批，
//            但系统报表里标的是"不需审批"，两边扯了三天皮。
//            当时的结论："金额没到 10 万，不用审。"（依据是哪年的制度，没人说得清）
//
// 【事故-07】2024-03  有工单卡在"银行处理中"一直重试扣款，疑似扣了 5 次，
//            后来银行说是同一笔原路退回了 4 笔，"没造成实际损失，运气好"。
// ============================================================================

// ============================================================================
// 附录 B：新同事 FAQ（口口相传版，可信度自行判断）
// ----------------------------------------------------------------------------
// Q: 阈值那行为什么是 10 万？
// A: 一直就是这样。据说是 2025 年之前的老制度定的，后来制度改没改不知道，
//    反正没人来改这行代码，那就说明不用改。（危险假设，勿学）
//
// Q: 为什么扣款要用 while 重试？
// A: 老周说银行第一次经常不生效。重试的每一笔会不会真的扣钱？
//    老周说不会，"银行有幂等"。但我们没传幂等号，银行怎么幂等？
//
// Q: 为什么金额要 parseInt？
// A: 当年用 Math.round 和 Excel 对不上（其实是 Excel 那边格式问题），
//    一怒之下就 parseInt 了，差的那几分钱月底手工调。
//
// Q: 为什么日志要打身份证号？
// A: 排查方便。合规说要脱敏，但脚本三年没人敢动，就这样吧。
//
// Q: 这个脚本有文档吗？
// A: 你现在看到的注释就是全部文档。祝好运。
// ============================================================================

// ============================================================================
// 附录 C：尸体代码区·续（每次想清理都被"万一要用"劝退）
// ============================================================================

// // 2020 年想过加邮件通知，采购流程没走完
// function sendEmail(to, subject, body) {
//   // TODO: SMTP 账号申请中（2020-07 提交的申请）
// }

// // 2021 年做过的汇率缓存，后来数据源挂了就注释了
// const rateCache = {};
// function getCachedRate(currency, date) {
//   const key = currency + ':' + date;
//   if (rateCache[key]) return rateCache[key];
//   // const rate = fetchRateFromBank(currency, date);  // 银行接口 2022 年下线
//   // rateCache[key] = rate;
//   // return rate;
//   return null;
// }

// // 2022 年试过的并发结算（用 setTimeout 模拟），改出过死锁，回滚了
// function settleInParallel(rows, concurrency) {
//   let idx = 0;
//   let active = 0;
//   function next() {
//     while (active < concurrency && idx < rows.length) {
//       active++;
//       const row = rows[idx++];
//       processTicket(row, null, {});
//       active--;
//       next();
//     }
//   }
//   next();
// }

// // 2023 年想加的签名校验，防止台账文件被改，做了一半
// function signLedger(line, secret) {
//   // const crypto = require('crypto');
//   // return crypto.createHmac('sha256', secret).update(line).digest('hex');
//   return '';
// }

// // 2023 年写了一半的"脱敏"函数（写了就没人调用，形同虚设）
// function maskIdMaybe(idNumber) {
//   // TODO(小吴): 下个迭代接入合规要求
//   return idNumber;
// }

// // 2024 年准备重构的分支版本，重构到一半人跑了
// function processTicketV4(rawRow, gateway, results) {
//   // const row = normalizeRow(rawRow);
//   // const ctx = { row, gateway, results };
//   // await validate(ctx);
//   // await convert(ctx);
//   // await charge(ctx);
//   // await ledger(ctx);
//   throw new Error('V4 重构未完成，勿用');
// }

