// 复现：真实 Service 是否能被兄弟插件 inject 到
const { Context } = require('koishi');
const { QQGroupManagerService } = require('D:/agent项目/nestim-qq-group-manager/lib/service.js');

const app = new Context();
const config = {
  platformFilter: ['onebot'],
  command: '[bot]',
  groupRules: [],
  allowedUserIds: [],
  enableAiReply: false,
  aiAgentName: 'MeowBot',
};

const pluginA = {
  name: 'a',
  apply(ctx) {
    const service = new QQGroupManagerService(ctx, config);
    console.log('A applied, has aiHooks:', !!service.aiHooks);
  },
};

const pluginB = {
  name: 'b',
  inject: ['qqgmAiHooks'],
  apply(ctx) {
    console.log('B applied, hooks:', !!ctx.qqgmAiHooks, 'version:', ctx.qqgmAiHooks && ctx.qqgmAiHooks.version);
  },
};

const pluginC = {
  name: 'c',
  apply(ctx) {
    console.log('C applied, root.get:', !!(ctx.root.get && ctx.root.get('nestimQqGroupManager')));
  },
};

app.plugin(pluginA);
app.plugin(pluginB);
app.plugin(pluginC);

app.start().then(() => {
  setTimeout(() => process.exit(0), 800);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
