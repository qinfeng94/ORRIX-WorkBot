/**
 * security/byok-kms.ts —— Day 36 BYOK 单租户密钥仓与 1 秒拔钥匙锁库（唯一真源）
 * 溯源：AGENTS.md 代码红线 2（密钥严禁入代码/日志，演示密钥文件已加入 .gitignore）；
 *      AGENTS.md「物理 Kill Switch 优先」（拔钥匙 = 运维有意状态，非降级）；
 *      04 号文档 CISO 条款（密钥主权归客户，WorkBot 只存信封密文）。
 *
 * 信封加密（Envelope Encryption）：
 *  - KEK（Key Encryption Key）= 客户自带的根密钥（BYOK），只存两处：
 *    ① 客户侧托管文件 byok-customer-keys.json（模拟客户自管 KMS，应用只读，永不修改）；
 *    ② WorkBot 密钥仓 byok-key-vault.json 的运行副本——拔钥匙时物理销毁该副本。
 *  - DEK（Data Encryption Key）= 每条敏感单据一把独立 32 字节随机密钥，负责加密内容；
 *  - KEK 以 AES-256-GCM 包裹（wrap）DEK；解密 = 先用 KEK 解包 DEK，再用 DEK 解内容；
 *  - 拔钥匙（killKey）：销毁 WorkBot 侧 KEK 副本 → 所有 DEK 无法解包 → 该租户全部敏感数据
 *    瞬间拒绝解密（零缓存实时读仓，与 kill-switch.ts 同款口径），其他租户完全不受影响；
 *  - 重新交付（restoreKey）：客户从自己 KMS 原样重新上传 KEK → 旧信封全部可解（密钥从未换过）。
 *
 * 边界：
 *  - 只准服务端引用（node:fs / node:crypto），客户端组件严禁 import；
 *  - AAD 绑定租户与单号：密文挪到别的租户/单号行上会 GCM 校验失败，防串档换密文；
 *  - 密钥操作台账 byok-audit.jsonl 只增不改（appendFile，无任何覆盖入口）；
 *  - 本模块只管密码学与密钥仓状态，数据库读写归调用方（/api/security/byok）。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TENANT_ID_PATTERN } from "@/lib/ontology/tenant-config";

/* ================================================================
 * 一、常量与类型
 * ================================================================ */

/** 密钥仓数据目录（演示密钥材料不入库——整个目录已加入 .gitignore） */
export const BYOK_DATA_DIR = path.join(process.cwd(), "data", "day36");

/** 客户侧密钥托管文件（模拟客户自管 KMS / HSM；应用只读，绝不修改） */
const CUSTOMER_KEYS_FILE = path.join(BYOK_DATA_DIR, "byok-customer-keys.json");

/** WorkBot 密钥仓状态文件（应用唯一可写密钥文件；拔钥匙即销毁其中 KEK 副本） */
const VAULT_FILE = path.join(BYOK_DATA_DIR, "byok-key-vault.json");

/** 密钥操作台账（只增不改：拔钥匙 / 重新交付 / 初始化 / 批量入档 全留痕） */
export const BYOK_AUDIT_FILE = path.join(BYOK_DATA_DIR, "byok-audit.jsonl");

/** 控制台演示租户（星辰与瑞康；其余租户不在密钥仓注册，fail-closed 拒绝） */
export const BYOK_DEMO_TENANTS = ["xingchen", "ruikang"] as const;
export type ByokTenantId = (typeof BYOK_DEMO_TENANTS)[number];

/** 信封密文结构（jsonb 落库形态；全部字段 hex） */
export interface EnvelopeBlob {
  /** 信封格式版本 */
  v: 1;
  /** 加密时 KEK 指纹（SHA-256 hex，审计口径） */
  fp: string;
  /** 被包裹 DEK 的 GCM iv / auth tag / 密文 */
  dekIv: string;
  dekTag: string;
  wrappedDek: string;
  /** 单据内容的 GCM iv / auth tag / 密文 */
  iv: string;
  tag: string;
  ct: string;
}

