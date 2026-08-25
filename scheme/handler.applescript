on open location theURL
  set q to quoted form of theURL
  set viaServer to "/usr/bin/curl -sfG --max-time 5 --data-urlencode uri=" & q & " http://127.0.0.1:47831/focus"
  set fallback to "/opt/homebrew/bin/bun " & quoted form of "/Users/bb00/workspace/orcatab/src/focus.ts" & " " & q
  do shell script viaServer & " || " & fallback
end open location
