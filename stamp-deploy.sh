#!/bin/bash
STAMP=$(date +'%Y-%m-%d %H:%M')
sed -i "s|<span id=\"deploy-date\"[^>]*>[^<]*|<span id=\"deploy-date\" style=\"font-size:0.45em;color:#aaa;font-weight:normal\">${STAMP}|" index.html
sed -i "s|onelist-[^']*|onelist-${STAMP}|" sw.js