/** 敏感单据内容（每租户独立的两个 PII 字段：姓名 + 金融账号） */
export interface SensitivePayload {
  name: string;
  account: string;
}

/** 密钥仓时间线条目（控制台展示最近操作） */
export interface KeyTimelineEntry {
  action: "activated" | "kill" | "restore";
  at: string;
  fingerprint: string;
  detail: string;
}

/** 单租户密钥仓状态 */
export interface TenantKeyState {
  status: "active" | "revoked";
  fingerprint: string;
  /** WorkBot 侧 KEK 运行副本（hex）；吊销后物理销毁为 null */
  kekHex: string | null;
  activatedAt: string;
  revokedAt: string | null;
  timeline: KeyTimelineEntry[];
}

/** KEK 已被吊销（解密 / 加密一律 fail-closed 拒绝） */
export class KeyRevokedError extends Error {
  readonly tenantId: string;

  constructor(tenantId: string) {
    super(
      `租户 ${tenantId} 的 BYOK 密钥已被吊销：KEK 不在位，敏感数据拒绝解密。` +
        `请由客户重新交付密钥（restore）后恢复访问。`,
    );
    this.name = "KeyRevokedError";
    this.tenantId = tenantId;
  }
}

/* ================================================================
 * 二、AES-256-GCM 原语（Node 原生 crypto，零第三方依赖）
 * ================================================================ */

const KEK_BYTES = 32; // AES-256
const GCM_IV_BYTES = 12;
const DEK_WRAP_AAD_PREFIX = "byok-dek-wrap-v1";
const DOC_AAD_PREFIX = "byok-doc-v1";

interface GcmResult {
  iv: Buffer;
  ct: Buffer;
  tag: Buffer;
}

function aesGcmEncrypt(key: Buffer, plaintext: Buffer, aad: string): GcmResult {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf-8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}

