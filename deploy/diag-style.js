const { loadConfiguredSkill } = require('/koishi/node_modules/koishi-plugin-qqgm-chat-style/lib/loader.js');
const r = loadConfiguredSkill('/koishi/data/chat-styles', { style: 'northern-netizen-chat' });
console.log('skill:', r.skill ? r.skill.id : null, 'body:', r.skill ? r.skill.body.length : 0);
console.log('warnings:', r.warnings);

try {
  const plugin = require('/koishi/node_modules/koishi-plugin-qqgm-chat-style/index.js');
  console.log('plugin exports:', Object.keys(plugin));
  console.log('config keys:', Object.keys(plugin.Config({}) || {}));
} catch (error) {
  console.error('plugin require failed:', error);
}
