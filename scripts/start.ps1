# scripts/start.ps1 - one-command startup for the whole MeterPal stack.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1
#
# Starts each service, skipping anything already listening:
#   docker compose (postgres x2, redis x2)
#   billing server   :8080   (billing/server)
#   mock LLM         :9999   (demo/mock_llm.py)
#   metered gateway  :4000   (gateway)  - loads gateway/.env
#   demo app         :5173   (demo-app)
#
# Re-running is safe: ports already in use are left alone.
#
# Every service runs as a Windows SCHEDULED TASK (see scripts\lib\stack.ps1).
# That gives each one a real console - LiteLLM's Prisma query engine aborts on
# Windows without one - and keeps it alive after the shell that launched it
# exits, which a plain child process does not survive.
#
# Env files: a service's .env is loaded into the service's environment, so the
# gateway gets its PAB_* bridge configuration (PAB_API_KEY, PAB_BASE_URL, ...)
# without those values ever being copied into another file.

$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib\stack.ps1")

$root = $StackRoot
$services = Get-StackServices
$order = @("billing", "mock-llm", "gateway", "demo-app")

Write-Host "MeterPal stack startup" -ForegroundColor Cyan

# 1. infrastructure
if (-not (Test-Port 5433)) {
	Write-Host "[start] docker compose (postgres + redis)" -ForegroundColor Green
	Start-Process -FilePath "docker" -ArgumentList "compose", "up", "-d" -WorkingDirectory $root -WindowStyle Hidden | Out-Null
	Start-Sleep -Seconds 8
} else {
	Write-Host "[skip] docker compose already running" -ForegroundColor DarkGray
}

# 2. services
#    NOTE: the billing server and the demo app read their own .env (bun loads
#    ./.env automatically for the process cwd).
foreach ($name in $order) {
	$svc = $services[$name]
	if (Test-Port $svc.port) {
		Write-Host "[skip] $name already running on :$($svc.port)" -ForegroundColor DarkGray
		continue
	}
	Write-Host "[start] $name on :$($svc.port)" -ForegroundColor Green
	Start-StackService $name $svc
}

Write-Host ""
Write-Host "Waiting for services to come up..." -ForegroundColor Cyan
Start-Sleep -Seconds 25

foreach ($name in $order) {
	$svc = $services[$name]
	$ok = Test-Port $svc.port
	$status = if ($ok) { "UP" } else { "starting/failed - check demo/logs" }
	Write-Host ("  :{0}  {1}  ({2})" -f $svc.port, $status, $name)
}

Write-Host ""
Write-Host "Demo app:  http://localhost:5173" -ForegroundColor Yellow
Write-Host "Billing API: http://localhost:8080" -ForegroundColor Yellow
Write-Host "Logs:       $StackLogDir" -ForegroundColor DarkGray
Write-Host "If :5433 stayed down, start Docker Desktop first, then re-run." -ForegroundColor DarkGray
