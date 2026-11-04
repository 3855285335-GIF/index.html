-- ============================================================
-- 换中转服务器（TURN）账号 / 服务商：只改下面这段再运行，网页不用重新上传
-- 用法：Supabase 控制台 → SQL Editor → New query → 粘贴 → 改好 → Run
-- 规则：排在前面的是主力，后面的是备用；最多 4 家，每家最多 4 个地址；
--       地址只能是 turn: 或 turns: 开头；用户名和密码不能留空，也不能带 < >。
-- 手机端下次打开 App（或下次登录）时读取新配置。
-- ============================================================

-- 注意：浏览器选中转时按协议定优先级（UDP 2 > TCP 1 > TLS 0），列表顺序只在同一种协议之间起作用。
--       国内不开 VPN 时 ExpressTURN 的 UDP 不通、TCP 通，所以 Metered 不能放 UDP 地址，
--       否则手机会优先走 Metered 的 UDP（每月只有 500MB）。Metered 只留 TLS 443。
insert into public.app_config (key, value) values ('ice', '{
  "turn": [
    {"name": "ExpressTURN", "username": "000000002109207283", "credential": "F2O3wiOhufam3ieQHr7cTrp77u0=", "urls": ["turn:free.expressturn.com:3478?transport=udp", "turn:free.expressturn.com:3478?transport=tcp"]},
    {"name": "Metered", "username": "8e04f6769d4effbe70fb66f7", "credential": "z8AVqW5ZnBQ0zgNV", "urls": ["turns:global.relay.metered.ca:443?transport=tcp"]}
  ]
}'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();
