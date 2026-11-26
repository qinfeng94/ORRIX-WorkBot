/**
 * channels-signing.test.ts —— Day 32 4 渠道网关验签单元测试（Node 内置 test runner，零第三方依赖）
 * 运行：pnpm test（与既有测试同链路）
 * 覆盖：邮件 / H5 通道与 Web、企微飞书通道的验签一致性基线（同一三关：时间窗 / HMAC 恒时比较 /
 *      nonce 防重放）、邮件与 H5 专项（正文与设备标识完整性、跨通道密钥隔离、防重放、
 *      生产密钥接管）以及验签之后的通道混淆防御。
 * 边界：全部为确定性纯函数（node:crypto），测试不联网、不读库、不写业务数据；
 *      环境变量接管用例在 finally 中复位，nonce 用一次性递增串隔离，绝不污染其他测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildChannelMetaList,
  channelSecretEnvName,
  hmacHex,
  resolveChannelSecret,
  signatureBaseString,
  verifyWebhookSignature,
} from "../src/lib/channels/signing.ts";
import { normalizeEnvelope } from "../src/lib/channels/adapters.ts";
import { CHANNEL_IDS, type ChannelId } from "../src/lib/channels/types.ts";

/* ================================================================
 * 测试工具：一次性 nonce 计数器 + 按通道签名构造器（与网关字节口径一致）
 * ================================================================ */

let nonceSeq = 0;
function freshNonce(label: string): string {
  nonceSeq += 1;
  return `${label}-${Date.now()}-${nonceSeq}`;
}

/** 演示模式的邮件信封（稳定字节串，与服务端 adapters 归一口径对应） */
const EMAIL_BODY = JSON.stringify({
  channel: "email",
  tenantId: "xingchen",
  from: "lin.zong@xingchen-demo.com",
  subject: "查询 CUST-8842 重复扣款",
  text: "帮我看下 CUST-8842 这单的重复扣款处理到哪一步了。",
});

/** 演示模式的 H5 信封（设备标识身份） */
const H5_BODY = JSON.stringify({
  channel: "h5",
  tenantId: "xingchen",
  deviceId: "H5-DEV-LINZONG-001",
  text: "刚才那单批了吗？",
});

interface SignOptions {
  /** 缺省用该通道当前生效密钥 */
  secret?: string;
  /** 缺省取当前时间（窗内） */
  timestamp?: number;
  /** 缺省一次性 nonce */
  nonce?: string;
  /** 缺省按密钥实时计算 v1 签名 */
  signature?: string;
}

/** 用指定密钥为信封计算签名并组装验签入参（模拟合法接入方） */
function signedArgs(channel: ChannelId, body: string, opts: SignOptions = {}) {
  const secret = opts.secret ?? resolveChannelSecret(channel).secret;
  const timestamp = opts.timestamp ?? Date.now();
  const nonce = opts.nonce ?? freshNonce(channel);
  const signature =
    opts.signature ?? `v1=${hmacHex(secret, signatureBaseString(channel, timestamp, nonce, body))}`;
  return { channel, timestamp, nonce, body, signature };
}

/** 断言验签拒绝并返回预期状态码（401 / 400） */
function assertRejected(args: Parameters<typeof verifyWebhookSignature>[0], expectedStatus: number): void {
  const verdict = verifyWebhookSignature(args);
  if (verdict.ok) assert.fail("该请求应被验签拒绝却放行了");
  assert.equal(verdict.status, expectedStatus);
}

/* ================================================================
 * ① 四通道一致性基线：邮件 / H5 与 Web、企微飞书走同一验签口径
 * ================================================================ */

describe("① 四通道验签一致性基线", () => {
  it("邮件与 H5 的合法签名均通过同一验签入口（三关全过）", () => {
    const emailVerdict = verifyWebhookSignature(signedArgs("email", EMAIL_BODY));
    assert.equal(emailVerdict.ok, true, "邮件合法签名应放行");
    const h5Verdict = verifyWebhookSignature(signedArgs("h5", H5_BODY));
    assert.equal(h5Verdict.ok, true, "H5 合法签名应放行");
  });

  it("签名基串公式对 4 通道完全一致：channel.timestamp.nonce.body", () => {
    for (const channel of CHANNEL_IDS) {
      assert.equal(
        signatureBaseString(channel, 1700000000000, "n1", "BODY"),
        `${channel}.1700000000000.n1.BODY`,
        `${channel} 的基串公式应与其余通道一致`,
      );
    }
  });

  it("4 通道密钥按通道隔离：互不相同（一通道泄露不波及其它）", () => {
    const secrets = CHANNEL_IDS.map((c) => resolveChannelSecret(c).secret);
    assert.equal(new Set(secrets).size, CHANNEL_IDS.length, "4 通道密钥应两两不同");
  });

  it("跨通道密钥互替必败：用 Web 密钥签邮件、用邮件密钥签 H5 一律 401", () => {
    assertRejected(signedArgs("email", EMAIL_BODY, { secret: resolveChannelSecret("web").secret }), 401);
    assertRejected(signedArgs("h5", H5_BODY, { secret: resolveChannelSecret("email").secret }), 401);
  });

  it("未知通道（含邮件 / H5 拼写错误）一律 400，不进入后续验签", () => {
    assertRejected(
      { channel: "sms", timestamp: Date.now(), nonce: freshNonce("sms"), body: "{}", signature: `v1=${"0".repeat(64)}` },
      400,
    );
  });
});

