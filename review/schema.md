# 线上数据库现状（自动导出，2026-11-13）

项目 uaoiqbxptnbrvkzjwguc

## 表结构
```json
HTTP 201
[
  {
    "table_name": "app_config",
    "columns": "key text, value jsonb, updated_at timestamp with time zone"
  },
  {
    "table_name": "chat_backgrounds",
    "columns": "owner_acc text, peer_acc text, url text, updated_at timestamp with time zone"
  },
  {
    "table_name": "chat_group_members",
    "columns": "group_id uuid, account_id text, role text, joined_at timestamp with time zone, title text, title_on boolean, muted_until timestamp with time zone"
  },
  {
    "table_name": "chat_groups",
    "columns": "id uuid, name text, owner_acc text, created_at timestamp with time zone, avatar_url text, mute_all boolean, join_approval boolean, notice text, notice_at timestamp with time zone, notice_by text"
  },
  {
    "table_name": "conversations",
    "columns": "owner_acc text, conv_key text, peer_acc text, last_body text, last_ts timestamp with time zone, last_read_ts timestamp with time zone, unread integer"
  },
  {
    "table_name": "friend_requests",
    "columns": "id uuid, from_acc text, to_acc text, from_name text, verify text, status text, created_at timestamp with time zone"
  },
  {
    "table_name": "friendships",
    "columns": "owner_acc text, friend_acc text, created_at timestamp with time zone, remark text"
  },
  {
    "table_name": "group_call_members",
    "columns": "call_id uuid, acc text, joined_at timestamp with time zone, left_at timestamp with time zone, muted boolean, seen_at timestamp with time zone"
  },
  {
    "table_name": "group_calls",
    "columns": "id uuid, group_id uuid, host_acc text, created_at timestamp with time zone, ended_at timestamp with time zone"
  },
  {
    "table_name": "group_files",
    "columns": "id uuid, group_id uuid, uploader text, name text, size bigint, mime text, path text, created_at timestamp with time zone"
  },
  {
    "table_name": "group_invites",
    "columns": "id uuid, group_id uuid, from_acc text, to_acc text, status text, created_at timestamp with time zone, responded_at timestamp with time zone, approved_by text, approved_at timestamp with time zone"
  },
  {
    "table_name": "keepalive_state",
    "columns": "id integer, last_ping timestamp with time zone, pings bigint"
  },
  {
    "table_name": "messages",
    "columns": "id uuid, conv_key text, from_acc text, to_acc text, type text, body text, dur integer, created_at timestamp with time zone, mentions jsonb"
  },
  {
    "table_name": "moment_comments",
    "columns": "id uuid, moment_id uuid, author_acc text, body text, created_at timestamp with time zone, parent_id uuid, reply_to_acc text"
  },
  {
    "table_name": "moment_likes",
    "columns": "moment_id uuid, account_id text, created_at timestamp with time zone"
  },
  {
    "table_name": "moment_views",
    "columns": "id uuid, moment_id uuid, viewer_acc text, created_at timestamp with time zone"
  },
  {
    "table_name": "moments",
    "columns": "id uuid, author_acc text, body text, images jsonb, visibility text, created_at timestamp with time zone, visible_to text[], video text"
  },
  {
    "table_name": "presence",
    "columns": "account_id text, last_seen timestamp with time zone"
  },
  {
    "table_name": "profiles",
    "columns": "id uuid, account_id text, nickname text, avatar_url text, signature text, created_at timestamp with time zone, bg_url text, moments_seen_at timestamp with time zone, cover_url text, mutes jsonb"
  },
  {
    "table_name": "push_keys",
    "columns": "id integer, pub text, priv text, created_at timestamp with time zone"
  },
  {
    "table_name": "push_log",
    "columns": "ref text, from_acc text, to_acc text, at timestamp with time zone"
  },
  {
    "table_name": "push_subs",
    "columns": "endpoint text, acc text, p256dh text, auth text, preview boolean, created_at timestamp with time zone, updated_at timestamp with time zone"
  },
  {
    "table_name": "signals",
    "columns": "id bigint, to_acc text, from_acc text, payload jsonb, created_at timestamp with time zone"
  },
  {
    "table_name": "stickers",
    "columns": "id uuid, owner_acc text, url text, kw text, created_at timestamp with time zone"
  }
]

```

