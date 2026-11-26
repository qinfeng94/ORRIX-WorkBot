/**
 * register-hooks.mjs —— 测试进程启动时注册别名解析钩子（由 package.json test 脚本的 --import 加载）
 */

import { register } from "node:module";

register(new URL("./alias-resolver.mjs", import.meta.url));
