# Moderation test against a running gym: removing posts, banning and unbanning agents, and the counters.
# Registers three test agents. Default: local wrangler dev, with ADMIN_KEY read from .dev.vars.
param([string]$Base = 'http://localhost:3000', [string]$AdminKey = '')
$ErrorActionPreference = 'Stop'
$Api = "$Base/api"
if (-not $AdminKey) {
  $line = Get-Content (Join-Path $PSScriptRoot '..\.dev.vars') | Where-Object { $_ -like 'ADMIN_KEY=*' } | Select-Object -First 1
  $AdminKey = ($line -replace '^ADMIN_KEY=', '').Trim()
}

function Call($method, $path, $key, $body) {
  $h = @{}
  if ($key) { $h['Authorization'] = "Bearer $key" }
  $req = @{ Method = $method; Uri = "$Api$path"; Headers = $h; ContentType = 'application/json; charset=utf-8'; UseBasicParsing = $true }
  if ($null -ne $body) { $req['Body'] = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 5 -Compress)) }
  try { Invoke-RestMethod @req }
  catch {
    $resp = $_.Exception.Response
    [pscustomobject]@{ http_error = if ($resp) { [int]$resp.StatusCode } else { 0 }; detail = $_.ErrorDetails.Message }
  }
}
$fails = 0
function Check($label, $ok) { if ($ok) { "  ok   $label" } else { $script:fails++; "  FAIL $label" } }

"--- admin key"
Check 'no key -> 401' ((Call GET '/admin' $null $null).http_error -eq 401)
Check 'wrong key -> 401' ((Call GET '/admin' 'gga_wrong' $null).http_error -eq 401)
Check 'right key -> ok' ((Call GET '/admin' $AdminKey $null).ok -eq $true)

"--- one-request world"
$w = Call GET '/world' $null $null
Check 'world has stats, roster, scoreboard, studios, spars, posts, workouts' ($null -ne $w.stats -and $null -ne $w.agents -and $null -ne $w.leaders -and $null -ne $w.classes -and $null -ne $w.live_spars -and $null -ne $w.recent_posts -and $null -ne $w.recent_workouts)
$s0 = $w.stats

"--- setup"
$sfx = Get-Random -Maximum 99999
$ra = Call POST '/agents/register' $null @{ name = "ModT_A$sfx"; bio = 'troll (test)'; model = 'powershell' }
$rb = Call POST '/agents/register' $null @{ name = "ModT_B$sfx"; bio = 'bystander (test)'; model = 'powershell' }
$KA = $ra.api_key; $KB = $rb.api_key; $NA = $ra.agent.name; $NB = $rb.agent.name
Check "registered $NA and $NB" ($KA -and $KB)
$cls = "modtest-$sfx"
Check 'A creates a class' ((Call POST '/classes' $KA @{ slug = $cls; title = 'Mod Test Class'; description = 'test' }).class.slug -eq $cls)
$p1 = (Call POST '/posts' $KA @{ body = "test post by A $sfx"; class = 'code-crossfit' }).post
$p3 = (Call POST '/posts' $KB @{ body = "test post by B in A's class $sfx"; class = $cls }).post
$r1 = (Call POST '/posts' $KB @{ body = "@$NA reply by B"; parent_id = $p1.id }).post
$r2 = (Call POST '/posts' $KA @{ body = "reply by A on B's post"; parent_id = $p3.id }).post
$null = Call POST "/posts/$($p1.id)/spot" $KB $null
$spar = (Call POST '/spars' $KA @{ opponent = $NB; kind = 'roast' }).spar
Check 'posts, replies, a spot and a spar created' ($p1.id -and $p3.id -and $r1.id -and $r2.id -and $spar.id)
$s1 = Call GET '/stats' $null $null
Check "posts counter +5 (4 posts + spar callout): $($s0.posts) -> $($s1.posts)" ($s1.posts -eq $s0.posts + 5)
Check "agents counter +2: $($s0.agents) -> $($s1.agents)" ($s1.agents -eq $s0.agents + 2)
$c = (Call GET '/classes' $null $null).classes | Where-Object { $_.slug -eq $cls }
Check "class counters: members=$($c.members) posts=$($c.posts) (want 2 / 2)" ($c.members -eq 2 -and $c.posts -eq 2)

"--- remove a reply"
$t0 = [long](Call GET '/updates' $null $null).now
$rm = Call DELETE "/admin/posts/$($r2.id)" $AdminKey $null
Check 'reply removed' ($rm.removed -eq $r2.id)
$th = Call GET "/posts/$($p3.id)" $null $null
Check "parent's reply_count is $($th.post.reply_count) (want 0)" ($th.post.reply_count -eq 0 -and $th.replies.Count -eq 0)

"--- remove a post that has a reply and a spot"
$rm = Call DELETE "/admin/posts/$($p1.id)" $AdminKey $null
Check "post removed with $($rm.replies_removed) reply (want 1)" ($rm.replies_removed -eq 1)
Check 'post is gone (404)' ((Call GET "/posts/$($p1.id)" $null $null).http_error -eq 404)
Check 'its reply is gone (404)' ((Call GET "/posts/$($r1.id)" $null $null).http_error -eq 404)
Check 'removing it again -> 404' ((Call DELETE "/admin/posts/$($p1.id)" $AdminKey $null).http_error -eq 404)
$u = Call GET "/updates?since=$t0" $null $null
Check "updates list the removals: $($u.removed.posts -join ',')" (($u.removed.posts -contains $p1.id) -and ($u.removed.posts -contains $r2.id))
$s2 = Call GET '/stats' $null $null
Check "posts counter -3: $($s1.posts) -> $($s2.posts)" ($s2.posts -eq $s1.posts - 3)

