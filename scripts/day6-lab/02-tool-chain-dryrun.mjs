#!/usr/bin/env node
/**
 * 02-tool-chain-dryrun.mjs — Day 6 工具链预演台（零第三方依赖，纯 Node 内置模块）
 *
 * 红线落地（承接 AGENTS.md + .fde/04-access-boundary.md）：
 * - 绿区只读、黄区 AI 起草 + 人类确认、红区物理剔除（不是提示词劝阻）；
 * - 黄区写操作在后端代码层强制锁死 dryRun: true，绝不变更数据，只产出
 *   「修改前后 Diff 草稿卡片 + 审批单号」，放行永远归具名审批人；
 * - 注册表自检：任何含「打款/付款/放款」等语义的工具名/描述直接拒绝注册；
 * - 多步工具循环 maxSteps = 6 防死循环上限（超过即熔断，审计留痕）；
 * - /research 调研模式：强制先查证据，结论后校验 [DOC-XX §X.X] 引文格式与出处。
 *
 * 用法：
 *   node scripts/day6-lab/02-tool-chain-dryrun.mjs            # 完整演示（CUST-8842 案例）
 *   node scripts/day6-lab/02-tool-chain-dryrun.mjs --selftest # 只跑护栏自检
 */

/* ================================================================
 * 一、模拟数据（只读快照风格，虚构演示内容，客户姓名已脱敏）
 * ================================================================ */

/** 每日定时只读快照：工单库（模拟，严禁直写） */
const TICKETS_SNAPSHOT = [
  {
    ticketId: 'TCK-3117',
    customerId: 'CUST-8842',
    customerName: '张*',
    tier: 'VIP',
    title: '重复扣款申诉',
    amountCny: 52800,
    detail: '11 月 24 日对公账户被重复扣款两笔，每笔 ¥26,400，合计 ¥52,800',
    status: 'open',
    createdAt: '2026-11-24T10:32:00+08:00',
  },
];

/** CRM 客户档案（模拟写操作对象；dryRun 下永远不会被真正修改） */
const CRM_PROFILE_STORE = {
  'CUST-8842': {
    customerId: 'CUST-8842',
    customerName: '张*',
    tier: 'VIP',
    riskFlag: 'normal',
    fin001Flag: false,
    pendingApprovalId: null,
  },
};

/** 集团制度文档库（search_enterprise_policy 的证据来源） */
const POLICY_DOCS = [
  {
    docId: 'DOC-01',
    section: '4.2',
    title: '财务付款审批制度（FIN-001）',
    snippet: '单笔金额超过 ¥50,000 的付款/退款，必须由具名在职审批人签字放行；AI 不得充当审批人。',
  },
  {
    docId: 'DOC-02',
    section: '3.1',
    title: '重复扣款客诉处理流程',
    snippet: '确认重复扣款后，由人工复核原始支付流水，退款一律走既有正规通道，先挂「疑似错账」标记。',
  },
  {
    docId: 'DOC-03',
    section: '2.4',
    title: 'VIP 客户异常升级规范',
    snippet: 'VIP 客户涉及金额超过 ¥50,000 的异常，须 24 小时内预约财务复核会议并同步客户经理。',
  },
];

/* ================================================================
 * 二、工具注册表（物理边界：红区工具根本不存在于这里）
 * ================================================================ */

/** 红区黑名单语义：命中任何一个词的工具一律拒绝注册（物理剔除自检） */
const RED_ZONE_BANNED_WORDS = ['打款', '付款', '放款', '转账', '退款执行', 'payout', 'auto_pay', 'disburse'];

const TOOL_REGISTRY = {
  search_enterprise_policy: {
    zone: 'green',
    label: '查询集团制度文档（只读）',
    run({ keywords }) {
      const kw = String(keywords ?? '');
      const hits = POLICY_DOCS.filter((d) => `${d.title}${d.snippet}`.includes(kw) || kw === '');
      return { evidence: hits.map((d) => ({ ...d })) }; // 返回副本，只读
    },
  },
  query_postgres_tickets: {
    zone: 'green',
    label: '查询工单只读快照（只读）',
    run({ customerId }) {
      return { tickets: TICKETS_SNAPSHOT.filter((t) => !customerId || t.customerId === customerId).map((t) => ({ ...t })) };
    },
  },
  update_crm_profile: {
    zone: 'yellow',
    write: true,
    label: '更新 CRM 客户档案（黄区写操作，强制预演）',
    /**
     * @param {{customerId: string, patch: Record<string, unknown>}} args
     */
    run({ customerId, patch }) {
      const before = CRM_PROFILE_STORE[customerId];
      if (!before) throw new Error(`CRM 中不存在客户 ${customerId}`);
      return { before: { ...before }, after: { ...before, ...patch } }; // 只算 diff，不落库
    },
  },
  schedule_review_meeting: {
    zone: 'yellow',
    write: true,
    label: '预约人工复核会议（黄区写操作，强制预演）',
    run({ topic, attendees }) {
      return { draft: { topic, attendees, proposedSlot: '24 小时内（等待王主管确认）' } }; // 只出草稿，不建日程
    },
  },
};

