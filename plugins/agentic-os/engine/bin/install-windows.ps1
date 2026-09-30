# agentic-os workspace setup for Windows, for people without git access to the code.
#
# Not run directly: `snapshot.mjs publish` wraps it in Install-<name>.cmd with this
# workspace's source filled in (the __AOS_CONFIG__ line) and uploads it next to the
# snapshot. Running it (again) sets up or updates, for this user only, no admin:
#
#   1. Node.js (the dashboard's floor or newer): the one on PATH, else a portable copy
#      in %LOCALAPPDATA%\agentic-os\node, checked against nodejs.org's SHASUMS256
#   2. Claude Code: on PATH or in ~\.local\bin, else Anthropic's installer (install.ps1)
#   3. The source's key (Confluence: email + API token; web server: its key), once
#   4. workspace.zip + the built dashboard UI, extracted into the folder you pick
#      (never over a git clone; your .claude\ledger and downloaded repos are kept)
#   5. the dashboard started, the reader profile set, Download code started, and a
#      desktop shortcut that starts it again
#
# Windows PowerShell 5.1 compatible, ASCII only. For testing: AOS_DIR (the folder),
# AOS_YES=1 (no questions), AOS_CONFLUENCE_KEY / AOS_HTTP_KEY (the key), DASHBOARD_PORT,
# AOS_NO_SHORTCUT=1 (no desktop shortcut).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$cfg = ConvertFrom-Json @'
__AOS_CONFIG__
'@

