#!/bin/bash
# 用本机 PostgreSQL 16 真实运行全部 SQL：stub.sql 模拟 Supabase 的 auth / storage / realtime。
# 用法：bash tests/sql/run-sql-tests.sh   （需要 initdb / pg_ctl / psql，不能用 root 身份运行 postgres）
set -e
cd "$(dirname "$0")"; SQL=../../sql
D=$(mktemp -d); PORT=5499
initdb -D $D/data -A trust >/dev/null && pg_ctl -D $D/data -o "-p $PORT -k $D" -l $D/log.txt -w start >/dev/null
P="psql -h $D -p $PORT -v ON_ERROR_STOP=1 -q"
$P postgres -c "create database t"
$P t -f stub.sql 2>/dev/null
for f in $SQL/1-setup.sql $SQL/2-setup-v3.sql $SQL/3-setup-v5.sql $SQL/3-setup-v5.sql $SQL/4-setup-keepalive.sql $SQL/update-turn.sql $SQL/5-setup-v6.sql $SQL/5-setup-v6.sql; do $P t -f $f >/dev/null 2>&1 && echo "✅ 运行成功：$(basename $f)"; done
$P t -f seed.sql >/dev/null && echo "✅ 测试账号已建好"
echo "--- 行为测试（看输出里的期望值）"
for f in beh.sql ka.sql v4.sql v5chk.sql v6chk.sql; do echo "=== $f"; psql -h $D -p $PORT -q t -f $f 2>&1 | grep -v '^$'; done
pg_ctl -D $D/data stop >/dev/null; rm -rf $D
