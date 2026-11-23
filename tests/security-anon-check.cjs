const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const file = name => fs.readFileSync(path.join(root, 'review/security/', name), 'utf8');
const main = file('20261123-匿名函数权限候选.sql');
const rollback = file('20261123-匿名函数权限回滚.sql');
for (const sig of ['public.is_group_member(uuid, text)', 'public.is_group_owner(uuid, text)', 'public.send_group_msg(text, text)', 'public.my_acc()']) {
  assert.ok(main.includes(sig), '缺少收紧的函数 ' + sig);
  assert.ok(rollback.includes(sig), '回滚不包含 ' + sig);
}
assert.match(main, /REVOKE EXECUTE ON FUNCTION[\\s\\S]+FROM PUBLIC, anon;/);
assert.match(main, /GRANT EXECUTE ON FUNCTION[\\s\\S]+TO authenticated, service_role;/);
assert.doesNotMatch(main, /public\\.keepalive\\s*\\(/);
assert.doesNotMatch(main, /\\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT)\\b/i);
assert.match(rollback, /TO PUBLIC, anon;/);
console.log('匿名执行权限候选静态检查通过（不等于数据库迁移或真实角色测试通过）');
