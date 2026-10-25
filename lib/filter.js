/**
 * 输出过滤器：只做“规范/限制”，不改写内容。
 *
 * 顺序：去 Markdown/HTML/CQ/URL → 替换词 → 删除禁词 → 行数/字数限制 → 去句末句号
 * 返回 null 表示过滤后没有可发内容（按 pass 处理）。
 */

function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_~`]/g, '');
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const minBoundary = Math.floor(maxChars * 0.5);

  // 优先断在句末，其次分号；避免出现“话没说完，”这种半截话
  for (const char of ['。', '！', '？', '!', '?']) {
    const index = slice.lastIndexOf(char);
    if (index >= minBoundary) return slice.slice(0, index + 1).trim();
  }
  for (const char of ['；', ';']) {
    const index = slice.lastIndexOf(char);
    if (index >= minBoundary) return slice.slice(0, index + 1).trim();
  }

  const room = Math.max(1, maxChars - 3);
  const hard = slice.slice(0, room).replace(/[，,、；;：:。\s]+$/g, '').trim();
  return `${hard}...`;
}

function createOutputFilter(config = {}, logger) {
  const banned = (config.bannedPatterns || []).map((item) => String(item || '').trim()).filter(Boolean);
  const replacements = (config.replacements || [])
    .filter((item) => item && String(item.from || '').length)
    .map((item) => ({ from: String(item.from), to: String(item.to ?? '') }));
  const maxChars = Math.max(10, Number(config.maxChars) || 60);
  const maxLines = Math.max(1, Number(config.maxLines) || 3);

  return (text) => {
    let out = String(text || '').trim();
    if (!out) return null;

    if (config.stripMarkdown !== false) out = stripMarkdown(out);
    out = out
      .replace(/\[CQ:[^\]]+\]/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/https?:\/\/\S+/gi, '');

    for (const item of replacements) {
      out = out.split(item.from).join(item.to);
    }
    for (const word of banned) {
      out = out.split(word).join('');
    }

    out = out
      .replace(/[ \t]+/g, ' ')
      .replace(/[，,]{2,}/g, '，')
      .replace(/[。]{2,}/g, '。')
      .replace(/ +([，。！？；：,.!?;:])/g, '$1')
      .replace(/^[，,、；;：:。\s]+/, '')
      .replace(/[，,、；;：:]+$/g, '')
      .trim();

    const lines = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, maxLines);
    out = lines.join('\n').trim();

    if (config.stripTrailingPeriod !== false) {
      out = out.replace(/。+$/g, '').trim();
    }

    if (out.length > maxChars) {
      out = truncate(out, maxChars);
      if (config.stripTrailingPeriod !== false) out = out.replace(/。+$/g, '').trim();
    }

    if (!out || !/[\u4e00-\u9fa5a-zA-Z0-9]/.test(out)) return null;
    return out;
  };
}

module.exports = { createOutputFilter, stripMarkdown, truncate };
