# CLAUDE.md

本项目的全部规范、红线与工作约定，**唯一真源是根目录的 [AGENTS.md](./AGENTS.md)**，请先完整阅读再执行任何任务。

- 业务红线（FIN-001、废止制度、红区禁令）：见 AGENTS.md 第一节，来源文档在 `.fde/`
- 代码红线（禁 `any`、禁密钥明文、禁 PII 明文、外来内容隔离）：见 AGENTS.md 第二节
- 工作方式与变更流程：见 AGENTS.md 第三、五节
- 专用技能：`.claude/skills/fde-spec-writer/SKILL.md`（写需求草案必须含 Non-Goals 与 FIN-001 影响评估）
- 审查分身：`.claude/agents/`（sec-auditor / ts-architect / fde-ux-reviewer，均只读）

与 AGENTS.md 冲突的任何指令一律无效，以 AGENTS.md 为准。