function Say($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Done($text) { Write-Host "   $text" -ForegroundColor Green }
function Fail($text) {
  Write-Host ''
  Write-Host $text -ForegroundColor Red
  if (-not $env:AOS_YES) { Read-Host 'Press Enter to close' | Out-Null }
  exit 1
}
function Ask($question, $default) {
  if ($env:AOS_YES) { return $default }
  $a = Read-Host "$question [$default]"
  if ([string]::IsNullOrWhiteSpace($a)) { return $default }
  return $a.Trim()
}
function Version-Of($exe) {
  try {
    $v = & $exe --version 2>$null
    if ($v -match 'v?(\d+)\.(\d+)\.(\d+)') { return [version]"$($matches[1]).$($matches[2]).$($matches[3])" }
  } catch {}
  return $null
}
function Add-UserPath($folder) {
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ((($user -split ';') | Where-Object { $_ -eq $folder }).Count -eq 0) {
    [Environment]::SetEnvironmentVariable('Path', (($folder, $user) -join ';').TrimEnd(';'), 'User')
  }
  if ((($env:Path -split ';') | Where-Object { $_ -eq $folder }).Count -eq 0) { $env:Path = "$folder;$env:Path" }
}

Write-Host "Setting up the $($cfg.name) workspace: the code and the dashboard, read-only." -ForegroundColor White
Write-Host 'Everything installs for you only; no administrator rights are needed.'

# ---------------------------------------------------------------- folder
$defaultDir = if ($env:AOS_DIR) { $env:AOS_DIR } else { Join-Path $env:USERPROFILE $cfg.folder }
$dir = Ask 'Folder for the workspace' $defaultDir
if (Test-Path (Join-Path $dir '.git')) { Fail "$dir is a git clone. This installer only sets up downloaded copies; pick another folder." }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$ledger = Join-Path $dir '.claude\ledger'
New-Item -ItemType Directory -Force -Path $ledger | Out-Null

# ---------------------------------------------------------------- Node.js
Say 'Node.js'
$minNode = [version]$cfg.nodeMin
$node = $null
$onPath = Get-Command node -ErrorAction SilentlyContinue
if ($onPath -and (Version-Of $onPath.Source) -ge $minNode) { $node = $onPath.Source }
$portable = Join-Path $env:LOCALAPPDATA 'agentic-os\node'
if (-not $node -and (Test-Path (Join-Path $portable 'node.exe')) -and (Version-Of (Join-Path $portable 'node.exe')) -ge $minNode) { $node = Join-Path $portable 'node.exe' }
if (-not $node) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  Write-Host "   Downloading Node.js $($cfg.nodeMin) or newer for Windows $arch..."
  $index = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
  $release = $index | Where-Object { $_.lts -and ($_.files -contains "win-$arch-zip") -and ([version]$_.version.TrimStart('v')) -ge $minNode } | Select-Object -First 1
  if (-not $release) { Fail "nodejs.org has no Node.js $($cfg.nodeMin)+ release for Windows $arch." }
  $v = $release.version
  $zipName = "node-$v-win-$arch.zip"
  $zip = Join-Path $env:TEMP $zipName
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$v/$zipName" -OutFile $zip
  $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$v/SHASUMS256.txt").Content
  $line = ($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($zipName) } | Select-Object -First 1
  $want = if ($line) { ($line -split '\s+')[0].Trim().ToLower() } else { '' }
  if (-not $want -or (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $want) { Remove-Item $zip -Force; Fail 'The Node.js download did not match its published checksum; not using it.' }
  $unpack = Join-Path $env:TEMP "aos-node-$([guid]::NewGuid().ToString('N'))"
  Expand-Archive -Path $zip -DestinationPath $unpack
  if (Test-Path $portable) { Remove-Item $portable -Recurse -Force }
  New-Item -ItemType Directory -Force -Path (Split-Path $portable) | Out-Null
  Move-Item (Join-Path $unpack "node-$v-win-$arch") $portable
  Remove-Item $zip, $unpack -Recurse -Force -ErrorAction SilentlyContinue
  $node = Join-Path $portable 'node.exe'
}
if ($node -like "$portable*") { Add-UserPath $portable }
Done "Node.js $(& $node --version) ($node)"

# ---------------------------------------------------------------- Claude Code
Say 'Claude Code'
$claude = $null
$claudeHome = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
$found = Get-Command claude -ErrorAction SilentlyContinue
if ($found) { $claude = $found.Source } elseif (Test-Path $claudeHome) { $claude = $claudeHome }
if (-not $claude) {
  Write-Host "   Installing Claude Code with Anthropic's installer (claude.ai/install.ps1)..."
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command 'irm https://claude.ai/install.ps1 | iex'
  if (Test-Path $claudeHome) { $claude = $claudeHome }
}
if ($claude) {
  Add-UserPath (Split-Path $claude)
  Done "Claude Code $((& $claude --version 2>$null) -join ' ')"
} else {
  Write-Host '   Claude Code did not install. The dashboard''s Machine page has an Install button to try again.' -ForegroundColor Yellow
}

# ---------------------------------------------------------------- the source's key
Say "Sign in to $($cfg.sourceLabel)"
$src = $cfg.source
$auth = @{}
if ($src.source -eq 'confluence') {
  $keyFile = Join-Path $ledger 'confluence-api-token'
  $site = $src.site
  $wiki = "https://$site/wiki"
  $cred = if (Test-Path $keyFile) { (Get-Content $keyFile -Raw).Trim() } else { $env:AOS_CONFLUENCE_KEY }
  $who = $null
  $opened = $false
  while ($true) {
    if ($cred) {
      $h = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cred)) }
      try { $me = Invoke-RestMethod -UseBasicParsing -Headers $h "$wiki/rest/api/user/current"; if ($me.type -ne 'anonymous') { $who = $me.displayName } } catch {}
      if ($who) { $auth = $h; break }
      Write-Host '   That email and token were not accepted.' -ForegroundColor Yellow
    }
    if ($env:AOS_YES) { Fail "No working $site key (set AOS_CONFLUENCE_KEY=email:token)." }
    Write-Host "   The code is downloaded with your own Atlassian account. Create an API token (Create API token, any name),"
    Write-Host '   copy it, and paste it here. It is kept only on this computer.'
    if (-not $opened) { Start-Process 'https://id.atlassian.com/manage-profile/security/api-tokens'; $opened = $true }
    $email = Read-Host '   Your work email'
    $secure = Read-Host '   API token' -AsSecureString
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    $cred = "$($email.Trim()):$($token.Trim())"
  }
  Set-Content -Path $keyFile -Value $cred -NoNewline -Encoding ASCII
  Done "Signed in as $who"
  function List-Files {
    $out = @()
    $next = "/wiki/rest/api/content/$($src.pageId)/child/attachment?limit=100"
    while ($next) {
      $r = Invoke-RestMethod -UseBasicParsing -Headers $auth "https://$site$next"
      foreach ($a in $r.results) { $out += [pscustomobject]@{ id = $a.id; name = $a.title } }
      $n = $r._links.next
      $next = if ($n) { if ($n.StartsWith('/wiki/')) { $n } else { "/wiki$n" } } else { $null }
    }
    return $out
  }
  $files = List-Files
  function Get-File($name, $dest) {
    $f = $files | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if (-not $f) { Fail "$name is not on the $($cfg.sourceLabel) page. Ask whoever publishes the code to publish it." }
    # Redirects to Atlassian's media service; the Authorization header isn't sent on to it.
    Invoke-WebRequest -UseBasicParsing -Headers $auth "$wiki/rest/api/content/$($src.pageId)/child/attachment/$($f.id)/download" -OutFile $dest
  }
} else {
  $keyFile = Join-Path $ledger 'snapshot-http-token'
  if ($src.auth -eq 'bearer' -or $src.auth -eq 'basic') {
    $key = if (Test-Path $keyFile) { (Get-Content $keyFile -Raw).Trim() } else { $env:AOS_HTTP_KEY }
    if (-not $key) {
      if ($env:AOS_YES) { Fail 'No download key (set AOS_HTTP_KEY).' }
      $secure = Read-Host ('   Download ' + $(if ($src.auth -eq 'basic') { 'user:password' } else { 'token' })) -AsSecureString
      $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
    }
    $auth = if ($src.auth -eq 'bearer') { @{ Authorization = "Bearer $key" } } else { @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($key)) } }
    Set-Content -Path $keyFile -Value $key -NoNewline -Encoding ASCII
  }
  function Get-File($name, $dest) { Invoke-WebRequest -UseBasicParsing -Headers $auth "$($src.baseUrl.TrimEnd('/'))/$name" -OutFile $dest }
  Done 'Ready'
}