## RLS 策略
```json
HTTP 201
[
  {
    "tablename": "app_config",
    "policyname": "app_config_read",
    "cmd": "SELECT",
    "qual": "true",
    "with_check": null
  },
  {
    "tablename": "chat_backgrounds",
    "policyname": "chat_bg_delete",
    "cmd": "DELETE",
    "qual": "(owner_acc = my_acc())",
    "with_check": null
  },
  {
    "tablename": "chat_backgrounds",
    "policyname": "chat_bg_insert",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "(owner_acc = my_acc())"
  },
  {
    "tablename": "chat_backgrounds",
    "policyname": "chat_bg_select",
    "cmd": "SELECT",
    "qual": "(owner_acc = my_acc())",
    "with_check": null
  },
  {
    "tablename": "chat_backgrounds",
    "policyname": "chat_bg_update",
    "cmd": "UPDATE",
    "qual": "(owner_acc = my_acc())",
    "with_check": "(owner_acc = my_acc())"
  },
  {
    "tablename": "chat_group_members",
    "policyname": "cgm_del",
    "cmd": "DELETE",
    "qual": "((account_id = my_acc()) OR (EXISTS ( SELECT 1\n   FROM chat_groups g\n  WHERE ((g.id = chat_group_members.group_id) AND (g.owner_acc = my_acc())))))",
    "with_check": null
  },
  {
    "tablename": "chat_group_members",
    "policyname": "cgm_ins",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "((account_id = my_acc()) AND (is_group_owner(group_id, my_acc()) OR is_group_member(group_id, my_acc())))"
  },
  {
    "tablename": "chat_group_members",
    "policyname": "cgm_read",
    "cmd": "SELECT",
    "qual": "is_group_member(group_id, my_acc())",
    "with_check": null
  },
  {
    "tablename": "chat_groups",
    "policyname": "grp_del",
    "cmd": "DELETE",
    "qual": "(owner_acc = my_acc())",
    "with_check": null
  },
  {
    "tablename": "chat_groups",
    "policyname": "grp_ins",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "(owner_acc = my_acc())"
  },
  {
    "tablename": "chat_groups",
    "policyname": "grp_read",
    "cmd": "SELECT",
    "qual": "is_group_member(id, my_acc())",
    "with_check": null
  },
  {
    "tablename": "conversations",
    "policyname": "conv_delete",
    "cmd": "DELETE",
    "qual": "(owner_acc = my_acc())",
    "with_check": null
  },
  {
    "tablename": "conversations",
    "policyname": "conv_insert",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "((owner_acc = my_acc()) AND ((conv_key = conv_key_of(owner_acc, peer_acc)) OR ((\"left\"(conv_key, 2) = 'g:'::text) AND (conv_key = peer_acc) AND is_group_member((SUBSTRING(conv_key FROM 3))::uuid, my_acc()))))"
  },
  {
    "tablename": "conversations",
    "policyname": "conv_select",
    "cmd": "SELECT",
    "qual": "(owner_acc = my_acc())",
    "with_check": null
  },
  {
    "tablename": "conversations",
    "policyname": "conv_update",
    "cmd": "UPDATE",
    "qual": "(owner_acc = my_acc())",
    "with_check": "((owner_acc = my_acc()) AND ((conv_key = conv_key_of(owner_acc, peer_acc)) OR ((\"left\"(conv_key, 2) = 'g:'::text) AND (conv_key = peer_acc) AND is_group_member((SUBSTRING(conv_key FROM 3))::uuid, my_acc()))))"
  },
  {
    "tablename": "friend_requests",
    "policyname": "fr_select",
    "cmd": "SELECT",
    "qual": "((to_acc = my_acc()) OR (from_acc = my_acc()))",
    "with_check": null
  },
  {
    "tablename": "friend_requests",
    "policyname": "fr_update",
    "cmd": "UPDATE",
    "qual": "(to_acc = my_acc())",
    "with_check": "(to_acc = my_acc())"
  },
  {
    "tablename": "friendships",
    "policyname": "fs_select",
    "cmd": "SELECT",
    "qual": "(owner_acc = my_acc())",
    "with_check": null
  },
  {
    "tablename": "group_files",
    "policyname": "gf_delete",
    "cmd": "DELETE",
    "qual": "((uploader = my_acc()) OR (EXISTS ( SELECT 1\n   FROM chat_group_members m\n  WHERE ((m.group_id = group_files.group_id) AND (m.account_id = my_acc()) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))))",
    "with_check": null
  },
  {
    "tablename": "group_files",
    "policyname": "gf_insert",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "((uploader = my_acc()) AND is_group_member(group_id, my_acc()))"
  },
  {
    "tablename": "group_files",
    "policyname": "gf_select",
    "cmd": "SELECT",
    "qual": "is_group_member(group_id, my_acc())",
    "with_check": null
  },
  {
    "tablename": "group_invites",
    "policyname": "gi_select",
    "cmd": "SELECT",
    "qual": "((to_acc = my_acc()) OR (from_acc = my_acc()) OR is_group_member(group_id, my_acc()))",
    "with_check": null
  },
  {
    "tablename": "messages",
    "policyname": "msg_grp_ins",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "((conv_key ~~ 'g:%'::text) AND (from_acc = my_acc()) AND (EXISTS ( SELECT 1\n   FROM chat_group_members m\n  WHERE ((m.group_id = (SUBSTRING(messages.conv_key FROM 3))::uuid) AND (m.account_id = my_acc())))))"
  },
  {
    "tablename": "messages",
    "policyname": "msg_grp_read",
    "cmd": "SELECT",
    "qual": "((conv_key ~~ 'g:%'::text) AND (EXISTS ( SELECT 1\n   FROM chat_group_members m\n  WHERE ((m.group_id = (SUBSTRING(messages.conv_key FROM 3))::uuid) AND (m.account_id = my_acc())))))",
    "with_check": null
  },
  {
    "tablename": "messages",
    "policyname": "msg_insert",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "((from_acc = my_acc()) AND (EXISTS ( SELECT 1\n   FROM friendships f\n  WHERE ((f.owner_acc = messages.from_acc) AND (f.friend_acc = messages.to_acc)))))"
  },
  {
    "tablename": "messages",
    "policyname": "msg_select",
    "cmd": "SELECT",
    "qual": "((from_acc = my_acc()) OR (to_acc = my_acc()))",
    "with_check": null
  },
  {
    "tablename": "messages",
    "policyname": "msg_self_ins",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "((from_acc = my_acc()) AND (to_acc = my_acc()))"
  },
  {
    "tablename": "messages",
    "policyname": "msg_update",
    "cmd": "UPDATE",
    "qual": "(from_acc = my_acc())",
    "with_check": "(from_acc = my_acc())"
  },
  {
    "tablename": "moment_comments",
    "policyname": "moment_comments_delete",
    "cmd": "DELETE",
    "qual": "((author_acc = my_acc()) OR (EXISTS ( SELECT 1\n   FROM moments m\n  WHERE ((m.id = moment_comments.moment_id) AND (m.author_acc = my_acc())))))",
    "with_check": null
  },
  {
    "tablename": "moment_comments",
    "policyname": "moment_comments_insert",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "((author_acc = my_acc()) AND can_see_moment(moment_id, my_acc()))"
  },
  {
    "tablename": "moment_comments",
    "policyname": "moment_comments_select",
    "cmd": "SELECT",
    "qual": "can_see_moment(moment_id, my_acc())",
    "with_check": null
  },
  {
    "tablename": "moment_likes",
    "policyname": "moment_likes_delete",
    "cmd": "DELETE",
    "qual": "(account_id = my_acc())",
    "with_check": null
  },
  {
    "tablename": "moment_likes",
    "policyname": "moment_likes_insert",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "((account_id = my_acc()) AND can_see_moment(moment_id, my_acc()))"
  },
  {
    "tablename": "moment_likes",
    "policyname": "moment_likes_select",
    "cmd": "SELECT",
    "qual": "can_see_moment(moment_id, my_acc())",
    "with_check": null
  },
  {
    "tablename": "moment_views",
    "policyname": "mv_ins",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "((viewer_acc = my_acc()) AND can_see_moment(moment_id, my_acc()))"
  },
  {
    "tablename": "moment_views",
    "policyname": "mv_sel",
    "cmd": "SELECT",
    "qual": "(EXISTS ( SELECT 1\n   FROM moments m\n  WHERE ((m.id = moment_views.moment_id) AND (m.author_acc = my_acc()))))",
    "with_check": null
  },
  {
    "tablename": "moments",
    "policyname": "moments_delete",
    "cmd": "DELETE",
    "qual": "(author_acc = my_acc())",
    "with_check": null
  },
  {
    "tablename": "moments",
    "policyname": "moments_insert",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "(author_acc = my_acc())"
  },
  {
    "tablename": "moments",
    "policyname": "moments_select",
    "cmd": "SELECT",
    "qual": "((author_acc = my_acc()) OR ((visibility = 'friends'::text) AND (EXISTS ( SELECT 1\n   FROM friendships f\n  WHERE ((f.owner_acc = my_acc()) AND (f.friend_acc = moments.author_acc)))) AND ((visible_to IS NULL) OR (my_acc() = ANY (visible_to)))))",
    "with_check": null
  },
  {
    "tablename": "moments",
    "policyname": "moments_update",
    "cmd": "UPDATE",
    "qual": "(author_acc = my_acc())",
    "with_check": "(author_acc = my_acc())"
  },
  {
    "tablename": "profiles",
    "policyname": "profiles_insert",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "(id = auth.uid())"
  },
  {
    "tablename": "profiles",
    "policyname": "profiles_select",
    "cmd": "SELECT",
    "qual": "true",
    "with_check": null
  },
  {
    "tablename": "profiles",
    "policyname": "profiles_update",
    "cmd": "UPDATE",
    "qual": "(id = auth.uid())",
    "with_check": "(id = auth.uid())"
  },
  {
    "tablename": "stickers",
    "policyname": "stickers_delete",
    "cmd": "DELETE",
    "qual": "(owner_acc = my_acc())",
    "with_check": null
  },
  {
    "tablename": "stickers",
    "policyname": "stickers_insert",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "((owner_acc = my_acc()) AND (POSITION(((('/storage/v1/object/public/chat-media/'::text || my_acc()) || '/'::text)) IN (url)) > 0) AND (( SELECT count(*) AS count\n   FROM stickers s\n  WHERE (s.owner_acc = my_acc())) < 500))"
  },
  {
    "tablename": "stickers",
    "policyname": "stickers_select",
    "cmd": "SELECT",
    "qual": "(owner_acc = my_acc())",
    "with_check": null
  },
  {
    "tablename": "stickers",
    "policyname": "stickers_update",
    "cmd": "UPDATE",
    "qual": "(owner_acc = my_acc())",
    "with_check": "(owner_acc = my_acc())"
  }
]

```

