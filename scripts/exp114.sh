set -u
r=node_modules/@ai-ecoverse/slicc-shared-web/harness/recorder.mjs
sed -i "/Profiler.startPreciseCoverage/d" $r
grep -n "Profiler\." $r | head -12
f=0
for i in 1 2 3 4; do
  echo "=== chat run $i"
  node --test --test-concurrency=1 --test-timeout=600000 --test-global-setup=node_modules/@ai-ecoverse/slicc-shared-web/harness/global.mjs test/integration/chat.test.mjs || f=1
done
exit $f
