import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Day 34 生产双容器打包：构建产物输出 .next/standalone（自带精简 node_modules，
  // 运行镜像无需安装全量依赖，配合多阶段 Dockerfile 把体积压到最小）
  output: "standalone",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
