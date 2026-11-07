#!/bin/bash
# 选错项目时（别的项目的数据库）运行 v6 / v7：要报中文错误，并且什么都不改；v5 之后直接跑 v7（跳过 v6）也要提示先跑 v6
set -e
cd "$(dirname "$0")"; SQL=../../sql
D=$(mktemp -d); PORT=5498
initdb -D $D/data -A trust >/dev/null && pg_ctl -D $D/data -o "-p $PORT -k $D" -l $D/log.txt -w start >/dev/null
P="psql -h $D -p $PORT -q"
$P postgres -c "create database other" >/dev/null; $P postgres -c "create database t" >/dev/null
$P other -f stub.sql >/dev/null 2>&1; $P other -c "create table public.players (id int)" >/dev/null   # 别的项目（比如游戏）的数据库
echo "=== 在别的项目里运行 v7："; $P other -f $SQL/6-setup-v7.sql 2>&1 | grep -o "ERROR:.*" | head -1
echo "=== 在别的项目里运行 v6："; $P other -f $SQL/5-setup-v6.sql 2>&1 | grep -o "ERROR:.*" | head -1
echo "=== 别的项目里有没有多出任何东西（应为 0）："; $P other -At -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('set_remark','storage_used','chatter_schema','messages_before_insert')" ; $P other -At -c "select count(*) from pg_tables where schemaname = 'public' and tablename = 'stickers'"
$P t -f stub.sql >/dev/null 2>&1
for f in 1-setup.sql 2-setup-v3.sql 3-setup-v5.sql 4-setup-keepalive.sql; do $P -v ON_ERROR_STOP=1 t -f $SQL/$f >/dev/null 2>&1; done
echo "=== Chatter 数据库还没跑 v6 就跑 v7："; $P t -f $SQL/6-setup-v7.sql -v ON_ERROR_STOP=1 2>&1 | grep -o "ERROR:.*" | head -1
echo "=== 这时 remark 列应该还没有（应为 0）："; $P t -At -c "select count(*) from information_schema.columns where table_name = 'friendships' and column_name = 'remark'"
pg_ctl -D $D/data -m fast stop >/dev/null; rm -rf $D
