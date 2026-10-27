/**
 * lib/registry.js —— 多风格加载与“主 + 追加”组合。
 *
 * 设计要点：
 * - 主风格（primary）：整段进提示词，决定基本人格与说话方式；
 * - 追加风格（extras）：只作“加味层”，必须显式声明不得压过主风格；
 * - 每个追加风格有独立触发概率，用内部随机数决定这一轮是否叠上；
 * - 随机判定按 (会话, 轮次) 记忆，保证同一轮里提示词与输出过滤器看到同一个结果。
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadSkillFromDir, listSkillDirs } = require('./loader');

/** 追加风格一旦被抽中，本轮的固定种子；同一轮内多次取板块结果一致。 */
class RollCache {
  constructor() {
    this.map = new Map();
  }
  key(ctx, id) {
    const group = ctx && ctx.groupId != null ? String(ctx.groupId) : 'direct';
    return `${group}::${id}`;
  }
  roll(ctx, id, probability) {
    const key = this.key(ctx, id);
    const now = Date.now();
    const hit = this.map.get(key);
    // 8 秒内视为同一轮：足够覆盖一次模型调用 + 一次发送
    if (hit && now - hit.at < 8000) return hit.value;
    const value = Math.random() < probability;
    this.map.set(key, { at: now, value });
    // 顺手清理过期条目，避免长跑内存增长
    if (this.map.size > 256) {
      for (const [k, v] of this.map) {
        if (now - v.at > 60000) this.map.delete(k);
      }
    }
    return value;
  }
}

function listAvailable(rootDir) {
  const dirs = listSkillDirs(rootDir);
  const out = [];
  for (const dir of dirs) {
    const result = loadSkillFromDir(dir);
    out.push({
      id: path.basename(dir),
      ok: !!result.ok,
      name: result.ok ? result.skill.name : path.basename(dir),
      reason: result.ok ? '' : result.reason,
      skill: result.ok ? result.skill : null,
    });
  }
  return out;
}

function pickByName(available, wanted) {
  const target = String(wanted || '').trim();
  if (!target) return null;
  return (
    available.find((item) => item.ok && (item.id === target || item.name === target)) || null
  );
}

/** 追加风格不得反客为主：统一加一段约束。 */
function extraGuard(name, rarity) {
  const lines = [
    `下面这段是「${name}」的附加口癖，只是给主风格加味道用。`,
    '- 主风格的语气、句式、长度始终优先；这段只能增色，不能改写人设、不能换话题、不能抢主线；',
    '- 与主风格冲突时，一律按主风格来；',
    '- 该用多少用多少，一句带一个就够，不要整段照搬，也不要解释这些词。',
  ];
  if (rarity) lines.push(`- 这段口癖出现的频率约为 ${rarity}，所以不必每句都用力。`);
  return lines.join('\n');
}

/**
 * @param {object} rootDir 技能目录
 * @param {object} config 插件配置
 * @returns {{ primary, extras, warnings, available }}
 */
function buildStyleSet(rootDir, config = {}) {
  const available = listAvailable(rootDir);
  const warnings = [];

  for (const item of available) {
    if (!item.ok) warnings.push(`跳过 ${item.id}：${item.reason}`);
  }

  const primaryWanted = String(config.primaryStyle || '').trim();
  let primary = pickByName(available, primaryWanted);
  if (primaryWanted && !primary) {
    warnings.push(
      `主风格「${primaryWanted}」不可用；可用：${available.filter((i) => i.ok).map((i) => i.id).join(', ') || '（无）'}`,
    );
  }
  if (!primary) {
    primary = available.find((item) => item.ok) || null;
    if (primary && !primaryWanted) {
      warnings.push(`未指定主风格，默认使用 ${primary.id}`);
    }
  }

  const extras = [];
  const disabled = [];
  const seen = new Set(primary ? [primary.id] : []);
  const rawExtras = Array.isArray(config.extraStyles) ? config.extraStyles : [];
  rawExtras.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const wanted = String(entry.style || '').trim();
    if (!wanted) return;

    // enabled 未填（undefined / null）一律视为启用，只有显式 false 才算关闭。
    // 以前这里直接 return 且不记日志，用户完全看不出为什么没生效。
    const isOff = entry.enabled === false;
    if (isOff) {
      disabled.push({ index, style: wanted });
      warnings.push(
        `追加风格 #${index + 1}「${wanted}」已关闭（enabled=false），本次不会叠加；想启用请把该项勾上`,
      );
      return;
    }

    const found = pickByName(available, wanted);
    if (!found) {
      warnings.push(`追加风格 #${index + 1}「${wanted}」不可用，已跳过`);
      return;
    }
    if (seen.has(found.id)) {
      warnings.push(`追加风格「${found.id}」与已有风格重复，已跳过`);
      return;
    }
    seen.add(found.id);
    let probability = Number(entry.probability);
    if (!Number.isFinite(probability)) probability = 0.3;
    probability = Math.min(1, Math.max(0, probability));
    extras.push({
      index,
      id: found.id,
      name: found.skill.name,
      skill: found.skill,
      probability,
      minChars: Math.max(10, Number(entry.maxChars) || Number(config.maxChars) || 60),
      maxLines: Math.max(1, Number(entry.maxLines) || Number(config.maxLines) || 3),
    });
  });

  return { primary, extras, disabled, warnings, available };
}

/** 主风格段：与旧版行为一致，整段进入提示词。 */
function primarySection(primary, config, options = {}) {
  const { buildStylePrompt } = require('./prompt');
  return buildStylePrompt(primary.skill, config, options);
}

/** 追加风格段：加约束后拼接。 */
function extraSection(extra, probability) {
  const percent = `${Math.round(probability * 100)}%`;
  const body = extra.skill.body.trim();
  return [extraGuard(extra.name, percent), '', body].join('\n');
}

module.exports = {
  RollCache,
  listAvailable,
  pickByName,
  buildStyleSet,
  primarySection,
  extraSection,
  extraGuard,
};