/** tag 校验不过 / AAD 不符 / 密钥错误时 final() 直接抛错（fail-closed） */
function aesGcmDecrypt(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf-8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** KEK 指纹：SHA-256 hex（只用于比对与展示，不泄露密钥本身） */
function fingerprintOf(kekHex: string): string {
  return createHash("sha256").update(kekHex, "hex").digest("hex");
}

function assertKekHex(kekHex: string): void {
  if (!/^[0-9a-f]{64}$/.test(kekHex)) {
    throw new Error("KEK 材料非法：必须是 64 位 hex（32 字节）。");
  }
}

/* ================================================================
 * 三、密钥仓文件读写（零缓存：每次操作实时读文件，拔钥匙立刻生效）
 * ================================================================ */

type VaultFile = Record<string, TenantKeyState>;
type EscrowFile = Record<string, { kekHex: string; fingerprint: string; deliveredAt: string }>;

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const text = await readFile(file, "utf-8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(BYOK_DATA_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

/** 台账追加（只增不改；写失败即整体失败，杜绝无留痕的密钥操作） */
async function appendAudit(entry: Record<string, unknown>): Promise<void> {
  await mkdir(BYOK_DATA_DIR, { recursive: true });
  await appendFile(BYOK_AUDIT_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
}

/** 外部留痕入口（批量入档等密钥相关操作；只增不改，写失败整体失败） */
export async function auditByokEvent(
  action: string,
  tenantId: string,
  detail: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await appendAudit({ ts: new Date().toISOString(), action, tenantId, detail, ...extra });
}

/** 校验租户 ID：白名单格式 + 必须是密钥仓已注册的演示租户（fail-closed 防路径穿越） */
function assertTenant(tenantId: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(`租户 ID 非法：${tenantId}`);
  }
  if (!(BYOK_DEMO_TENANTS as readonly string[]).includes(tenantId)) {
    throw new Error(`租户 ${tenantId} 未在 BYOK 密钥仓注册（演示范围：${BYOK_DEMO_TENANTS.join("、")}）。`);
  }
}

/** 初始化（幂等单飞）：客户托管文件生成 KEK；密钥仓登记为 active */
let initPromise: Promise<void> | null = null;
/** 慢盘预热标记：每进程首次控制台加载（GET）时预写一次 vault，把首写开销挪出「拔钥匙」瞬间 */
let vaultWriteWarmed = false;
function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const escrow = (await readJson<EscrowFile>(CUSTOMER_KEYS_FILE)) ?? {};
      const vault = (await readJson<VaultFile>(VAULT_FILE)) ?? {};
      let escrowDirty = false;
      let vaultDirty = false;
      for (const tenantId of BYOK_DEMO_TENANTS) {
        if (!escrow[tenantId]) {
          const kekHex = randomBytes(KEK_BYTES).toString("hex");
          escrow[tenantId] = {
            kekHex,
            fingerprint: fingerprintOf(kekHex),
            deliveredAt: new Date().toISOString(),
          };
          escrowDirty = true;
        }
        if (!vault[tenantId]) {
          vault[tenantId] = {
            status: "active",
            fingerprint: escrow[tenantId]!.fingerprint,
            kekHex: escrow[tenantId]!.kekHex,
            activatedAt: new Date().toISOString(),
            revokedAt: null,
            timeline: [
              {
                action: "activated",
                at: new Date().toISOString(),
                fingerprint: escrow[tenantId]!.fingerprint,
                detail: "客户首次交付 BYOK 密钥，密钥仓登记在位。",
              },
            ],
          };
          vaultDirty = true;
        }
      }
      if (escrowDirty) await writeJson(CUSTOMER_KEYS_FILE, escrow);
      if (vaultDirty || !vaultWriteWarmed) {
        // 内容不变时该写入与现盘内容一致（状态文件非审计日志，允许等值回写）
        await writeJson(VAULT_FILE, vault);
        vaultWriteWarmed = true;
      }
    })().catch((err: unknown) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

/** 密钥操作互斥链：kill / restore 串行执行，避免并发写仓互相覆盖 */
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = opChain.then(fn, fn);
  opChain = next.catch(() => undefined);
  return next;
}

/* ================================================================
 * 四、密钥主权操作：状态 / 拔钥匙 / 重新交付
 * ================================================================ */

/** 读取单租户密钥状态（实时读文件；输出不含任何密钥材料） */
export async function getTenantKeyState(tenantId: string): Promise<TenantKeyState> {
  assertTenant(tenantId);
  await ensureInitialized();
  const vault = await readJson<VaultFile>(VAULT_FILE);
  const state = vault?.[tenantId];
  if (!state) {
    throw new Error(`租户 ${tenantId} 密钥仓状态缺失（fail-closed）。`);
  }
  return state;
}

/** 读取全部演示租户密钥状态 */
export async function listTenantKeyStates(): Promise<Array<{ tenantId: string } & TenantKeyState>> {
  return Promise.all(
    BYOK_DEMO_TENANTS.map(async (tenantId) => ({
      tenantId,
      ...(await getTenantKeyState(tenantId)),
    })),
  );
}

/**
 * 拔钥匙（1 秒吊销）：销毁 WorkBot 侧 KEK 副本 → 该租户所有 DEK 解包失败。
 * 幂等友好：已吊销时返回 alreadyRevoked=true 而不报错；台账与时间线全留痕。
 */
