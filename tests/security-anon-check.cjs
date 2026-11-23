const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const file = name => fs.readFileSync(path.join(root, 'review/security/', name), 'utf8');
const main = file('20261123-匿名函数权限候选.sql');
const rollback = file('20261123-匿名函数权限回滚.sql');
for (const sig of [
  'public.is_group_member(uuid, text)',
  'public.is_group_owner(uuid, text)',
  'public.send_group_msg(text, text)',
  'public.my_acc()'
]) {
  assert.ok(main.includes(sig), '缺少收紧的函数 ' + sig);
  assert.ok(rollback.includes(sig), '回滚不包含 ' + sig);
}
assert.ok(main.includes('REVOKE EXECUTE ON FUNCTION'));
assert.ok(main.includes('FROM PUBLIC, anon;'));
assert.ok(main.includes('GRANT EXECUTE ON FUNCTION'));
assert.ok(main.includes('TO authenticated, service_role;'));
assert.ok(!main.includes('public.keepalive('), '不能收回保活函数的权限');
for (const action of ['DROP ', 'TRUNCATE ', 'DELETE ', 'UPDATE ', 'INSERT ']) {
  assert.ok(!main.includes(action), '权限脚本不得包含数据修改: ' + action);
}
assert.ok(rollback.includes('TO PUBLIC, anon;'));
console.log('匿名执行权限候选静态检查通过；未执行实际数据库权限变更');
