// 验证 Koishi 里兄弟插件的 inject 是否能拿到对方 ctx.set 的服务
const { Context } = require('koishi');

const app = new Context();
const log = (...args) => console.log(...args);

const pluginA = {
  name: 'a',
  apply(ctx) {
    log('A applied, ctx is root?', ctx === ctx.root);
    ctx.set('foo', { value: 42 });
  },
};

const pluginB = {
  name: 'b',
  inject: ['foo'],
  apply(ctx) {
    log('B applied (inject satisfied), foo=', ctx.foo);
  },
};

const pluginC = {
  name: 'c',
  apply(ctx) {
    log('C applied, root.get(foo)=', ctx.root.get && ctx.root.get('foo'));
  },
};

app.plugin(pluginA);
app.plugin(pluginB);
app.plugin(pluginC);

app.start().then(() => {
  setTimeout(() => {
    log('root has foo?', !!(app.get && app.get('foo')));
    process.exit(0);
  }, 500);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