export async function killKey(
  tenantId: string,
  operator = "console-运维",
): Promise<{ alreadyRevoked: boolean; state: TenantKeyState }> {
  assertTenant(tenantId);
  return serialize(async () => {
    await ensureInitialized();
    const vault = (await readJson<VaultFile>(VAULT_FILE)) ?? {};
    const state = vault[tenantId];
    if (!state) throw new Error(`租户 ${tenantId} 密钥仓状态缺失（fail-closed）。`);
    if (state.status === "revoked") {
      return { alreadyRevoked: true, state };
    }
    const now = new Date().toISOString();
    const entries: KeyTimelineEntry[] = [
      {
        action: "kill",
        at: now,
        fingerprint: state.fingerprint,
        detail: `运维拔除租户密钥：WorkBot 侧 KEK 副本已物理销毁，全部 DEK 解包失败。`,
      },
      ...state.timeline,
    ];
    const timeline = entries.slice(0, 10);
    const next: TenantKeyState = {
      ...state,
      status: "revoked",
      kekHex: null,
      revokedAt: now,
      timeline,
    };
    vault[tenantId] = next;
    await writeJson(VAULT_FILE, vault);
    await appendAudit({
      ts: now,
      action: "kill",
      tenantId,
      fingerprint: state.fingerprint,
      operator,
      detail: "1 秒拔钥匙：KEK 副本销毁，敏感数据拒绝解密",
    });
    return { alreadyRevoked: false, state: next };
  });
}

/**
 * 重新交付密钥：客户从自管 KMS 原样重新上传 KEK（托管文件只读回取）。
 * 旧信封用同一把 KEK 包裹 → 恢复后全部可解，数据从未被改动。
 */
export async function restoreKey(
  tenantId: string,
  operator = "console-客户",
): Promise<{ alreadyActive: boolean; state: TenantKeyState }> {
  assertTenant(tenantId);
  return serialize(async () => {
    await ensureInitialized();
    const escrow = await readJson<EscrowFile>(CUSTOMER_KEYS_FILE);
    const kek = escrow?.[tenantId];
    if (!kek) {
      throw new Error(`客户侧未托管租户 ${tenantId} 的密钥，无法重新交付（fail-closed）。`);
    }
    assertKekHex(kek.kekHex);
    const vault = (await readJson<VaultFile>(VAULT_FILE)) ?? {};
    const state = vault[tenantId];
    if (!state) throw new Error(`租户 ${tenantId} 密钥仓状态缺失（fail-closed）。`);
    if (state.status === "active") {
      return { alreadyActive: true, state };
    }
    const fp = fingerprintOf(kek.kekHex);
    if (fp !== state.fingerprint) {
      throw new Error(
        `重新交付的密钥指纹与吊销前不一致（${fp.slice(0, 12)}… ≠ ${state.fingerprint.slice(0, 12)}…）：拒绝恢复。`,
      );
    }
    const now = new Date().toISOString();
    const entries: KeyTimelineEntry[] = [
      {
        action: "restore",
        at: now,
        fingerprint: fp,
        detail: "客户重新交付原密钥：KEK 回到在位，旧信封全部恢复可解。",
      },
      ...state.timeline,
    ];
    const timeline = entries.slice(0, 10);
    const next: TenantKeyState = {
      status: "active",
      fingerprint: fp,
      kekHex: kek.kekHex,
      activatedAt: now,
      revokedAt: null,
      timeline,
    };
    vault[tenantId] = next;
    await writeJson(VAULT_FILE, vault);
    await appendAudit({
      ts: now,
      action: "restore",
      tenantId,
      fingerprint: fp,
      operator,
      detail: "客户重新交付密钥，旧信封恢复可解",
    });
    return { alreadyActive: false, state: next };
  });
}

/* ================================================================
 * 五、信封加密 / 解密（调用前实时读仓，吊销租户 fail-closed 双向拒绝）
 * ================================================================ */

function dekWrapAad(tenantId: string): string {
  return `${DEK_WRAP_AAD_PREFIX}|${tenantId}`;
}

function docAad(tenantId: string, ticketNo: string): string {
  return `${DOC_AAD_PREFIX}|${tenantId}|${ticketNo}`;
}

