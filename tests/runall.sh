#!/bin/bash
# 网页端全部测试（需要 Node 和 Playwright 的 Chromium）。用法：bash tests/runall.sh [遍数，默认 1]
# 最后会打印一共跑了几项、失败几项（不要手数）。
cd "$(dirname "$0")"
python3 ../src/build.py || exit 1
N=${1:-1}; FAILS=0; ITEMS=0
SUITES="smoke vtest chattest chattest2 storetest acctest skew stress difftest cntest mix1 mix2 mix3 hangtest relaytest prtest defaulttest metab stktest nov6test"
run() { # 名称 命令...
  local name=$1; shift; local r; r=$("$@" 2>&1); local bad; bad=$(echo "$r" | grep -E 'FAIL|CRASH' | head -2)
  ITEMS=$((ITEMS+1)); echo "$name 通过=$(echo "$r" | grep -c '^PASS') $bad"; [ -n "$bad" ] && FAILS=$((FAILS+1))
}
for i in $(seq 1 $N); do
  for t in $SUITES; do run "第${i}遍 $t" node $t.js; done
  run "第${i}遍 prtest（国内网络）" env NOWS=1 node prtest.js
done
run "检查 configcheck（中转列表一致、Metered 无 UDP、STUN）" node configcheck.js
run "检查 icecheck（服务器地址格式）" node icecheck.js
run "检查 pptest（依赖库加载）" node pptest.js
echo "全部结束：一共 $ITEMS 项（每遍 $(echo $SUITES | wc -w) 组网页测试 + 1 组国内网络在线状态，最后 3 项检查），失败 $FAILS 项"; exit $FAILS