/** 审批单号序列（黄区 Diff 草稿卡片必须挂单号，等具名审批人签字） */
let approvalSeq = 0;
function nextApprovalId() {
  approvalSeq += 1;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `AP-${today}-${String(approvalSeq).padStart(3, '0')}`;
}

/**
 * 注册表自检：扫描工具名 + 描述，命中红区语义立即抛错（启动即熔断，不是提醒）
 */
function auditRegistry() {
  for (const [name, tool] of Object.entries(TOOL_REGISTRY)) {
    const text = `${name} ${tool.label}`.toLowerCase();
    for (const word of RED_ZONE_BANNED_WORDS) {
      if (text.includes(word.toLowerCase())) {
        throw new Error(`红区自检失败：工具「${name}」命中禁用语义「${word}」，拒绝注册`);
      }
    }
  }
  const names = Object.keys(TOOL_REGISTRY);
  if (names.length !== 4) {
    throw new Error(`注册表数量异常：期望 4 把工具，实际 ${names.length} 把`);
  }
  return names;
}

/* ================================================================
 * 三、执行层：分区校验 + 黄区 dryRun 强制锁死
 * ================================================================ */

const rl = undefined;
void rl;

/** 审计留痕（控制台版，带时间戳；正式环境写入只增不改的日志通道） */
function audit(line) {
  console.log(`  [审计 ${new Date().toISOString()}] ${line}`);
}

let auditCallSeq = 0;

/**
 * 统一工具调用入口（唯一通道，越区调用在这里被物理拦截）
 * @param {keyof typeof TOOL_REGISTRY} toolName
 * @param {Record<string, unknown>} args
 */
function callTool(toolName, args = {}) {
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) {
    // 红区工具在这里表现为「不存在」，而非「被禁止」
    throw new Error(`工具「${toolName}」不存在于注册表（若为打款/付款类，属物理剔除）`);
  }
  auditCallSeq += 1;

  if (tool.zone === 'yellow' && tool.write) {
    // —— 黄区强制锁死：无论调用方传什么 dryRun，一律改写为 true ——
    const requestedDryRun = args.dryRun;
    args = { ...args, dryRun: true };
    const result = tool.run(args);
    const approvalId = nextApprovalId();
    audit(`#${auditCallSeq} 黄区写操作 ${toolName} → 强制 dryRun=true` +
      (requestedDryRun === false ? `（调用方曾请求 dryRun=false，已被执行层覆盖，未落库）` : '（预演模式，未落库）'));
    return { zone: 'yellow', toolName, approvalId, ...result, appliedToStore: false };
  }

  // 绿区只读
  const result = tool.run(args);
  audit(`#${auditCallSeq} 绿区只读 ${toolName} → 返回只读结果`);
  return { zone: 'green', toolName, ...result };
}

/* ================================================================
 * 四、黄区 Diff 草稿卡片渲染（AI 起草 → 等人类确认）
 * ================================================================ */

function printDiffCard({ approvalId, toolName, before, after }) {
  const changedKeys = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  console.log(`\n  ┌─ 📝 黄区 Diff 草稿卡片 · ${toolName} · 审批单号 ${approvalId} ─┐`);
  for (const key of changedKeys) {
    console.log(`  │ 字段: ${key}`);
    console.log(`  │   修改前: ${JSON.stringify(before[key])}`);
    console.log(`  │   修改后: ${JSON.stringify(after[key])}`);
  }
  console.log(`  │ 状态: 草稿未落库（appliedToStore=false），等待具名审批人签字`);
  console.log(`  └──────────────────────────────────────────────────┘`);
}

