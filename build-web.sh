#!/usr/bin/env bash
# Builds the phone web app into docs/ (served by GitHub Pages).
set -e
cd "$(dirname "$0")"
rm -rf docs && mkdir docs
cp web/* docs/
cp src/app.js src/recur.js src/sync.js src/cloud.js src/themes.js src/styles.css docs/
rm -f docs/build-web.sh
touch docs/.nojekyll
# New cache name each build so phones pick up updates.
sed -i "s/hover-calendar-v1/hover-calendar-$(date +%s)/" docs/sw.js
echo "Built docs/"
