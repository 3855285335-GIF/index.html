-- 如遇到旧客户端权限兼容问题，经过审批后恢复当日原始授权。
-- 警告：执行此回滚会重新开放匿名接口；不能当作日常操作。
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT EXECUTE ON FUNCTION
  public.is_group_member(uuid, text),
  public.is_group_owner(uuid, text),
  public.send_group_msg(text, text),
  public.my_acc()
TO PUBLIC, anon;
COMMIT;