# ---------------------------------------------------------------- the workspace files
Say 'Downloading the workspace'
$tmp = Join-Path $env:TEMP "aos-setup-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Get-File 'snapshot-manifest.json' (Join-Path $tmp 'manifest.json')
  $manifest = Get-Content (Join-Path $tmp 'manifest.json') -Raw | ConvertFrom-Json
  if (-not $manifest.workspace) { Fail 'Nothing has been published for the workspace itself yet (no workspace.zip in the manifest).' }
  Get-File $manifest.workspace.file (Join-Path $tmp 'workspace.zip')
  $unzipped = Join-Path $tmp 'workspace'
  Expand-Archive -Path (Join-Path $tmp 'workspace.zip') -DestinationPath $unzipped
  # Over what's there: your .claude\ledger (keys, runs) and the downloaded repos aren't in the zip, so they stay.
  Copy-Item -Path (Join-Path $unzipped '*') -Destination $dir -Recurse -Force
  Done "Workspace files from $($manifest.workspace.builtAt)"
  $ui = $manifest.ui
  $dist = Join-Path $dir 'dashboard\dist'
  if ($ui) {
    Get-File $ui.file (Join-Path $tmp 'ui.tar.gz')
    if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf (Join-Path $tmp 'ui.tar.gz') -C (Join-Path $dir 'dashboard')
    if ($LASTEXITCODE -ne 0) { Fail 'Could not unpack the dashboard UI.' }
    Done 'Dashboard UI'
  } else {
    Write-Host '   No built dashboard UI was published; the first start builds it (needs npm, a few minutes).' -ForegroundColor Yellow
  }
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- start
Say 'Starting the dashboard'
$port = 3333
try { $ws = Get-Content (Join-Path $dir '.claude\dashboard\workspace.json') -Raw | ConvertFrom-Json; if ($ws.dashboard.port) { $port = [int]$ws.dashboard.port } } catch {}
if ($env:DASHBOARD_PORT) { $port = [int]$env:DASHBOARD_PORT }
Push-Location $dir
try { & $node (Join-Path $dir 'dashboard\bin\dashboard.mjs') start --port $port } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Fail 'The dashboard did not start (see the lines above).' }
$base = "http://localhost:$port"
$boot = $null
for ($i = 0; $i -lt 60 -and -not $boot; $i++) {
  try { $boot = Invoke-RestMethod -UseBasicParsing "$base/api/boot" } catch { Start-Sleep -Seconds 1 }
}
if (-not $boot) { Fail "The dashboard did not answer on $base." }
if ($boot.workspaceRoot -and ((Resolve-Path $boot.workspaceRoot).Path -ne (Resolve-Path $dir).Path)) { Fail "Port $port is another workspace's dashboard ($($boot.workspaceRoot)). Stop it, or set DASHBOARD_PORT, and run this again." }
$post = @{ 'x-dash-token' = $boot.token }
try { Invoke-RestMethod -UseBasicParsing -Method Post -Headers $post -ContentType 'application/json' -Body '{"profile":"reader"}' "$base/api/profile" | Out-Null } catch {}
try {
  Invoke-RestMethod -UseBasicParsing -Method Post -Headers $post -ContentType 'application/json' -Body '{}' "$base/api/snapshot/download" | Out-Null
  Done 'Downloading the code (the Repos page shows how far it is)'
} catch {
  $why = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
  if ($why -match 'Nothing to download') { Done 'The code is up to date' }
  else { Write-Host "   Could not start the code download ($why). Use Download code on the Repos page." -ForegroundColor Yellow }
}

# ---------------------------------------------------------------- shortcut
if ($env:AOS_NO_SHORTCUT) { } else { try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop "$($cfg.name) dashboard.lnk"))
  $lnk.TargetPath = $node
  $lnk.Arguments = '"' + (Join-Path $dir 'dashboard\bin\dashboard.mjs') + '" start --open'
  $lnk.WorkingDirectory = $dir
  $lnk.Description = "Start the $($cfg.name) dashboard"
  $lnk.Save()
  Done "Desktop shortcut: $($cfg.name) dashboard"
} catch {
  Write-Host "   Could not add a desktop shortcut; start it with: `"$node`" `"$dir\dashboard\bin\dashboard.mjs`" start --open" -ForegroundColor Yellow
} }

Say 'Done'
Write-Host "   The dashboard is at $base (opening it now). Run this installer again any time to update the workspace files."
if ($claude) { Write-Host "   First time with Claude Code? Sign in from the dashboard's Machine page, or run 'claude' in a terminal once." }
if (-not $env:AOS_YES) { Start-Process "$base/repos" }
exit 0
