# 更新日志

本文件记录所有值得注意的变更。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 1.0.1

### 修复

- **配置页不再错误显示「必需服务：qqgmAiHooks（未加载）」**。

  `qqgmAiHooks` 是主插件用 `ctx.root.set()` 挂上去的普通对象，不是 Koishi 的 Service。
  在代码里写 `inject: ['qqgmAiHooks']` 会让 Koishi 一直等一个永远不会注册的服务，
  配置页因此报「必需服务未加载」。

  改为运行时探测（`ctx.get()`）+ `ready` 重试：拿不到才安静退出并给日志，
  不再污染配置页。

- 移除 package.json 里无效的 `koishi.service.required` 字段（Koishi 不解析它，只会加重误判）。

- 依赖改为 `peerDependencies`：`@nestim/koishi-plugin-qq-group-manager >= 1.2.5`。

## 1.0.0

### 首个公开版本

**主风格 + 追加风格**

- **主风格**：读取一个 `.skill`（`SKILL.md`），整段并入 AI 系统提示词，决定基本人格与说话方式。
- **追加风格**：无限添加；每个独立设置触发概率，用内部随机数决定这一轮叠不叠。
- **不喧宾夺主**：追加风格自带约束段——主风格的语气、句式、长度始终优先，冲突时一律按主风格来。
- **轮内一致**：同一轮里提示词和输出过滤器看到同一个随机结果，不会「提示词叠了、过滤没叠」。

**输出规范**

去 Markdown / CQ 码 / 链接、删禁词、限行数字数、去句末句号。

**其他**

- `[bot] style` 列出全部可用风格
- skill 正文含注入话术（「忽略之前的指令」、`system prompt`、脚本执行等）时拒绝加载
- 自动去掉「文件索引」节、对 `references/` 等路径的引用、代码块与 HTML 注释
