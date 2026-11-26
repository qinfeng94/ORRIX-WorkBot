// ============================================================================
// Day10 棕地演练：遗留结算脚本回归测试
// 框架：Node 22 内置 test runner，零第三方依赖
// 设计原则：每颗地雷一条"必然失败"的回归测试（先红后绿），
//           另设基线用例（重构前后都必须绿）证明零回归。
// 运行：node --test scripts/day10-brownfield-lab/legacy-settlement.test.mjs
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  yuanToCents,
  convertToCNY,
  checkApproval,
  loadSettlementRows,
  executeDeduction,
  processTicket,
  auditTrail,
} from './legacy-settlement.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(here, 'data', 'settlements_dirty.jsonl');

/** 现行 FIN-001 红线：单笔金额「超过」50000 才触发（等于不触发） */
const FIN001_THRESHOLD = 50000;

/**
 * 仿真银行网关测试桩。
 * HOLD : 前 2 次扣款返回 PENDING，之后 SUCCESS（模拟银行抖动）
 * STUCK: 永远 PENDING（模拟银行积压，专钓死循环）
 * 守卫：任何函数被调用超过 50 次 → 引爆，防止测试 runner 被真死循环拖死
 */
function makeStubGateway(mode) {
  let chargeCalls = 0;
  let queryCalls = 0;
  let totalCalls = 0;
  function guard() {
    totalCalls++;
    if (totalCalls > 50) {
      throw new Error('GUARD_TRIGGERED: 网关调用超过 50 次，疑似死循环失控');
    }
  }
  return {
    get chargeCount() { return chargeCalls; },
    get queryCount() { return queryCalls; },
    charge(ticketId, amountCents) {
      guard();
      chargeCalls++;
      if (mode === 'HOLD' && chargeCalls <= 2) {
        return { state: 'PENDING', code: '03', message: '银行处理中', traceId: 'TRC-' + ticketId };
      }
      if (mode === 'STUCK') {
        return { state: 'PENDING', code: '03', message: '银行处理中', traceId: 'TRC-' + ticketId };
      }
      return { state: 'SUCCESS', code: '00', message: '扣款成功', traceId: 'TRC-' + ticketId };
    },
    query(ticketId) {
      guard();
      queryCalls++;
      // 轮询查询：STUCK 永远 PENDING；HOLD/OK 一次就确认成功
      if (mode === 'STUCK') {
        return { state: 'PENDING', code: '03', message: '银行处理中', traceId: 'TRC-' + ticketId };
      }
      return { state: 'SUCCESS', code: '00', message: '扣款成功', traceId: 'TRC-' + ticketId };
    },
  };
}

function buildRow(overrides = {}) {
  return {
    ticket_id: 'TCK-T-0001',
    order_ref: 'ORD-T-0001',
    customer_id: 'CUST-9999',
    customer_name: '测试客户',
    id_number: '330104199003072218', // 虚构证件号（用于脱敏断言）
    tax_id: '91330106MA27XW1234',
    currency: 'CNY',
    amount: 12000,
    fx_rate: 1,
    status: 'SETTLED',
    bank_flag: 'OK',
    memo: '回归测试工单',
    ...overrides,
  };
}

function clearAuditTrail() {
  auditTrail.length = 0;
}

// ============================================================================
// 基线用例：重构前后都必须绿（证明"零回归"，正常业务行为没被改坏）
// ============================================================================

test('基线-01 整数人民币金额换算成分保持精确', () => {
  assert.equal(yuanToCents(12000), 1200000);
  assert.equal(yuanToCents(50000), 5000000);
});

test('基线-02 无小数尾差的外币换算金额不变（$88 × 7.2491）', () => {
  // 88 * 7.2491 = 637.9208 → 63792 分，不受截断/四舍五入策略影响
  assert.equal(convertToCNY(88, 7.2491), 63792);
});

test('基线-03 普通金额不触发人工审批 + 工单清单完整加载 14 行', () => {
  assert.equal(checkApproval(12000), false);
  assert.equal(checkApproval(FIN001_THRESHOLD - 1), false);
  const rows = loadSettlementRows(DATA_FILE);
  assert.equal(rows.length, 14);
});

