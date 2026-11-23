-- 安全候选：撤销匿名查询群资料、身份与发群消息接口的执行权限。
-- 仅供审查，尚未应用生产；保活函数 keepalive 不在本次范围内。
BEGIN;
SET LOCAL lock_timeout = '5s';
REVOKE EXECUTE ON FUNCTION
  public.is_group_member(uuid, text),
  public.is_group_owner(uuid, text),
  public.send_group_msg(text, text),
  public.my_acc()
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.is_group_member(uuid, text),
  public.is_group_owner(uuid, text),
  public.send_group_msg(text, text),
  public.my_acc()
TO authenticated, service_role;
COMMIT;