function printMeetingDraft({ approvalId, toolName, draft }) {
  console.log(`\n  ┌─ 📝 黄区草稿卡片 · ${toolName} · 审批单号 ${approvalId} ─┐`);
  console.log(`  │ 会议主题: ${draft.topic}`);
  console.log(`  │ 参会人  : ${draft.attendees}`);
  console.log(`  │ 建议时段: ${draft.proposedSlot}`);
  console.log(`  │ 状态: 草稿未创建日程，等待具名审批人确认`);
  console.log(`  └──────────────────────────────────────────────────┘`);
}

/* ================================================================
 * 五、Agent 循环：maxSteps = 6 防死循环熔断
 * ================================================================ */

const MAX_STEPS = 6;

/**
 * @param {Array<() => {label: string, exec: () => void}>} stepPlan
 */
function runAgentLoop(stepPlan, { title }) {
  console.log(`\n────── ${title} ──────`);
  for (let step = 1; step <= stepPlan.length; step++) {
    if (step > MAX_STEPS) {
      console.log(`\n  🛑 熔断：步骤数超过 maxSteps=${MAX_STEPS}，自动终止本轮循环（防死循环护栏触发，审计已留痕）`);
      return false;
    }
    const current = stepPlan[step - 1];
    console.log(`\n▶ 步骤 ${step}/${MAX_STEPS}：${current.label}`);
    current.exec();
  }
  return true;
}

/* ================================================================
 * 六、/research 调研模式：证据优先 + [DOC-XX §X.X] 引文校验
 * ================================================================ */

// 全局版用于 match 提取；单条格式校验必须用非全局版（全局正则的 lastIndex 状态会让 .test() 间歇性误判）
const CITATION_RE = /\[DOC-\d{2}\s§\d+\.\d+\]/g;
const CITATION_FMT_RE = /^\[DOC-\d{2}\s§\d+\.\d+\]$/;

/** @param {Array<{docId: string, section: string}>} evidence */
function evidenceKeySet(evidence) {
  return new Set(evidence.map((d) => `${d.docId} §${d.section}`));
}

/**
 * 校验结论文本：引文格式合法 + 每条引文都能在证据集中找到出处
 * @param {string} conclusion
 * @param {Array<{docId: string, section: string}>} evidence
 * @param {boolean} hadEvidenceCall
 */
function validateCitations(conclusion, evidence, hadEvidenceCall) {
  /** @type {string[]} */
  const problems = [];
  if (!hadEvidenceCall) {
    problems.push('未先查询证据就输出结论，违反 /research 证据优先原则');
  }
  const cited = conclusion.match(CITATION_RE) ?? [];
  if (cited.length === 0) {
    problems.push('结论中未发现任何 [DOC-XX §X.X] 格式引文');
  }
  const keys = evidenceKeySet(evidence);
  for (const c of cited) {
    const normalized = c.replace(/\s+/, ' ');
    if (!keys.has(normalized.replace(/[[\]]/g, ''))) {
      problems.push(`引文 ${c} 在证据集中不存在出处（防编造校验失败）`);
    }
  }
  // 双重格式校验：引文必须严格匹配「编号 + 空格 + §章节」，防止 [DOC-01§4.2] 这类缺空格写法混入
  const loose = conclusion.match(/\[DOC-\d{2}[^\]]*\]/g) ?? [];
  for (const l of loose) {
    if (!CITATION_FMT_RE.test(l)) {
      problems.push(`引文 ${l} 格式不合规（应为 [DOC-XX §X.X]，编号与 § 之间留一个空格）`);
    }
  }
  return { ok: problems.length === 0, problems, citedCount: cited.length };
}

/* ================================================================
 * 七、演示主流程：VIP 客户 CUST-8842 重复扣款 ¥52,800
 * ================================================================ */

function banner(text) {
  console.log('═'.repeat(64));
  console.log(`  ${text}`);
  console.log('═'.repeat(64));
}

