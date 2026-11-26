/**
 * doc-intake/zip.ts —— 零第三方依赖的最小 ZIP 读写器（Node 内置 zlib）
 * 用途：生成/解析 docx（合同修订版）与 xlsx（对账大表）——两者本质都是 zip 包。
 * 设计：写侧 deflateRawSync 压缩；读侧解析中央目录 + inflateRawSync 解压，
 *      兼容 Word/Excel 产出的真实文件。白名单式白盒实现，不做 zip64 / 加密。
 * 溯源：Day 14「HTML 解析零第三方依赖」同一工程哲学在本模块的延续。
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

/* ---------------- CRC32（查表法） ---------------- */

const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 固定时间戳 2026-11-26 12:00（确定性输出，便于测试快照比对） */
const DOS_TIME = (12 << 11) | (0 << 5) | 0;
const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 26;

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function pushU16(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff);
}

function pushU32(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

/** 拼接多个字节块 */
function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** 生成 zip 包（method 8 = deflate；文件名 UTF-8） */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const raw = Buffer.from(entry.data);
    const compressed = deflateRawSync(raw);
    const crc = crc32(entry.data);

    // 本地文件头
    const head: number[] = [];
    pushU32(head, 0x04034b50);
    pushU16(head, 20); // version needed
    pushU16(head, 0x0800); // flags：UTF-8 文件名
    pushU16(head, 8); // method = deflate
    pushU16(head, DOS_TIME);
    pushU16(head, DOS_DATE);
    pushU32(head, crc);
    pushU32(head, compressed.length);
    pushU32(head, entry.data.length);
    pushU16(head, nameBytes.length);
    pushU16(head, 0);
    const local = concatBytes([new Uint8Array(head), nameBytes, compressed]);
    locals.push(local);

    // 中央目录记录
    pushU32(centrals, 0x02014b50);
    pushU16(centrals, 20);
    pushU16(centrals, 20);
    pushU16(centrals, 0x0800);
    pushU16(centrals, 8);
    pushU16(centrals, DOS_TIME);
    pushU16(centrals, DOS_DATE);
    pushU32(centrals, crc);
    pushU32(centrals, compressed.length);
    pushU32(centrals, entry.data.length);
    pushU16(centrals, nameBytes.length);
    pushU16(centrals, 0);
    pushU16(centrals, 0);
    pushU16(centrals, 0);
    pushU16(centrals, 0);
    pushU32(centrals, 0);
    pushU32(centrals, offset);
    centrals.push(...nameBytes);
    offset += local.length;
  }

  const centralBytes = new Uint8Array(centrals);
  const eocd: number[] = [];
  pushU32(eocd, 0x06054b50);
  pushU16(eocd, 0);
  pushU16(eocd, 0);
  pushU16(eocd, entries.length);
  pushU16(eocd, entries.length);
  pushU32(eocd, centralBytes.length);
  pushU32(eocd, offset);
  pushU16(eocd, 0);
  return concatBytes([...locals, centralBytes, new Uint8Array(eocd)]);
}

/** 解析 zip 包 → 文件名内容映射（兼容 deflate / store 两种压缩方式） */
export function readZip(buf: Uint8Array): Map<string, Uint8Array> {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 从尾部向前搜 EOCD 魔数（0x06054b50）
  let eocdPos = -1;
  const searchStart = Math.max(0, bytes.length - 65536);
  for (let i = bytes.length - 22; i >= searchStart; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) throw new Error("zip 解析失败：未找到 EOCD 结束记录（文件可能不是合法 zip 包）");

  const entryCount = view.getUint16(eocdPos + 10, true);
  let cdPos = view.getUint32(eocdPos + 16, true);

  const result = new Map<string, Uint8Array>();
  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(cdPos, true) !== 0x02014b50) {
      throw new Error("zip 解析失败：中央目录记录损坏");
    }
    const method = view.getUint16(cdPos + 10, true);
    const csize = view.getUint32(cdPos + 20, true);
    const usize = view.getUint32(cdPos + 24, true);
    const nameLen = view.getUint16(cdPos + 28, true);
    const extraLen = view.getUint16(cdPos + 30, true);
    const commentLen = view.getUint16(cdPos + 32, true);
    const localOffset = view.getUint32(cdPos + 42, true);
    const name = new TextDecoder().decode(bytes.slice(cdPos + 46, cdPos + 46 + nameLen));

    // 从本地头取真实的文件名/扩展字段长度（与中央目录可能不一致）
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.slice(dataStart, dataStart + csize);

    let data: Uint8Array;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      data = new Uint8Array(inflateRawSync(raw));
    } else {
      throw new Error(`zip 解析失败：不支持的压缩方式 ${String(method)}（${name}）`);
    }
    if (data.length !== usize) {
      throw new Error(`zip 解析失败：${name} 解压后大小不符`);
    }
    result.set(name, data);
    cdPos += 46 + nameLen + extraLen + commentLen;
  }
  return result;
}

/** zip 内容按 UTF-8 解码 */
export function decodeZipText(data: Uint8Array): string {
  return Buffer.from(data).toString("utf8");
}