/* ================================================================
 * ② 邮件通道验签专项
 * ================================================================ */

describe("② 邮件通道验签专项", () => {
  it("篡改正文（发件人 from 被替换）→ 401（body 完整性受签名保护）", () => {
    const tampered = EMAIL_BODY.replace("lin.zong@xingchen-demo.com", "attacker@evil.example");
    assertRejected({ ...signedArgs("email", EMAIL_BODY), body: tampered }, 401);
  });

  it("篡改主题里的工单号 → 401", () => {
    const tampered = EMAIL_BODY.replace("CUST-8842", "CUST-0000");
    assertRejected({ ...signedArgs("email", EMAIL_BODY), body: tampered }, 401);
  });

  it("同一 nonce 重放 → 401；换新 nonce 重签 → 放行", () => {
    const nonce = freshNonce("email-replay");
    const first = verifyWebhookSignature(signedArgs("email", EMAIL_BODY, { nonce }));
    assert.equal(first.ok, true);
    assertRejected(signedArgs("email", EMAIL_BODY, { nonce }), 401);
    assert.equal(verifyWebhookSignature(signedArgs("email", EMAIL_BODY, { nonce: freshNonce("email-renew") })).ok, true);
  });

  it("时间戳超窗（6 分钟前）→ 401；窗内（4 分钟前）→ 放行", () => {
    assertRejected(signedArgs("email", EMAIL_BODY, { timestamp: Date.now() - 6 * 60 * 1000 }), 401);
    assert.equal(verifyWebhookSignature(signedArgs("email", EMAIL_BODY, { timestamp: Date.now() - 4 * 60 * 1000 })).ok, true);
  });

  it("缺头 fail-closed：时间戳 0（等价于头缺失）→ 401", () => {
    assertRejected(signedArgs("email", EMAIL_BODY, { timestamp: 0 }), 401);
  });

  it("签名格式非法：无 v1= 前缀 / 63 位截断 → 401；大写 hex 亦合法放行", () => {
    const valid = signedArgs("email", EMAIL_BODY);
    assertRejected({ ...valid, signature: valid.signature.slice(3) }, 401);
    assertRejected({ ...valid, signature: valid.signature.slice(0, -1) }, 401);
    const uppercase = { ...valid, signature: `v1=${valid.signature.slice(3).toUpperCase()}` };
    assert.equal(verifyWebhookSignature(uppercase).ok, true);
  });
});

/* ================================================================
 * ③ H5 通道验签专项
 * ================================================================ */

describe("③ H5 通道验签专项", () => {
  it("篡改设备标识 deviceId → 401", () => {
    const tampered = H5_BODY.replace("H5-DEV-LINZONG-001", "H5-DEV-ATTACKER");
    assertRejected({ ...signedArgs("h5", H5_BODY), body: tampered }, 401);
  });

  it("同一 nonce 重放 → 401；换新 nonce 重签 → 放行", () => {
    const nonce = freshNonce("h5-replay");
    assert.equal(verifyWebhookSignature(signedArgs("h5", H5_BODY, { nonce })).ok, true);
    assertRejected(signedArgs("h5", H5_BODY, { nonce }), 401);
    assert.equal(verifyWebhookSignature(signedArgs("h5", H5_BODY, { nonce: freshNonce("h5-renew") })).ok, true);
  });

  it("时间戳超窗（未来 6 分钟同样拒绝）→ 401", () => {
    assertRejected(signedArgs("h5", H5_BODY, { timestamp: Date.now() + 6 * 60 * 1000 }), 401);
  });

  it("nonce 命名空间按通道隔离：邮件用过的 nonce，H5 正确签名后仍可放行；同通道复用则 401", () => {
    const shared = freshNonce("shared-once");
    assert.equal(verifyWebhookSignature(signedArgs("email", EMAIL_BODY, { nonce: shared })).ok, true);
    assert.equal(verifyWebhookSignature(signedArgs("h5", H5_BODY, { nonce: shared })).ok, true, "跨通道复用 nonce 不应误伤");
    assertRejected(signedArgs("email", EMAIL_BODY, { nonce: shared }), 401);
  });
});