## 函数
```json
HTTP 201
[
  {
    "proname": "accept_friend_request",
    "args": "p_req_id text",
    "security_definer": true
  },
  {
    "proname": "accept_group_invite",
    "args": "p_id uuid",
    "security_definer": true
  },
  {
    "proname": "account_exists",
    "args": "p_acc text",
    "security_definer": true
  },
  {
    "proname": "bootstrap",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "can_see_moment",
    "args": "p_moment uuid, p_acc text",
    "security_definer": true
  },
  {
    "proname": "chatter_schema",
    "args": "",
    "security_definer": false
  },
  {
    "proname": "conv_key_of",
    "args": "a text, b text",
    "security_definer": false
  },
  {
    "proname": "decline_group_invite",
    "args": "p_id uuid",
    "security_definer": true
  },
  {
    "proname": "friends_seen",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "group_call_join",
    "args": "p_gid uuid",
    "security_definer": true
  },
  {
    "proname": "group_call_leave",
    "args": "p_cid uuid",
    "security_definer": true
  },
  {
    "proname": "group_call_mute",
    "args": "p_cid uuid, p_muted boolean",
    "security_definer": true
  },
  {
    "proname": "group_call_state",
    "args": "p_gid uuid",
    "security_definer": true
  },
  {
    "proname": "group_call_touch",
    "args": "p_cid uuid",
    "security_definer": true
  },
  {
    "proname": "group_delete_cleanup",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "group_invite_accept",
    "args": "p_id uuid",
    "security_definer": true
  },
  {
    "proname": "group_invite_approve",
    "args": "p_id uuid, p_ok boolean",
    "security_definer": true
  },
  {
    "proname": "group_join_requests",
    "args": "p_gid uuid",
    "security_definer": true
  },
  {
    "proname": "group_member_cleanup",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "group_member_conv",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "group_mute_guard",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "guard_all_mention",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "handle_new_user",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "heartbeat",
    "args": "p_online boolean",
    "security_definer": true
  },
  {
    "proname": "invite_to_group",
    "args": "p_gid uuid, p_acc text",
    "security_definer": true
  },
  {
    "proname": "is_group_member",
    "args": "gid uuid, acc text",
    "security_definer": true
  },
  {
    "proname": "is_group_owner",
    "args": "gid uuid, acc text",
    "security_definer": true
  },
  {
    "proname": "keepalive",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "kick_group_member",
    "args": "p_gid uuid, p_acc text",
    "security_definer": true
  },
  {
    "proname": "mark_read",
    "args": "p_conv text",
    "security_definer": true
  },
  {
    "proname": "messages_after_insert",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "messages_after_update",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "messages_before_insert",
    "args": "",
    "security_definer": false
  },
  {
    "proname": "messages_before_update",
    "args": "",
    "security_definer": false
  },
  {
    "proname": "my_acc",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "my_group_invites",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "peer_read",
    "args": "p_conv text",
    "security_definer": true
  },
  {
    "proname": "poll_inbox",
    "args": "p_since timestamp with time zone, p_wait_ms integer",
    "security_definer": true
  },
  {
    "proname": "push_gone",
    "args": "p_endpoints text[]",
    "security_definer": true
  },
  {
    "proname": "push_job",
    "args": "p_uid uuid, p_kind text, p_ref text, p_to text",
    "security_definer": true
  },
  {
    "proname": "push_job_base",
    "args": "p_uid uuid, p_kind text, p_ref text, p_to text",
    "security_definer": true
  },
  {
    "proname": "push_remove",
    "args": "p_endpoint text",
    "security_definer": true
  },
  {
    "proname": "push_save",
    "args": "p_endpoint text, p_p256dh text, p_auth text, p_preview boolean",
    "security_definer": true
  },
  {
    "proname": "push_set_vapid",
    "args": "p_pub text, p_priv text",
    "security_definer": true
  },
  {
    "proname": "push_status",
    "args": "p_endpoint text",
    "security_definer": true
  },
  {
    "proname": "push_vapid",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "refresh_conv_last_message",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "register_user",
    "args": "p_acc text, p_pass text, p_name text",
    "security_definer": true
  },
  {
    "proname": "remove_friendship",
    "args": "p_me text, p_peer text",
    "security_definer": true
  },
  {
    "proname": "send_friend_request",
    "args": "p_to text",
    "security_definer": true
  },
  {
    "proname": "send_friend_request",
    "args": "p_from text, p_to text, p_from_name text",
    "security_definer": true
  },
  {
    "proname": "send_group_msg",
    "args": "conv text, msg text",
    "security_definer": true
  },
  {
    "proname": "send_signal",
    "args": "p_to text, p_payload jsonb",
    "security_definer": true
  },
  {
    "proname": "set_group_admin",
    "args": "p_gid uuid, p_acc text, p_on boolean",
    "security_definer": true
  },
  {
    "proname": "set_group_avatar",
    "args": "p_gid uuid, p_url text",
    "security_definer": true
  },
  {
    "proname": "set_group_join_approval",
    "args": "p_gid uuid, p_on boolean",
    "security_definer": true
  },
  {
    "proname": "set_group_member_mute",
    "args": "p_gid uuid, p_acc text, p_minutes integer",
    "security_definer": true
  },
  {
    "proname": "set_group_mute_all",
    "args": "p_gid uuid, p_on boolean",
    "security_definer": true
  },
  {
    "proname": "set_group_name",
    "args": "p_gid uuid, p_name text",
    "security_definer": true
  },
  {
    "proname": "set_group_notice",
    "args": "p_gid uuid, p_text text",
    "security_definer": true
  },
  {
    "proname": "set_member_title",
    "args": "p_gid uuid, p_acc text, p_title text",
    "security_definer": true
  },
  {
    "proname": "set_remark",
    "args": "p_friend text, p_remark text",
    "security_definer": true
  },
  {
    "proname": "set_title_visible",
    "args": "p_gid uuid, p_visible boolean",
    "security_definer": true
  },
  {
    "proname": "storage_used",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "sync_conversation_on_message",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "take_signals",
    "args": "",
    "security_definer": true
  },
  {
    "proname": "transfer_group_owner",
    "args": "p_gid uuid, p_acc text",
    "security_definer": true
  }
]

```

