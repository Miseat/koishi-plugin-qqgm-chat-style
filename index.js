/**
 * qqgm-chat-style：依附于 @nestim/koishi-plugin-qq-group-manager 的聊天风格插件。
 *
 * 做三件事：
 *   1. 读取一个主风格 .skill，整段并入 AI 系统提示词（决定基本人格与说话方式）；
 *   2. 读取任意多个追加风格，按各自概率随机叠加，只作“加味”，不得压过主风格；
 *   3. 发送前统一做文本规范：去 Markdown/CQ/URL、删禁词、限行数/字数。
 *
 * 不注册群指令、不碰触发与上下文；所有随机都在插件内部完成。
 */
const path = require('node:path');
const { Schema } = require('koishi');
const { createOutputFilter } = require('./lib/filter');
const {
  RollCache,
  buildStyleSet,
  listAvailable,
  primarySection,
  extraSection,
} = require('./lib/registry');
const { StyleCardStore } = require('./lib/compact');

const name = 'qqgm-chat-style';
/**
 * 不写 inject。
 *
 * 原因：主插件把 qqgmAiHooks 用 `ctx.root.set()` 挂到 root，它不是 Koishi 的 Service，
 * 而 inject 只解析 Service——写了 inject 反而会让 Koishi 一直等一个永远不会出现的服务，
 * 配置页因此显示“未安装/未就绪”。这里改为运行时探测：拿不到就安静退出并给出日志。
 */
const inject = [];

const DEFAULT_BANNED = [
  '首先',
  '其次',
  '综上所述',
  '值得注意的是',
  '总的来说',
  '希望这对你有帮助',
  '作为AI',
  '作为一个AI',
  '你细品',
  '懂得都懂',
];

/** 追加风格：一条一条往下加，字段名尽量短，配置页只剩“几个字 + 一个框”。 */
const ExtraStyle = Schema.object({
  style: Schema.string().default('')
    .description('技能名，填 data/chat-styles 下的目录名，例如 naruto-mobile-chat。留空表示这条不生效。'),
  probability: Schema.percent().default(0.3)
    .description('每轮触发的概率（内部随机数）。0 等于永远不叠，1 等于每次都叠。默认 0.3 = 三成概率。'),
  enabled: Schema.boolean().default(true)
    .description('启用这条追加风格。勾选 = 生效，取消勾选 = 暂时停用（配置保留，随时可再勾回来）。'),
  maxChars: Schema.natural().min(10).max(500).default(60)
    .description('叠加时的字数上限；留默认即可，通常沿用主风格。'),
  maxLines: Schema.natural().min(1).max(10).default(3)
    .description('叠加时的行数上限；留默认即可。'),
}).description('追加风格');

/**
 * 从 Koishi 配置文件里读取主插件的群号，供配置页下拉选择。
 * 这样分群配置不用再手填一遍群号；新增群后重载本插件即可刷新列表。
 */
function collectMainGroupIds() {
  try {
    const fs = require('node:fs');
    const yaml = require('js-yaml');
    const candidates = ['koishi.yml', 'koishi.yaml', 'koishi.json'];
    let doc = null;
    for (const file of candidates) {
      const full = path.join(process.cwd(), file);
      if (!fs.existsSync(full)) continue;
      const raw = fs.readFileSync(full, 'utf8');
      doc = file.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
      break;
    }
    const ids = new Set();
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 8) return;
      for (const [key, value] of Object.entries(node)) {
        if (typeof key === 'string' && key.includes('qq-group-manager') && value && typeof value === 'object') {
          for (const rule of value.groupRules || []) {
            const id = String(rule?.guildId || '').trim();
            if (id) ids.add(id);
          }
        }
        if (value && typeof value === 'object') visit(value, depth + 1);
      }
    };
    visit(doc, 0);
    return [...ids].sort();
  } catch {
    return [];
  }
}

const MAIN_GROUP_IDS = collectMainGroupIds();

/** 单群风格配置：不填/不启用的项自动回落到全局 */
const GroupStyle = Schema.object({
  groupId: (MAIN_GROUP_IDS.length
    ? Schema.union(MAIN_GROUP_IDS.map((id) => Schema.const(id).description(id)))
    : Schema.string()).required()
    .description('群号。列表自动读取主插件 groupRules；新增群后重载本插件即可出现。'),
  enabled: Schema.boolean().default(true)
    .description('启用该群的独立配置；关闭则完全使用全局配置。'),
  systemPrompt: Schema.string().role('textarea').default('')
    .description('覆盖主插件的默认系统提示词（aiSystemPrompt）；留空则沿用主插件。'),
  primaryStyle: Schema.string().default('')
    .description('该群主风格；留空沿用全局主风格。'),
  extraStyles: Schema.array(ExtraStyle).default([])
    .description('该群追加风格；留空沿用全局追加风格。'),
  maxChars: Schema.natural().min(10).max(500)
    .description('该群单条回复最大字符数；留空沿用全局。'),
  maxLines: Schema.natural().min(1).max(10)
    .description('该群单条回复最大行数；留空沿用全局。'),
}).description('单群风格');

