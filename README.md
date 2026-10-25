# @nestim/koishi-plugin-qqgm-chat-style

Koishi 聊天风格插件，配合 [`@nestim/koishi-plugin-qq-group-manager`](https://www.npmjs.com/package/@nestim/koishi-plugin-qq-group-manager) 使用。

**一个主风格决定它是什么人，若干追加风格按概率随机加味，主风格永远优先。**

## 相关插件

| 插件 | 说明 |
| --- | --- |
| [`@nestim/koishi-plugin-qq-group-manager`](https://github.com/Miseat/koishi-plugin-qq-group-manager) | **主插件**：群管、自动管控、AI 回复、记忆库、识图、定时提醒 |
| **`@nestim/koishi-plugin-qqgm-chat-style`** | 本插件：聊天风格 |
| [`@nestim/koishi-plugin-qqgm-meme`](https://github.com/Miseat/koishi-plugin-qqgm-meme) | 表情包：按情绪标签抽图，按概率补发 |

配套 skill（可直接放进 `data/chat-styles/`）：

- [northern-netizen-chat](https://github.com/Miseat/northern-netizen-chat) —— 中文北方网友，短句、带刺、归因降维
- [naruto-mobile-chat](https://github.com/Miseat/naruto-mobile-chat) —— 火影忍者手游圈口癖，适合当追加风格

## 特性

| 能力 | 说明 |
| --- | --- |
| **主风格** | 读取一个 `.skill`（`SKILL.md`），整段并入 AI 系统提示词，决定基本人格与说话方式 |
| **追加风格** | 无限添加；每个独立设置触发概率，用内部随机数决定这一轮叠不叠 |
| **不喧宾夺主** | 追加风格自带约束段：主风格的语气、句式、长度始终优先，冲突时一律按主风格来 |
| **概率可调** | 0 = 永不叠加，1 = 每次都叠；实测 2000 轮命中率与设定值吻合 |
| **轮内一致** | 同一轮里提示词和输出过滤器看到同一个随机结果，不会“提示词叠了、过滤没叠” |
| **输出规范** | 去 Markdown / CQ 码 / 链接、删禁词、限行数字数、去句末句号 |

## 安装

```sh
npm i @nestim/koishi-plugin-qqgm-chat-style
```

或在 Koishi 控制台「插件市场」搜索 `qqgm-chat-style`。

需要先启用 `@nestim/koishi-plugin-qq-group-manager`（提供 `qqgmAiHooks` 扩展点，>= 1.2.2）。

## 准备 skill

把风格目录放进 Koishi 数据目录：

```text
data/chat-styles/
├── northern-netizen-chat/
│   └── SKILL.md
└── naruto-mobile-chat/
    └── SKILL.md
```

`SKILL.md` 需要有 front matter，且类别属于聊天风格：

```yaml
---
name: northern-netizen-chat
metadata:
  category: persona-chat    # 或 kind: chat-style
---
```

插件只取正文，并会自动去掉「文件索引」节、对 `references/` `examples/` 的引用、代码块和 HTML 注释。
正文里如果出现注入话术（如「忽略之前的指令」、`system prompt`、脚本执行等）会被拒绝加载。

可用的风格会写进日志；也可以在群里发送 `[bot] style` 列出全部（需主插件已加载）。

## 配置

配置页分三组。

### 主风格

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| 主风格 | 空 | 填技能目录名，例如 `northern-netizen-chat`。留空则用目录里第一个可用 skill |
| 风格目录 | `data/chat-styles` | 相对 Koishi 数据目录，一般不用改 |

### 追加风格

一个可无限添加的表格，每行：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| 技能名 | 空 | 目录名，例如 `naruto-mobile-chat` |
| 触发概率 | `0.3` | 每轮独立随机；0 从不叠加，1 每次叠加 |
| 启用 | `true` | 临时关掉，不必删除 |
| 字数上限 | `60` | 叠加时的上限 |
| 行数上限 | `3` | 叠加时的上限 |

### 输出规范

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| 单条回复最大字符数 | `60` | 超出按标点截断 |
| 单条回复最大行数 | `3` | 多出的行丢弃 |
| 删词列表 | 见默认 | 命中即从输出中删除 |
| 字面替换 | `……` → `...` | 依次执行 |
| 术语表 | `[]` | 避免缩写歧义，注入提示词 |
| 去 Markdown | `true` | 去标记、链接、代码块 |
| 去末尾句号 | `true` | |
| 调试日志 | `false` | 打印风格组合、随机结果与过滤细节 |

## 它是怎么影响输出的

主插件的提示词里有一节【说话风格】，所有 `qqgmAiHooks` 的段落会按注册顺序拼进去。本插件注册一段：

1. **主风格段**（永远在）——包装后的完整 skill 正文 + 边界声明；
2. **追加风格段**（按概率）——加味约束 + 该 skill 正文。

追加段的开头就写明：主风格的语气、句式、长度始终优先，这段只能增色、不能改写人设、不能换话题。

## 示例

```yaml
primaryStyle: northern-netizen-chat
extraStyles:
  - style: naruto-mobile-chat
    probability: 0.3
    enabled: true
```

效果：始终是北方网友的口吻；三成概率加点火影手游圈的口癖，但骂人和讲理的方式不变。

## 与主插件的接口

只依赖 `ctx.qqgmAiHooks`（接口版本 >= 1）：

- `registerPromptSection()` —— 返回风格段
- `registerOutputFilter()` —— 规范输出，返回 `null` 表示本条不发

不注册群管指令，不碰触发逻辑和上下文，不读写数据库。

## 开源

MIT。欢迎改、欢迎提 PR。

- GitHub: <https://github.com/Miseat/koishi-plugin-qqgm-chat-style>
- 主插件: <https://github.com/Miseat/koishi-plugin-qq-group-manager>