## 触发器
```json
HTTP 201
[
  {
    "tbl": "chat_group_members",
    "trigger_name": "trg_group_member_cleanup",
    "action_timing": "AFTER",
    "event_manipulation": "DELETE"
  },
  {
    "tbl": "chat_group_members",
    "trigger_name": "trg_group_member_conv",
    "action_timing": "AFTER",
    "event_manipulation": "INSERT"
  },
  {
    "tbl": "chat_groups",
    "trigger_name": "trg_group_delete_cleanup",
    "action_timing": "AFTER",
    "event_manipulation": "DELETE"
  },
  {
    "tbl": "messages",
    "trigger_name": "trg_guard_all_mention",
    "action_timing": "BEFORE",
    "event_manipulation": "INSERT"
  },
  {
    "tbl": "messages",
    "trigger_name": "trg_messages_after_insert",
    "action_timing": "AFTER",
    "event_manipulation": "INSERT"
  },
  {
    "tbl": "messages",
    "trigger_name": "trg_messages_after_update",
    "action_timing": "AFTER",
    "event_manipulation": "UPDATE"
  },
  {
    "tbl": "messages",
    "trigger_name": "trg_messages_before_insert",
    "action_timing": "BEFORE",
    "event_manipulation": "INSERT"
  },
  {
    "tbl": "messages",
    "trigger_name": "trg_messages_before_update",
    "action_timing": "BEFORE",
    "event_manipulation": "UPDATE"
  },
  {
    "tbl": "messages",
    "trigger_name": "trg_refresh_conv_last",
    "action_timing": "AFTER",
    "event_manipulation": "DELETE"
  },
  {
    "tbl": "messages",
    "trigger_name": "trg_refresh_conv_last",
    "action_timing": "AFTER",
    "event_manipulation": "INSERT"
  },
  {
    "tbl": "messages",
    "trigger_name": "trg_sync_conversation_on_message",
    "action_timing": "AFTER",
    "event_manipulation": "INSERT"
  },
  {
    "tbl": "messages",
    "trigger_name": "trg_zz_group_mute_guard",
    "action_timing": "BEFORE",
    "event_manipulation": "INSERT"
  }
]

```

## 存储桶
```json
HTTP 201
[
  {
    "id": "chat-media",
    "name": "chat-media",
    "public": true
  }
]

```