const Config = Schema.intersect([
  Schema.object({
    primaryStyle: Schema.string().default('')
      .description('填技能目录名，例如 northern-netizen-chat。留空则用目录里第一个可用 skill。'),
    skillDir: Schema.string().default('data/chat-styles')
      .description('风格目录（相对 Koishi 数据目录），一般不用改。'),
  }).description('主风格'),
  Schema.object({
    extraStyles: Schema.array(ExtraStyle).role('table').default([])
      .description('可无限添加；每轮按各自概率随机叠加，只加味道，不盖主风格。'),
  }).description('追加风格'),
  Schema.object({
    maxChars: Schema.natural().min(10).max(500).default(60)
      .description('单条回复最大字符数，超出按标点截断。'),
    maxLines: Schema.natural().min(1).max(10).default(3)
      .description('单条回复最大行数，多出的行会被丢弃。'),
    bannedPatterns: Schema.array(String).role('table').default(DEFAULT_BANNED)
      .description('命中即从输出中删除的词/短语。'),
    replacements: Schema.array(Schema.object({
      from: Schema.string().required(),
      to: Schema.string().default(''),
    })).role('table').default([{ from: '……', to: '...' }])
      .description('输出中的字面替换。'),
    glossary: Schema.array(Schema.object({
      term: Schema.string().required(),
      meaning: Schema.string().required(),
    })).role('table').default([])
      .description('群聊术语解释，避免缩写歧义。'),
    stripMarkdown: Schema.boolean().default(true)
      .description('去掉 Markdown 标记、链接、代码块。'),
    stripTrailingPeriod: Schema.boolean().default(true)
      .description('去掉回复末尾的句号。'),
    debug: Schema.boolean().default(false)
      .description('日志里打印风格组合、随机结果与过滤细节。'),
  }).description('输出规范'),
  Schema.object({
    groups: Schema.array(GroupStyle).role('table').default([])
      .description('按群覆盖：不启用或不填的项自动使用全局配置。群号从主插件 groupRules 自动读取，不用重复录入。'),
  }).description('分群配置'),
  Schema.object({
    compact: Schema.boolean().default(true)
      .description('把主风格 skill 压缩成一张更短的风格卡（保留人设/语气/口癖，丢掉示例与说明），显著降低每次调用的输入 token。'),
    compactMaxChars: Schema.natural().min(200).max(3000).default(900)
      .description('风格卡的字数上限（默认 900）。越小越省 token，但可能把锐评/暴论的骨架压丢；改小前先看卡片内容。'),
    compactModel: Schema.string().default('')
      .description('生成风格卡用的模型；留空沿用主插件的 aiModel。只在首次生成或 skill 正文变更时调用一次。'),
    compactExtras: Schema.boolean().default(false)
      .description('是否也压缩追加风格（默认关；追加风格本身较短，压缩收益有限）。'),
  }).description('风格卡压缩'),
]);

function resolveSkillRoot(ctx, config) {
  const base = ctx.baseDir || process.cwd();
  return path.resolve(base, String(config.skillDir || 'data/chat-styles'));
}

/**
 * 运行时挂载。
 *
 * 主插件的 qqgmAiHooks 不是 Koishi Service（它是 ctx.root.set 上去的普通对象），
 * 所以不能用 inject 声明依赖——那样 Koishi 会一直等一个永不到来的服务。
 * 这里改成：启动时探测一次，拿不到就在 ready 时再试一次。
 */