/* ================================================================
 * ④ 生产密钥接管（环境变量优先，演示密钥立即失效且不再下发）
 * ================================================================ */

describe("④ 生产密钥接管", () => {
  it("邮件通道：设置环境变量后切生产密钥，meta 不下发演示密钥，旧演示签名立即 401", () => {
    const envKey = channelSecretEnvName("email");
    const saved = process.env[envKey];
    const demoSecret = resolveChannelSecret("email").secret; // 接管前先取演示密钥
    process.env[envKey] = "prod-email-secret-0123456789";
    try {
      const resolved = resolveChannelSecret("email");
      assert.equal(resolved.mode, "production");
      assert.equal(resolved.secret, "prod-email-secret-0123456789");
      const meta = buildChannelMetaList().find((c) => c.id === "email");
      assert.ok(meta, "meta 列表应包含邮件通道");
      assert.equal(meta.mode, "production");
      assert.equal("demoSecret" in meta, false, "生产通道绝不下发演示密钥");
      assertRejected(signedArgs("email", EMAIL_BODY, { secret: demoSecret }), 401);
      assert.equal(verifyWebhookSignature(signedArgs("email", EMAIL_BODY)).ok, true);
    } finally {
      if (saved === undefined) delete process.env[envKey];
      else process.env[envKey] = saved;
    }
  });

  it("H5 通道：设置环境变量后切生产密钥，meta 不下发演示密钥，旧演示签名立即 401", () => {
    const envKey = channelSecretEnvName("h5");
    const saved = process.env[envKey];
    const demoSecret = resolveChannelSecret("h5").secret;
    process.env[envKey] = "prod-h5-secret-0123456789";
    try {
      const resolved = resolveChannelSecret("h5");
      assert.equal(resolved.mode, "production");
      assert.equal(resolved.secret, "prod-h5-secret-0123456789");
      const meta = buildChannelMetaList().find((c) => c.id === "h5");
      assert.ok(meta, "meta 列表应包含 H5 通道");
      assert.equal(meta.mode, "production");
      assert.equal("demoSecret" in meta, false, "生产通道绝不下发演示密钥");
      assertRejected(signedArgs("h5", H5_BODY, { secret: demoSecret }), 401);
      assert.equal(verifyWebhookSignature(signedArgs("h5", H5_BODY)).ok, true);
    } finally {
      if (saved === undefined) delete process.env[envKey];
      else process.env[envKey] = saved;
    }
  });
});

/* ================================================================
 * ⑤ 通道混淆防御（验签放行后由归一层兜底拒绝）
 * ================================================================ */

describe("⑤ 通道混淆防御（验签之后的归一层兜底）", () => {
  it("头=h5、body.channel=email 且用 H5 密钥合法签名 → 验签放行但归一 400", () => {
    const mixed = JSON.stringify({
      channel: "email",
      tenantId: "xingchen",
      from: "lin.zong@xingchen-demo.com",
      subject: "混入邮件通道",
      text: "伪造通道声明。",
    });
    assert.equal(verifyWebhookSignature(signedArgs("h5", mixed)).ok, true, "对 h5 通道的签名本身合法");
    const parsed = normalizeEnvelope(mixed, "h5");
    if (parsed.ok) assert.fail("通道混淆应被归一层拒绝");
    assert.equal(parsed.status, 400);
    assert.match(parsed.error, /不一致/);
  });

  it("邮件正文为空时以主题兜底（验签后的归一口径），身份取发件人", () => {
    const body = JSON.stringify({
      channel: "email",
      tenantId: "xingchen",
      from: "lin.zong@xingchen-demo.com",
      subject: "刚才那单批了吗",
    });
    const parsed = normalizeEnvelope(body, "email");
    if (!parsed.ok) assert.fail(parsed.error);
    assert.equal(parsed.msg.text, "刚才那单批了吗");
    assert.equal(parsed.msg.channelUserId, "lin.zong@xingchen-demo.com");
  });

  it("H5 设备标识归一：deviceId 作为渠道侧用户身份", () => {
    const parsed = normalizeEnvelope(H5_BODY, "h5");
    if (!parsed.ok) assert.fail(parsed.error);
    assert.equal(parsed.msg.channel, "h5");
    assert.equal(parsed.msg.channelUserId, "H5-DEV-LINZONG-001");
    assert.equal(parsed.msg.text, "刚才那单批了吗？");
  });
});
