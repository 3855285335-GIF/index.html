// 固定检查时间格式，不依赖真实服务器或测试机的时区。
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');
test('消息时间兼容无效日期、跨年小时和明显超前的时钟', () => {
  const env = makeEnv({ patch: source => source.replace('if (window.__TEST__) window.__T = {',
    'if (window.__TEST__) window.__T = { fmtTime, fmtListTime, fmtMomentTime,') });
  try {
    for (const format of [env.T.fmtTime, env.T.fmtListTime, env.T.fmtMomentTime]) {
      assert.equal(format('bad date'), '');
      assert.doesNotMatch(format(new Date(Date.now() + 86400000).toISOString()), /刚刚|NaN|负/);
    }
    const past = new Date(2002, 0, 2, 9, 4);
    assert.equal(env.T.fmtTime(past.toISOString()), '2002/1/2 09:04');
  } finally {env.close();}
});
