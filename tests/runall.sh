#!/bin/bash
# 网页端全部测试（需要 Node 和 Playwright 的 Chromium）。用法：bash tests/runall.sh [遍数，默认 1]
cd "$(dirname "$0")"
python3 ../src/build.py || exit 1
N=${1:-1}; FAILS=0
for i in $(seq 1 $N); do
  for t in smoke vtest chattest chattest2 storetest acctest skew stress difftest cntest mix1 mix2 mix3 hangtest relaytest prtest defaulttest; do
    r=$(node $t.js 2>&1); bad=$(echo "$r" | grep -E 'FAIL|CRASH' | head -2)
    echo "第${i}遍 $t 通过=$(echo "$r" | grep -c '^PASS') $bad"; [ -n "$bad" ] && FAILS=$((FAILS+1))
  done
  r=$(NOWS=1 node prtest.js 2>&1); bad=$(echo "$r" | grep -E 'FAIL|CRASH' | head -2); echo "第${i}遍 prtest（国内网络） 通过=$(echo "$r" | grep -c '^PASS') $bad"; [ -n "$bad" ] && FAILS=$((FAILS+1))
done
node icecheck.js || FAILS=$((FAILS+1))
node pptest.js || FAILS=$((FAILS+1))
echo "全部结束：失败 $FAILS 项"; exit $FAILS
