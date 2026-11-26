/**
 * alias-resolver.mjs —— 单元测试专用的路径别名解析钩子（零第三方依赖）
 * 背景：Next.js 用 tsconfig paths 把 "@/x" 映射到项目根 src/x；Node 内置 test runner
 *      不识别该别名，也不给无扩展名的 .ts 相对导入补扩展名，这里统一兜底。
 * 边界：仅拦截 "@/..." 与确实存在对应 .ts 文件的无扩展名相对导入；其余走 Node 默认解析。
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function resolve(specifier, context, nextResolve) {
  // ① tsconfig paths：@/x → 项目根 src/x（.ts 显式扩展名，配合 --experimental-strip-types）
  if (specifier.startsWith("@/")) {
    const target = new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url);
    return { url: target.href, shortCircuit: true };
  }

  // ② 相对导入：源码里写的是 "./envelopes" 这类无扩展名形式，若存在对应 .ts 文件则补全
  const parentURL = context.parentURL;
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    typeof parentURL === "string"
  ) {
    const candidate = new URL(`${specifier}.ts`, parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
