/**
 * /api/memory —— Day 9「记忆可控性」接口（仅服务端）
 * 用户可随时一键查看 / 编辑 / 删除 AI 记住的任意一条事实（AGENTS.md 透明度要求）。
 * - GET    ?userKey=xxx      → 情景记忆列表（最近 50 条）+ 该用户语义记忆行
 * - POST   编辑：{ kind:"episode", id, content } 更新情景摘要；
 *              { kind:"preference", userKey, displayName?, department?, style?, facts? } 更新语义记忆
 * - DELETE ?kind=episode&id=1 或 ?kind=preference&id=2 → 删除
 * 边界：这两张表不在只增不改触发器范围内（记忆必须可被用户遗忘）；不含任何 PII 明文。
 */

import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureSchema, getDb } from "@/db";
import { memoryEpisodes, userPreferences } from "@/db/schema";
import { cleanDisabledFacts } from "@/lib/memory";

/** 演示环境的默认用户标识（前端不登录，以具名审批人名作为 user_key） */
const DEFAULT_USER_KEY = "demo-林总";

/** GET：查看全部记忆 */
export async function GET(request: Request): Promise<Response> {
  try {
    await ensureSchema();
    const url = new URL(request.url);
    const userKey =
      url.searchParams.get("userKey")?.trim().slice(0, 64) || DEFAULT_USER_KEY;

    const db = getDb();
    const episodes = await db
      .select()
      .from(memoryEpisodes)
      .orderBy(desc(memoryEpisodes.id))
      .limit(50);
    const prefRows = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userKey, userKey))
      .limit(1);

    return NextResponse.json({
      userKey,
      episodes,
      preference: prefRows[0] ?? null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "未知错误";
    return NextResponse.json(
      { error: `记忆读取失败：${message}` },
      { status: 500 },
    );
  }
}

interface EditEpisodeBody {
  kind: "episode";
  id: number;
  content: string;
  /** 片段开关：true=启用（注入 AI 上下文）；false=停用 */
  enabled?: boolean;
}

interface EditPreferenceBody {
  kind: "preference";
  userKey: string;
  displayName?: string;
  department?: string;
  style?: string;
  facts?: string[];
  /** 被停用的事实（facts 的子集，AI 不再参考） */
  disabledFacts?: string[];
}

/** POST：编辑一条情景摘要，或更新语义记忆（称呼/部门/风格/事实清单） */
export async function POST(request: Request): Promise<Response> {
  try {
    await ensureSchema();
    const raw: unknown = await request.json().catch(() => null);
    const body = (raw ?? {}) as Partial<EditEpisodeBody | EditPreferenceBody>;

    if (body.kind === "episode") {
      const ep = body as EditEpisodeBody;
      const id = Number(ep.id);
      const content = String(ep.content ?? "").trim();
      const wantEnabled = typeof ep.enabled === "boolean" ? ep.enabled : undefined;
      if (!Number.isInteger(id) || id <= 0) {
        return NextResponse.json({ error: "记忆条目 id 非法。" }, { status: 400 });
      }
      // 内容与片段开关至少给一个；都给时同时更新
      if (content.length === 0 && wantEnabled === undefined) {
        return NextResponse.json(
          { error: "需提供新内容或片段开关（enabled）。" },
          { status: 400 },
        );
      }
      if (content.length > 500) {
        return NextResponse.json(
          { error: "情景摘要内容需在 1~500 字之间。" },
          { status: 400 },
        );
      }
      const updated = await getDb()
        .update(memoryEpisodes)
        .set({
          ...(content.length > 0 ? { content } : {}),
          ...(wantEnabled !== undefined ? { enabled: wantEnabled } : {}),
        })
        .where(eq(memoryEpisodes.id, id))
        .returning();
      if (updated.length === 0) {
        return NextResponse.json({ error: "该条记忆不存在。" }, { status: 404 });
      }
      return NextResponse.json({ ok: true, episode: updated[0] });
    }

    if (body.kind === "preference") {
      const pref = body as EditPreferenceBody;
      const userKey = String(pref.userKey ?? "").trim().slice(0, 64);
      if (userKey.length === 0) {
        return NextResponse.json({ error: "userKey 不能为空。" }, { status: 400 });
      }
      // 事实清单：只收字符串数组，每条 1~200 字，最多 20 条
      let facts: string[] | undefined;
      if (Array.isArray(pref.facts)) {
        facts = pref.facts
          .map((f) => String(f ?? "").trim())
          .filter((f) => f.length > 0 && f.length <= 200)
          .slice(0, 20);
      }
      // 停用清单：同规则校验；保存时会剔除不在 facts 里的孤儿项
      let disabledFacts: string[] | undefined;
      if (Array.isArray(pref.disabledFacts)) {
        disabledFacts = pref.disabledFacts
          .map((f) => String(f ?? "").trim())
          .filter((f) => f.length > 0 && f.length <= 200)
          .slice(0, 20);
      }
      const values = {
        userKey,
        displayName: String(pref.displayName ?? "").slice(0, 40),
        department: String(pref.department ?? "").slice(0, 40),
        style: String(pref.style ?? "").slice(0, 40),
        ...(facts !== undefined ? { facts } : {}),
        ...(disabledFacts !== undefined ? { disabledFacts } : {}),
        updatedAt: new Date(),
      };
      const upserted = await getDb()
        .insert(userPreferences)
        .values(values)
        .onConflictDoUpdate({
          target: userPreferences.userKey,
          set: {
            displayName: values.displayName,
            department: values.department,
            style: values.style,
            ...(facts !== undefined ? { facts } : {}),
            ...(disabledFacts !== undefined
              ? { disabledFacts: cleanDisabledFacts(facts ?? [], disabledFacts) }
              : {}),
            updatedAt: values.updatedAt,
          },
        })
        .returning();
      return NextResponse.json({ ok: true, preference: upserted[0] });
    }

    return NextResponse.json(
      { error: "kind 必须是 episode 或 preference。" },
      { status: 400 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "未知错误";
    return NextResponse.json(
      { error: `记忆保存失败：${message}` },
      { status: 500 },
    );
  }
}

/** DELETE：让 AI「忘掉」一条情景记忆或整份语义记忆 */
export async function DELETE(request: Request): Promise<Response> {
  try {
    await ensureSchema();
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind");
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "id 非法。" }, { status: 400 });
    }
    const db = getDb();
    if (kind === "episode") {
      const deleted = await db
        .delete(memoryEpisodes)
        .where(eq(memoryEpisodes.id, id))
        .returning();
      if (deleted.length === 0) {
        return NextResponse.json({ error: "该条记忆不存在。" }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    }
    if (kind === "preference") {
      await db.delete(userPreferences).where(eq(userPreferences.id, id));
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json(
      { error: "kind 必须是 episode 或 preference。" },
      { status: 400 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "未知错误";
    return NextResponse.json(
      { error: `记忆删除失败：${message}` },
      { status: 500 },
    );
  }
}
