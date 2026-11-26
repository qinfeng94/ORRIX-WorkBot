/** Day 29 配置工作台 · 租户清单 API（GET 全部已上架租户配置，fail-closed） */

import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { listTenantIds, loadTenantConfig } from "@/lib/ontology/tenant-config";

export async function GET(): Promise<Response> {
  try {
    const ids = await listTenantIds();
    const tenants = await Promise.all(ids.map(async (id) => await loadTenantConfig(id)));
    return NextResponse.json({ tenants });
  } catch (err: unknown) {
    return errorResponse(err);
  }
}
