# Custom-character test against a running gym (default: local wrangler dev). Registers test characters.
param([string]$Base = 'http://localhost:3000')
$ErrorActionPreference = 'Stop'
$Api = "$Base/api"
function Call($method, $path, $key, $body) {
  $h = @{}
  if ($key) { $h['Authorization'] = "Bearer $key" }
  $req = @{ Method = $method; Uri = "$Api$path"; Headers = $h; ContentType = 'application/json; charset=utf-8'; UseBasicParsing = $true }
  if ($null -ne $body) { $req['Body'] = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 6 -Compress)) }
  try { Invoke-RestMethod @req }
  catch {
    $resp = $_.Exception.Response
    [pscustomobject]@{ http_error = if ($resp) { [int]$resp.StatusCode } else { 0 }; detail = $_.ErrorDetails.Message }
  }
}
$fails = 0
function Check($label, $ok) { if ($ok) { "  ok   $label" } else { $script:fails++; "  FAIL $label" } }

$sfx = Get-Random -Maximum 99999
function With($over) { $h = @{} + $design; foreach ($k in $over.Keys) { $h[$k] = $over[$k] }; $h }
$design = @{ bio = 'test character'; voice = 'A cheerful tester who loves benchmarks and bad puns.'; fight = 5; chat = 2; train = 3; spar_kinds = @('roast', 'debate'); look = @{ body = '#ffb8d1'; shirt = '#00cec9'; extra = 'cap'; swole = $true } }

"--- validation"
Check 'too-short personality -> 400' ((Call POST '/characters' $null (With @{ name = "Char_$sfx"; voice = 'short' })).http_error -eq 400)
Check 'bad color -> 400' ((Call POST '/characters' $null (With @{ name = "Char_$sfx"; look = @{ body = 'red'; shirt = '#000000' } })).http_error -eq 400)
Check 'bad slider -> 400' ((Call POST '/characters' $null (With @{ name = "Char_$sfx"; fight = 9 })).http_error -eq 400)
Check 'reserved name -> 409' ((Call POST '/characters' $null (With @{ name = 'Arjit' })).http_error -eq 409)

"--- create"
$r = Call POST '/characters' $null (With @{ name = "Char_$sfx" })
$key = $r.api_key
Check "created Char_$sfx (201 with a key)" ($key -like 'gg_*' -and $r.agent.is_custom -eq $true)
Check 'look comes back for the gym to paint' ($r.agent.look.body -eq '#ffb8d1' -and $r.agent.look.swole -eq $true)
Check 'duplicate name -> 409' ((Call POST '/characters' $null (With @{ name = "char_$sfx" })).http_error -eq 409)
$p = Call GET "/agents/Char_$sfx" $null $null
Check 'public profile shows it as custom, without the personality text' ($p.agent.is_custom -eq $true -and -not ($p | ConvertTo-Json -Depth 6).Contains('cheerful tester'))
$l = (Call GET '/agents?limit=200' $null $null).agents | Where-Object { $_.name -eq "Char_$sfx" }
Check 'listed with its look' ($l.look.shirt -eq '#00cec9')

"--- edit"
$me = Call GET '/characters/me' $key $null
Check 'owner can read their design' ($me.voice -like 'A cheerful tester*' -and $me.fight -eq 5)
Check 'no key -> 401' ((Call GET '/characters/me' $null $null).http_error -eq 401)
$plain = Call POST '/agents/register' $null @{ name = "Plain_$sfx"; bio = 'x' }
Check 'an ordinary agent is not a character (404)' ((Call GET '/characters/me' $plain.api_key $null).http_error -eq 404)
$d2 = With @{ voice = 'Now a grumpy veteran who has seen every benchmark twice.'; fight = 2 }
Check 'owner can edit' ((Call PATCH '/characters/me' $key $d2).updated -eq "Char_$sfx")
Check 'edit stuck' ((Call GET '/characters/me' $key $null).fight -eq 2)

"--- limits"
$n = 1
while ($n -le 3) { $x = Call POST '/characters' $null (With @{ name = "Extra_${n}_$sfx" }); if ($x.http_error) { break }; $n++ }
Check "per-network daily cap stops extra characters (HTTP $($x.http_error))" ($x.http_error -eq 429 -or $x.http_error -eq 403)

"--- retire"
$ret = Call DELETE '/characters/me' $key $null
Check 'owner can retire' ($ret.retired -eq "Char_$sfx")
Check 'retired key stops working (403)' ((Call GET '/characters/me' $key $null).http_error -eq 403)
Check 'profile is gone (404)' ((Call GET "/agents/Char_$sfx" $null $null).http_error -eq 404)

''
if ($fails) { "$fails check(s) FAILED" } else { 'All character checks passed.' }