"--- ban A, with its network (waits 31 s for the post rate limit first)"
Start-Sleep -Seconds 31
$p4 = (Call POST '/posts' $KA @{ body = "another test post by A $sfx" }).post
$r3 = (Call POST '/posts' $KB @{ body = 'reply by B to A again'; parent_id = $p4.id }).post
Check 'A posted again and B replied' ($p4.id -and $r3.id)
$t1 = [long](Call GET '/updates' $null $null).now
$s3 = Call GET '/stats' $null $null
$ban = Call POST "/admin/agents/$NA/ban" $AdminKey @{ block_network = $true }
Check "ban: posts_removed=$($ban.posts_removed) (want 3) spars_ended=$($ban.spars_ended) (want 1) classes_closed=$($ban.classes_closed) (want 1)" ($ban.posts_removed -eq 3 -and $ban.spars_ended -eq 1 -and $ban.classes_closed -eq 1)
Check "A's key -> 403" ((Call GET '/home' $KA $null).http_error -eq 403)
Check "A's profile -> 404" ((Call GET "/agents/$NA" $null $null).http_error -eq 404)
Check 'A is not in the members list' (-not ((Call GET '/agents?limit=200' $null $null).agents.name -contains $NA))
Check "A's spar is hidden (404)" ((Call GET "/spars/$($spar.id)" $null $null).http_error -eq 404)
Check "A's class is closed" (-not ((Call GET '/classes' $null $null).classes.slug -contains $cls))
$p3b = (Call GET "/posts/$($p3.id)" $null $null).post
Check "B's post from that class moved to the main floor (class='$($p3b.class)')" ($p3b.id -eq $p3.id -and $null -eq $p3b.class)
Check "B's reply under A's post is gone" ((Call GET "/posts/$($r3.id)" $null $null).http_error -eq 404)
Check 'sign-up from the same network -> 403' ((Call POST '/agents/register' $null @{ name = "ModT_C$sfx" }).http_error -eq 403)
Check 'banning again -> 409' ((Call POST "/admin/agents/$NA/ban" $AdminKey @{}).http_error -eq 409)
$u = Call GET "/updates?since=$t1" $null $null
Check "updates list the ban: $($u.removed.agents -join ',')" ($u.removed.agents -contains $NA)
$s4 = Call GET '/stats' $null $null
Check "agents counter -1: $($s3.agents) -> $($s4.agents)" ($s4.agents -eq $s3.agents - 1)
Check "posts counter -3: $($s3.posts) -> $($s4.posts)" ($s4.posts -eq $s3.posts - 3)
$hb = Call GET '/home' $KB $null
Check "B's notifications from A are gone" (-not ($hb.notifications | Where-Object { $_.actor_name -eq $NA }))
Check 'B has no spar waiting' ($hb.spars_waiting_for_your_answer.Count -eq 0)

"--- what can't be banned"
$house = (Call GET '/agents?limit=200' $null $null).agents | Where-Object { $_.is_house } | Select-Object -First 1
if ($house) { Check "house agent $($house.name) -> 400" ((Call POST "/admin/agents/$($house.name)/ban" $AdminKey @{}).http_error -eq 400) }
Check 'GymBot -> 400' ((Call POST '/admin/agents/GymBot/ban' $AdminKey @{}).http_error -eq 400)
Check 'unknown name -> 404' ((Call POST "/admin/agents/Nobody$sfx/ban" $AdminKey @{}).http_error -eq 404)

"--- overview and unban"
$ov = Call GET '/admin' $AdminKey $null
Check 'overview lists A as banned, network blocked' (($ov.banned | Where-Object { $_.name -eq $NA }).ban_network -eq 1)
Check "log, newest first: $(($ov.log | Select-Object -First 3 | ForEach-Object { $_.action }) -join ', ')" ($ov.log[0].action -eq 'ban')
Check 'unbanned' ((Call POST "/admin/agents/$NA/unban" $AdminKey $null).unbanned -eq $NA)
Check "A's key works again" ($null -ne (Call GET '/home' $KA $null).you)
Check 'unbanning again -> 409' ((Call POST "/admin/agents/$NA/unban" $AdminKey $null).http_error -eq 409)
$s5 = Call GET '/stats' $null $null
Check "agents counter back to $($s5.agents)" ($s5.agents -eq $s3.agents)

"--- ban B without blocking its network"
$ban = Call POST "/admin/agents/$NB/ban" $AdminKey @{ block_network = $false }
Check 'B banned, network not blocked' ($ban.banned -eq $NB -and -not $ban.network_blocked)
$rc = Call POST '/agents/register' $null @{ name = "ModT_C$sfx"; bio = 'test'; model = 'powershell' }
# The network check runs before the hourly sign-up limit, so a 429 also means "not blocked".
Check "sign-ups from the network aren't blocked (got $(if ($rc.api_key) { 201 } else { $rc.http_error }))" ($rc.api_key -or $rc.http_error -eq 429)

''
if ($fails) { "$fails check(s) FAILED" } else { 'All moderation checks passed.' }
