/**
 * alias-resolver.mjs —— 单元测试专用的路径别名解析钩子（零第三方依赖）
 * 背景：Next.js 用 tsconfig paths 把 "@/x" 映射到项目根 src/x；Node 内置 test runner
 *      不识别该别名，也不给无扩展名的 .ts 相对导入补扩展名，这里统一兜底。
 * 边界：仅拦截 "@/..." 与确实存在对应 .ts 文件的无扩展名相对导入；其余走 Node 默认解析。
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function resolve(specifier, context, nextResolve) {
  // ① tsconfig paths：@/x → 项目根 src/x（.ts 显式扩展名，配合 --experimental-strip-types）；
  //    带扩展名的 .mjs（如 @/lib/llm/llm-client.mjs）按 tsconfig 的 "./*" 兜底映射到项目根
  if (specifier.startsWith("@/")) {
    const bare = specifier.slice(2);
    if (bare.endsWith(".mjs")) {
      const mjsTarget = new URL(`../${bare}`, import.meta.url);
      if (existsSync(fileURLToPath(mjsTarget))) {
        return { url: mjsTarget.href, shortCircuit: true };
      }
    }
    const target = new URL(`../src/${bare}.ts`, import.meta.url);
    if (existsSync(fileURLToPath(target))) {
      return { url: target.href, shortCircuit: true };
    }
    // ③ 目录形式：@/db → src/db/index.ts（同 Node/TS 的目录 index 兜底）
    const indexTarget = new URL(`../src/${bare}/index.ts`, import.meta.url);
    if (existsSync(fileURLToPath(indexTarget))) {
      return { url: indexTarget.href, shortCircuit: true };
    }
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

/**
 * load 钩子：测试进程内拦截 .json 导入（Day 26 审批策略配置等）。
 * 背景：Node ESM 要求 JSON 导入必须带 `with { type: "json" }` 属性，
 *      而项目 TypeScript 5.0.2 解析不了该语法（5.3+ 才支持）——两边夹击。
 * 解法：源码用普通 JSON 导入（Next 打包器 + resolveJsonModule 兼容），
 *      测试进程在这里把 JSON 文件转成 ESM 模块返回，双端兼容。
 */
export function load(url, context, nextLoad) {
  if (url.endsWith(".json")) {
    const text = readFileSync(fileURLToPath(url), "utf-8");
    return { format: "module", source: `export default ${text};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
