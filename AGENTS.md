# AGENTS.md

> 本仓库所有 AI 工具（Claude Code、Codex 等）的**唯一规则源**。各工具入口文件只 `import` 本文件，不要在别处重复写规则。

## 项目

**fluxp blog** —— 基于 **Nextra 4**（App Router）的中文前端技术知识库。

- 栈：Next.js 16 · React 19 · TypeScript · Nextra 4 + `nextra-theme-docs` · **pnpm**
- 搜索：Pagefind（构建时生成索引）
- 站点样式由主题接管；`mdx-components.tsx` 仅透传主题组件，目前无自定义组件

## 命令（一律用 pnpm）

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 本地开发 |
| `pnpm build` | 构建 + 生成 Pagefind 索引 |
| `pnpm start` | 运行生产构建 |

## 内容约定（本仓库最重要的部分）

- 文章路径：`content/<技术栈>/<slug>.mdx`（如 `content/react/hooks.mdx`），允许嵌套（如 `content/performance/react/`）
- **frontmatter 必填** `title` 与 `description`
- **新增 / 重命名 / 删除 `.mdx` 必须同步该目录的 `_meta.ts`**：键 = 文件名（无扩展名），值 = 中文标题；书写顺序 = 侧边栏顺序
- 正文用**中文**，技术名词与代码保留英文
- 代码块标注语言；示意图优先用 **Mermaid**（基础 `flowchart` 语法即可，subgraph 标题不要加引号）
- 站内链接用绝对路径，如 `/react/rendering`
- 非必要不引入自定义 MDX 组件

## 技能（Skills）

- 唯一事实源：`.agents/skills/<name>/`，**只在这里编辑**。`SKILL.md` 用 `name` + `description` frontmatter + 正文（Claude / Codex 通用）；Codex 专属配置放 `<name>/agents/openai.yaml`（Claude 自动忽略）。
- `.claude/skills`、`.codex/skills` 是指向 `.agents/skills` 的**符号链接**，请勿手改（改链接等于改源）。

## 工作方式（行为准则）

1. **想清再写**：说明假设；有多种解读就列出来交由人选；不确定就问，别默默猜。
2. **最简优先**：只写需求所需，不加投机的抽象、配置或防御性代码；能 50 行别写 200 行。
3. **外科手术式改动**：只改该改的；别顺手「优化」邻近代码 / 注释 / 格式；匹配现有风格；发现无关死代码先提示、不擅自删。
4. **目标驱动**：把任务转成可验证的成功标准，循环到通过；多步任务先给一句话计划。
5. **不擅自引入第三方库**：绝不主动安装或添加新依赖（不擅自跑 `pnpm add`）；如确有需要，只**说明理由并推荐**，由用户判断是否引入。优先复用现有依赖与原生 API。

> 取舍：以上偏稳妥而非求快；琐碎任务自行裁量。

## 验证

- 内容 / 样式改动：`pnpm dev` 在浏览器确认（Mermaid、组件为客户端渲染，需肉眼看）
- 较大改动提交前 `pnpm build`，确认构建与 Pagefind 索引不报错