// ============================================================================
// 地雷回归测试：5 条，针对遗留代码必然失败（先红），修复后必须全绿
// ============================================================================

test('地雷#1 [FIN-001阈值] ¥52800/¥50001 必须触发人工审批，¥50000 整不触发', () => {
  // 红线口径：单笔「超过」50000 触发，等于 50000 不触发
  assert.equal(checkApproval(52800), true, '¥52,800 超 5 万必须触发 FIN-001 人工审批');
  assert.equal(checkApproval(50001), true, '¥50,001 超 5 万必须触发 FIN-001 人工审批');
  assert.equal(checkApproval(50000), false, '恰好等于 50,000 不触发（「超过」才触发）');
});

test('地雷#2 [重复扣款/死循环] 银行 HOLD 只允许扣款 1 次；STUCK 必须有限步安全终止', () => {
  // 场景 A：银行抖动（前两次返回"处理中"）→ 绝不允许重发扣款指令
  const gwHold = makeStubGateway('HOLD');
  const rowA = buildRow({ ticket_id: 'TCK-T-HOLD' });
  const rA = executeDeduction(rowA, 1200000, gwHold);
  assert.equal(gwHold.chargeCount, 1, '银行"处理中"只能轮询确认，绝不能重发扣款（重复扣款）');
  assert.equal(rA.settled, true, 'HOLD 场景最终应确认扣款成功');

  // 场景 B：银行一直"处理中"→ 必须在有限步骤内终止并转人工，不得死循环
  const gwStuck = makeStubGateway('STUCK');
  const rowB = buildRow({ ticket_id: 'TCK-T-STUCK' });
  const rB = executeDeduction(rowB, 108736, gwStuck); // 超过 50 次调用测试桩会引爆 GUARD_TRIGGERED
  assert.equal(gwStuck.chargeCount, 1, 'STUCK 场景同样只允许 1 次扣款指令');
  assert.equal(rB.settled, false, '银行一直未确认时不得标记扣款成功');
});

test('地雷#3 [浮点丢分] 外币换算必须四舍五入到分，不得截断丢分', () => {
  // 680 * 7.2491 = 4929.388 元 = 492938.8 分 → 四舍五入应为 492939 分
  // 遗留代码 parseInt 截断成 492938 分，系统性丢 1 分
  assert.equal(convertToCNY(680, 7.2491), 492939, '$680×7.2491 应为 492939 分');
  // 150 * 7.2491 = 1087.365 元 = 108736.5 分 → 四舍五入应为 108737 分
  assert.equal(convertToCNY(150, 7.2491), 108737, '$150×7.2491 应为 108737 分');
});

test('地雷#4 [空税号崩溃] tax_id 为 null 不得崩溃，不得扣款，须转人工清单', () => {
  const gw = makeStubGateway('OK');
  const row = buildRow({ ticket_id: 'TCK-T-NOTAX', tax_id: null, amount: 8600 });
  const results = {};
  const r = processTicket(row, gw, results); // 遗留代码在此抛 TypeError
  assert.doesNotThrow(() => { /* 上面未抛出即通过 */ }, '空税号不得崩溃');
  assert.equal(gw.chargeCount, 0, '税号异常的工单绝不允许扣款');
  assert.notEqual(r.status, 'SETTLED', '税号异常工单不得标记为已结算');
});

test('地雷#5 [PII脱敏] 任何日志行不得出现 15 位以上连续数字（证件号必须掩码）', () => {
  clearAuditTrail();
  const gw = makeStubGateway('OK');
  const row = buildRow({ ticket_id: 'TCK-T-PII' });
  processTicket(row, gw, {});
  assert.ok(auditTrail.length > 0, '应产生审计日志');
  for (const line of auditTrail) {
    assert.doesNotMatch(line, /\d{15,}/, '日志出现未脱敏的长数字（疑似明文证件号）: ' + line);
  }
  assert.ok(
    auditTrail.some((l) => l.includes('****')),
    '日志应包含掩码形态的证件号（如 3301****2218）'
  );
});