/**
 * 信封加密：独立 DEK 加密内容，租户 KEK 包裹 DEK。
 * 吊销租户抛 KeyRevokedError（新数据也拒绝入档，防止「明文绕道」）。
 */
export async function encryptSensitiveForTenant(
  tenantId: string,
  ticketNo: string,
  payload: SensitivePayload,
): Promise<{ envelope: EnvelopeBlob; keyFingerprint: string }> {
  assertTenant(tenantId);
  const state = await getTenantKeyState(tenantId);
  if (state.status !== "active" || state.kekHex === null) {
    throw new KeyRevokedError(tenantId);
  }
  assertKekHex(state.kekHex);
  const kek = Buffer.from(state.kekHex, "hex");
  const dek = randomBytes(KEK_BYTES);

  const wrapped = aesGcmEncrypt(
    kek,
    dek,
    dekWrapAad(tenantId),
  );
  const doc = aesGcmEncrypt(
    dek,
    Buffer.from(JSON.stringify(payload), "utf-8"),
    docAad(tenantId, ticketNo),
  );

  const envelope: EnvelopeBlob = {
    v: 1,
    fp: state.fingerprint,
    dekIv: wrapped.iv.toString("hex"),
    dekTag: wrapped.tag.toString("hex"),
    wrappedDek: wrapped.ct.toString("hex"),
    iv: doc.iv.toString("hex"),
    tag: doc.tag.toString("hex"),
    ct: doc.ct.toString("hex"),
  };
  return { envelope, keyFingerprint: state.fingerprint };
}

/**
 * 信封解密：KEK 解包 DEK → DEK 解内容。任何一环失败都抛错：
 * 吊销 → KeyRevokedError；密文挪行 / 篡改 → GCM 校验失败。
 */
export async function decryptSensitiveForTenant(
  tenantId: string,
  ticketNo: string,
  envelope: EnvelopeBlob,
): Promise<SensitivePayload> {
  assertTenant(tenantId);
  const state = await getTenantKeyState(tenantId);
  if (state.status !== "active" || state.kekHex === null) {
    throw new KeyRevokedError(tenantId);
  }
  assertKekHex(state.kekHex);
  const kek = Buffer.from(state.kekHex, "hex");

  const dek = aesGcmDecrypt(
    kek,
    Buffer.from(envelope.dekIv, "hex"),
    Buffer.from(envelope.wrappedDek, "hex"),
    Buffer.from(envelope.dekTag, "hex"),
    dekWrapAad(tenantId),
  );
  const plain = aesGcmDecrypt(
    dek,
    Buffer.from(envelope.iv, "hex"),
    Buffer.from(envelope.ct, "hex"),
    Buffer.from(envelope.tag, "hex"),
    docAad(tenantId, ticketNo),
  );
  const raw: unknown = JSON.parse(plain.toString("utf-8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`租户 ${tenantId} 单据 ${ticketNo} 的解密结果结构非法。`);
  }
  const rec = raw as Record<string, unknown>;
  const name: unknown = rec.name;
  const account: unknown = rec.account;
  if (typeof name !== "string" || typeof account !== "string") {
    throw new Error(`租户 ${tenantId} 单据 ${ticketNo} 的解密结果结构非法。`);
  }
  return { name, account };
}

/** 启动自检：加密→解密闭环 + 吊销态双向拒绝，任一失败拒绝服务 */
export async function assertByokHealthy(): Promise<void> {
  const probeTenant: ByokTenantId = "xingchen";
  const probe = await encryptSensitiveForTenant(probeTenant, "SELFTEST", {
    name: "自检",
    account: "0000000000000000",
  });
  const back = await decryptSensitiveForTenant(
    probeTenant,
    "SELFTEST",
    probe.envelope,
  );
  if (back.name !== "自检") {
    throw new Error("WorkBot BYOK 自检失败：信封加解密闭环不通过");
  }
}