function runMainDemo() {
  banner('Day 6 · 工具链预演台（三区权限红线 · 零第三方依赖）');

  console.log('\n【注册表自检】');
  const names = auditRegistry();
  console.log(`  已注册 ${names.length} 把工具：`);
  for (const name of names) {
    const t = TOOL_REGISTRY[name];
    const zoneBadge = t.zone === 'green' ? '🟢 绿区只读' : '🟡 黄区写·强制预演';
    console.log(`    - ${name}（${zoneBadge}）`);
  }
  console.log('    - （打款/付款/放款类工具：不存在于注册表，红区物理剔除）');

  /** /research 模式收集的证据（证据优先原则：先查证据，后下结论） */
  /** @type {Array<{docId: string, section: string}>} */
  const collectedEvidence = [];
  let hadEvidenceCall = false;

  // —— 步骤计划（每一幕都体现红线）——
  const stepPlan = [
    {
      label: '查询工单只读快照（绿区 G1）',
      exec() {
        const r = callTool('query_postgres_tickets', { customerId: 'CUST-8842' });
        for (const t of r.tickets) {
          console.log(`  工单 ${t.ticketId}｜${t.customerId}（${t.tier}，${t.customerName}）｜${t.title}`);
          console.log(`  金额 ¥${t.amountCny.toLocaleString()}｜${t.detail}`);
          console.log(`  状态 ${t.status}｜创建于 ${t.createdAt}`);
          if (t.amountCny > 50000) {
            console.log(`  ⚠️ 金额 ¥${t.amountCny.toLocaleString()} > ¥50,000，触发 FIN-001 强制人工审批红线`);
          }
        }
      },
    },
    {
      label: '查询集团制度文档（绿区 G2·/research 证据查询）',
      exec() {
        hadEvidenceCall = true;
        const r = callTool('search_enterprise_policy', { keywords: '' });
        collectedEvidence.push(...r.evidence);
        for (const d of r.evidence) {
          console.log(`  证据 ${d.docId} §${d.section}《${d.title}》：${d.snippet}`);
        }
      },
    },
    {
      label: '尝试直接落库 CRM 标记（黄区·演示强制锁死：请求 dryRun=false）',
      exec() {
        // 调用方故意请求 dryRun=false，展示执行层如何物理覆盖（绝不直接改库）
        const r = callTool('update_crm_profile', {
          customerId: 'CUST-8842',
          dryRun: false, // ← 恶意/失误请求，将被强制改写为 true
          patch: {
            riskFlag: 'duplicate_charge_suspected',
            fin001Flag: true,
          },
        });
        printDiffCard({ approvalId: r.approvalId, toolName: r.toolName, before: r.before, after: r.after });
        console.log(`  另见：工单 ${TICKETS_SNAPSHOT[0].ticketId} 标记为「疑似错账」待财务复核（只标记，不下结论）`);
      },
    },
    {
      label: '起草预约人工复核会议（黄区 Y3·强制预演）',
      exec() {
        const r = callTool('schedule_review_meeting', {
          topic: 'CUST-8842 重复扣款 ¥52,800 复核（FIN-001 强制人工审批）',
          attendees: '王主管（一线确认人）、具名财务复核人、客户经理',
        });
        printMeetingDraft({ approvalId: r.approvalId, toolName: r.toolName, draft: r.draft });
      },
    },
    {
      label: '输出调研结论（/research 引文校验）',
      exec() {
        const conclusion =
          '经查证：工单 TCK-3117 显示 VIP 客户张*于 11 月 24 日被重复扣款合计 ¥52,800，超过 FIN-001 红线，' +
          '必须由具名在职审批人签字放行，AI 不审批、不打款 [DOC-01 §4.2]。' +
          '已按流程将 CRM 档案标记为疑似错账并生成 Diff 草稿（审批单号见上方卡片），退款走既有正规通道 [DOC-02 §3.1]；' +
          'VIP 超额异常须 24 小时内预约财务复核会议（草稿已出，待王主管确认）[DOC-03 §2.4]。';

        console.log('\n  AI 调研结论（草稿）：');
        console.log(`  ${conclusion}`);

        const check = validateCitations(conclusion, collectedEvidence, hadEvidenceCall);
        console.log('\n  引文校验（[DOC-XX §X.X] 格式 + 出处核对）：');
        if (check.ok) {
          console.log(`  ✅ 校验通过：共 ${check.citedCount} 条引文，格式合规且全部能在证据集中找到出处（防编造）`);
        } else {
          for (const p of check.problems) console.log(`  ❌ ${p}`);
          console.log('  ⛔ /research 模式：校验不通过，结论不得发布，仅作资料上报');
        }
      },
    },
    {
      label: '验证数据未被直写（红区自证）',
      exec() {
        const profile = CRM_PROFILE_STORE['CUST-8842'];
        const untouched = profile.riskFlag === 'normal' && profile.fin001Flag === false && profile.pendingApprovalId === null;
        console.log(`  CRM 档案实际状态: riskFlag=${profile.riskFlag}, fin001Flag=${profile.fin001Flag}`);
        console.log(untouched
          ? '  ✅ 红区自证通过：全程只产出了 Diff 草稿，正式数据零改动（写能力物理隔离，不是劝阻）'
          : '  ❌ 异常：正式数据被改动，红线被击穿！');
      },
    },
  ];

  runAgentLoop(stepPlan, { title: '正式演示 · VIP 客户 CUST-8842 重复扣款 ¥52,800' });
}