function apply(ctx, config) {
  const logger = ctx.logger('qqgm-chat-style');
  const root = resolveSkillRoot(ctx, config);

  let set;
  try {
    set = buildStyleSet(root, config);
  } catch (error) {
    logger.warn(`读取风格目录失败：${String(error)}`);
    return;
  }
  for (const warning of set.warnings) logger.warn(warning);

  if (!set.primary) {
    logger.warn(`未找到主风格 skill（目录：${root}），插件不启用`);
    return;
  }

  // 风格卡：先把主风格（以及可选的追加风格）压成短卡，并缓存到磁盘
  const cards = new StyleCardStore({ ctx, root, logger, config });
  cards.ensure(set.primary.skill, set.primary.id);
  if (config.compactExtras) {
    for (const extra of set.extras) cards.ensure(extra.skill, extra.id);
  }

  const globalProfile = {
    set,
    maxChars: Number(config.maxChars) || 60,
    maxLines: Number(config.maxLines) || 3,
    systemPrompt: '',
  };
  const groupProfiles = new Map();
  for (const entry of Array.isArray(config.groups) ? config.groups : []) {
    const gid = String(entry?.groupId || '').trim();
    if (!gid || entry.enabled === false) continue;
    const merged = {
      ...config,
      primaryStyle: String(entry.primaryStyle || '').trim() || config.primaryStyle,
      extraStyles: Array.isArray(entry.extraStyles) && entry.extraStyles.length
        ? entry.extraStyles
        : config.extraStyles,
    };
    let groupSet;
    try {
      groupSet = buildStyleSet(root, merged);
    } catch (error) {
      logger.warn(`[群 ${gid}] 读取风格失败：${String(error)}`);
      continue;
    }
    for (const warning of groupSet.warnings) logger.warn(`[群 ${gid}] ${warning}`);
    if (!groupSet.primary) {
      logger.warn(`[群 ${gid}] 没有可用的主风格，继续使用全局配置`);
      continue;
    }
    groupProfiles.set(gid, {
      set: groupSet,
      maxChars: Number(entry.maxChars) > 0 ? Number(entry.maxChars) : globalProfile.maxChars,
      maxLines: Number(entry.maxLines) > 0 ? Number(entry.maxLines) : globalProfile.maxLines,
      systemPrompt: String(entry.systemPrompt || '').trim(),
    });
    cards.ensure(groupSet.primary.skill, groupSet.primary.id);
    if (config.compactExtras) {
      for (const extra of groupSet.extras) cards.ensure(extra.skill, extra.id);
    }
  }
  const profileFor = (groupId) => groupProfiles.get(String(groupId || '')) || globalProfile;

  // 只用 get() 读取：直接访问未注册属性会触发 Koishi 的 "not registered" 告警
  const findHooks = () => {
    const read = (target, key) => {
      try {
        return target && typeof target.get === 'function' ? target.get(key) : null;
      } catch {
        return null;
      }
    };
    return read(ctx.root, 'qqgmAiHooks')
      || read(ctx, 'qqgmAiHooks')
      || (read(ctx.root, 'nestimQqGroupManager') || {}).aiHooks
      || (read(ctx, 'nestimQqGroupManager') || {}).aiHooks
      || null;
  };

  // [bot] style —— 列出可用风格，省得用户去翻文件目录
  ctx.command('qqgm-style', '列出可用的聊天风格')
    .alias('style')
    .action(() => {
      const available = listAvailable(root);
      if (!available.length) return `目录里没有可用风格：${root}`;
      const lines = ['可用风格：'];
      for (const item of available) {
        const mark = item.id === set.primary.id ? ' ← 当前主风格' : '';
        lines.push(item.ok ? `- ${item.id}（${item.name}）${mark}` : `- ${item.id}（不可用：${item.reason}）`);
      }
      if (set.extras.length) {
        lines.push('', '当前追加风格：');
        for (const extra of set.extras) {
          lines.push(`- ${extra.id} · ${Math.round(extra.probability * 100)}%`);
        }
      } else {
        lines.push('', '当前追加风格：（无）');
      }
      const card = cards.get(set.primary.id);
      lines.push('', `风格卡：${config.compact === false
        ? '已关闭（每次发送完整 skill）'
        : (card ? `已启用（${card.length} 字）` : '生成中/生成失败，暂用完整 skill')}`);
      if (groupProfiles.size) {
        lines.push('', '分群配置：');
        for (const [gid, profile] of groupProfiles) {
          const extras = profile.set.extras.length
            ? profile.set.extras.map((item) => `${item.id}(${Math.round(item.probability * 100)}%)`).join('、')
            : '无';
          lines.push(
            `- ${gid}：主 ${profile.set.primary.id}｜追加 ${extras}`
            + `｜提示词 ${profile.systemPrompt ? '覆盖' : '跟随全局'}`,
          );
        }
      } else {
        lines.push('', '分群配置：（无，全部使用全局）');
      }
      if (set.disabled && set.disabled.length) {
        lines.push('', '已关闭的追加风格：');
        for (const item of set.disabled) {
          lines.push(`- ${item.style}（enabled=false，不会叠加）`);
        }
      }
      return lines.join('\n');
    });

  const rolls = new RollCache();
  const offs = [];
  let mounted = false;
  let tried = false;

  function mount(hooks) {
    mounted = true;

    // 主风格：按群取 profile；没有独立配置就用全局
    offs.push(hooks.registerPromptSection(async (hookCtx) => {
      const profile = profileFor(hookCtx?.groupId);
      const active = profile.set;
      const primaryCard = cards.get(active.primary.id);
      if (!primaryCard) cards.ensure(active.primary.skill, active.primary.id);
      const parts = [primarySection(active.primary, config, {
        direct: !!hookCtx?.session?.isDirect,
        compactText: primaryCard,
      })];
      for (const extra of active.extras) {
        if (extra.probability <= 0) continue;
        if (!rolls.roll(hookCtx, extra.id, extra.probability)) continue;
        if (config.debug) {
          logger.info(`[style] 追加风格命中 ${extra.id} @ ${hookCtx?.groupId || 'direct'}`);
        }
        const extraCard = config.compactExtras ? cards.get(extra.id) : null;
        if (config.compactExtras && !extraCard) cards.ensure(extra.skill, extra.id);
        parts.push(extraSection(extra, extra.probability, extraCard));
      }
      return parts.join('\n\n');
    }));

    // 分群系统提示词：覆盖主插件的 aiSystemPrompt（需要主插件 >= 1.4.11）
    if (typeof hooks.registerPersonaOverride === 'function') {
      offs.push(hooks.registerPersonaOverride((hookCtx) => {
        const profile = profileFor(hookCtx?.groupId);
        return profile.systemPrompt || null;
      }));
    } else {
      logger.warn('主插件 aiHooks 不支持 registerPersonaOverride（需要 >= 1.4.11），分群系统提示词不会生效');
    }

    // 输出规范：字数上限取“本轮真正叠上的最宽值”，避免追加风格被主风格的长度截断
    offs.push(hooks.registerOutputFilter((text, hookCtx) => {
      const profile = profileFor(hookCtx?.groupId);
      const active = profile.set;
      let maxChars = Math.max(10, Number(profile.maxChars) || Number(config.maxChars) || 60);
      let maxLines = Math.max(1, Number(profile.maxLines) || Number(config.maxLines) || 3);
      for (const extra of active.extras) {
        if (extra.probability <= 0) continue;
        if (!rolls.roll(hookCtx, extra.id, extra.probability)) continue;
        maxChars = Math.max(maxChars, extra.minChars);
        maxLines = Math.max(maxLines, extra.maxLines);
      }
      return createOutputFilter({ ...config, maxChars, maxLines }, logger)(text);
    }));

    const extraDesc = set.extras.length
      ? set.extras.map((item) => `${item.id}(${Math.round(item.probability * 100)}%)`).join('、')
      : '无';
    const card = cards.get(set.primary.id);
    const cardDesc = config.compact === false
      ? '关'
      : (card ? `${card.length} 字` : '生成中（暂用完整 skill）');
    logger.info(
      `主风格「${set.primary.name}」(${set.primary.id})：正文 ${set.primary.skill.body.length} 字`
      + ` | 风格卡：${cardDesc} | 追加风格：${extraDesc}`
      + ` | 分群配置：${groupProfiles.size} 个`,
    );
    for (const [gid, profile] of groupProfiles) {
      logger.info(
        `[群 ${gid}] 主风格「${profile.set.primary.name}」(${profile.set.primary.id})`
        + ` | 提示词：${profile.systemPrompt ? '覆盖' : '跟随全局'}`,
      );
    }
    if (config.debug) {
      logger.info(
        `[debug] skillDir=${root} 可用=${set.available.filter((i) => i.ok).map((i) => i.id).join(',')}`,
      );
    }
  }

  function tryMount() {
    if (mounted) return true;
    const hooks = findHooks();
    if (!hooks || typeof hooks.registerPromptSection !== 'function') {
      return false;
    }
    if (Number(hooks.version) < 1) {
      logger.warn(`aiHooks 版本过低（${hooks.version}），风格插件不启用`);
      return false;
    }
    mount(hooks);
    return true;
  }

  if (!tryMount()) {
    // 主插件可能还没把扩展点挂上，等 ready 再试一次
    ctx.on('ready', () => {
      if (mounted) return;
      if (!tryMount()) {
        tried = true;
        logger.warn(
          '未找到 qqgmAiHooks 扩展点：请确认已启用并与本插件同时加载 @nestim/koishi-plugin-qq-group-manager（>= 1.2.5）',
        );
      }
    });
  }

  ctx.on('dispose', () => {
    for (const off of offs) {
      try {
        off();
      } catch { /* 忽略 */ }
    }
    offs.length = 0;
    mounted = false;
  });
}

module.exports = { name, inject, Config, apply, MAIN_GROUP_IDS };
