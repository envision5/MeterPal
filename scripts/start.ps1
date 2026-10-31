# scripts/start.ps1 — one-command startup for the whole MeterPal stack.
#
#   powershell -File scripts\start.ps1
#
# Starts each service in its OWN window (so closing one doesn't kill the
# others, and logs stay visible), skipping anything already listening:
#   docker compose (postgres x2, redis x2)
#   billing server   :8080   (billing/server)
#   mock LLM         :9999   (demo/mock_llm.py)
#   metered gateway  :4000   (gateway)
#   demo app         :5173   (demo-app)
#
# Re-running is safe: ports already in use are left alone.

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot

function Test-Port($port) {
	$client = New-Object Net.Sockets.TcpClient
	try {
		$client.Connect("127.0.0.1", $port)
		return $client.Connected
	} catch {
		return $false
	} finally {
		$client.Close()
	}
}

function Start-ServiceWindow($name, $port, $workdir, $command) {
	if (Test-Port $port) {
		Write-Host "[skip] $name already running on :$port" -ForegroundColor DarkGray
		return
	}
	Write-Host "[start] $name on :$port" -ForegroundColor Green
	Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "cd /d `"$workdir`" && $command" `
		-WindowStyle Minimized
}

Write-Host "MeterPal stack startup" -ForegroundColor Cyan

# 1. infrastructure
$dockerUp = Test-Port 5433
if (-not $dockerUp) {
	Write-Host "[start] docker compose (postgres + redis)" -ForegroundColor Green
	Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "cd /d `"$root`" && docker compose up -d" `
		-WindowStyle Minimized
	Start-Sleep -Seconds 8
} else {
	Write-Host "[skip] docker compose already running" -ForegroundColor DarkGray
}

# 2. services
Start-ServiceWindow "billing server" 8080 "$root\billing\server" "bun src/index.ts"
Start-ServiceWindow "mock LLM" 9999 "$root\demo" "python mock_llm.py"
Start-ServiceWindow "metered gateway" 4000 "$root\gateway" "cmd /c `"set -a && source .env && set +a && `%USERPROFILE`%\AppData\Roaming\Python\Python312\Scripts\litellm.exe --config config.yaml --port 4000`""
Start-ServiceWindow "demo app" 5173 "$root\demo-app" "bun server.ts"

Write-Host ""
Write-Host "Waiting for services to come up..." -ForegroundColor Cyan
Start-Sleep -Seconds 12

foreach ($p in @(5433, 8080, 9999, 4000, 5173)) {
	$ok = Test-Port $p
	$status = if ($ok) { "UP" } else { "starting/failed — check its window" }
	Write-Host ("  :{0}  {1}" -f $p, $status)
}

Write-Host ""
Write-Host "Demo app:  http://localhost:5173" -ForegroundColor Yellow
Write-Host "Dashboard billing API: http://localhost:8080" -ForegroundColor Yellow
Write-Host "If :5433 stayed down, start Docker Desktop first, then re-run." -ForegroundColor DarkGray