/* ================================================================
 * 八、护栏自检（防死循环熔断 + 引文校验负样本）
 * ================================================================ */

function runSelfTests() {
  banner('护栏自检（负样本必须全部被拦下才算合格）');

  console.log('\n【自检 1】无限循环熔断（maxSteps=6）');
  const runawayPlan = Array.from({ length: 20 }, (_, i) => ({
    label: `无限任务第 ${i + 1} 步`,
    exec() {
      const r = callTool('query_postgres_tickets', {});
      void r;
    },
  }));
  const halted = !runAgentLoop(runawayPlan, { title: '无限循环仿真' });
  console.log(halted && auditCallSeq >= MAX_STEPS
    ? `\n  ✅ 熔断生效：循环在第 ${MAX_STEPS} 步被强制终止，未跑满 20 步`
    : `\n  ❌ 熔断未生效`);

  console.log('\n【自检 2】调用不存在的红区工具（auto_transfer_payment）');
  try {
    callTool('auto_transfer_payment', { amountCny: 100 });
    console.log('  ❌ 异常：红区工具竟能调用！');
  } catch (err) {
    console.log(`  ✅ 已拦截：${/** @type {Error} */ (err).message}`);
  }

  console.log('\n【自检 3】注册含打款语义的工具（物理剔除自检）');
  try {
    // 模拟有人往注册表里塞了一把打款工具，随后重跑注册表自检
    Object.defineProperty(TOOL_REGISTRY, 'batch_auto_payout', {
      value: { zone: 'yellow', write: true, label: '批量自动打款', run: () => ({}) },
      enumerable: true, // 可枚举，确保 auditRegistry 的 Object.entries 能扫到
      configurable: true,
    });
    auditRegistry();
    console.log('  ❌ 异常：禁用语义工具未被发现');
  } catch (err) {
    delete TOOL_REGISTRY['batch_auto_payout'];
    console.log(`  ✅ 已拦截：${/** @type {Error} */ (err).message}`);
  }

  console.log('\n【自检 4】引文校验负样本（缺引文 / 引文无出处 / 格式错误）');
  const negative = validateCitations('我认为应该直接退款，无需审批。', [], false);
  console.log(`  负样本 A（无证据、无引文）→ ${negative.ok ? '❌ 漏拦' : '✅ 被拦下'}：${negative.problems.join('；')}`);

  const negativeB = validateCitations('结论：退款放行 [DOC-09 §9.9]。', POLICY_DOCS, true);
  console.log(`  负样本 B（引文无出处）→ ${negativeB.ok ? '❌ 漏拦' : '✅ 被拦下'}：${negativeB.problems.join('；')}`);

  const negativeC = validateCitations('结论：依 [DOC-01§4.2] 退款。', POLICY_DOCS, true);
  console.log(`  负样本 C（缺空格格式）→ ${negativeC.ok ? '❌ 漏拦' : '✅ 被拦下'}：${negativeC.problems.join('；')}`);

  console.log('\n【自检 5】黄区 dryRun 锁死（请求 dryRun=false 也绝不落库）');
  const r = callTool('update_crm_profile', { customerId: 'CUST-8842', dryRun: false, patch: { tier: 'normal' } });
  const stillVip = CRM_PROFILE_STORE['CUST-8842'].tier === 'VIP';
  console.log(`  返回 appliedToStore=${r.appliedToStore}，实际档案 tier=${CRM_PROFILE_STORE['CUST-8842'].tier} → ${stillVip && !r.appliedToStore ? '✅ 未落库，锁死生效' : '❌ 数据被改动！'}`);
}

/* ================================================================
 * 入口
 * ================================================================ */

const onlySelfTest = process.argv.includes('--selftest');
if (onlySelfTest) {
  runSelfTests();
} else {
  runMainDemo();
  console.log('\n' + '═'.repeat(64));
  console.log('  提示：node scripts/day6-lab/02-tool-chain-dryrun.mjs --selftest 可单独跑护栏自检');
  console.log('═'.repeat(64));
}
