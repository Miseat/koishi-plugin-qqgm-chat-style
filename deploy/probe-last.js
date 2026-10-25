const fs = require('node:fs');
const lines = fs.readFileSync('/koishi/qq-event-probe.log', 'utf8').trim().split(/\r?\n/).slice(-12);
for (const line of lines) {
  try {
    const j = JSON.parse(line);
    if (j.tag !== 'message') {
      console.log(j.t, j.tag);
      continue;
    }
    const content = j.content || j.message || j.rawMessage || '';
    console.log(j.t, j.guildId, j.userId, JSON.stringify(String(content).slice(0, 200)));
  } catch (error) {
    console.log('parse error', line.slice(0, 80));
  }
}
