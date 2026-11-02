# scripts/restart.ps1 - restart ONE service by name without touching the rest.
#
#   powershell -File scripts\restart.ps1 demo-app
#   powershell -File scripts\restart.ps1 billing
#   powershell -File scripts\restart.ps1 gateway
#   powershell -File scripts\restart.ps1 mock-llm
#
# Stops only that service - its scheduled task and the process on its port -
# then starts it again with the same env-file handling and the same launcher
# scripts\start.ps1 uses.

param(
	[Parameter(Mandatory = $true)]
	[ValidateSet("demo-app", "billing", "gateway", "mock-llm")]
	[string]$Service
)

$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib\stack.ps1")

$svc = (Get-StackServices)[$Service]
$port = $svc.port

# Stop the scheduled task first so it cannot restart the program underneath us.
$procName = Stop-StackService $Service $svc
if ($procName) {
	Write-Host "[restart] killed $procName (pid on :$port)" -ForegroundColor Yellow
	Start-Sleep -Seconds 2
} else {
	Write-Host "[restart] nothing listening on :$port" -ForegroundColor DarkGray
}

Write-Host "[start] $Service on :$port" -ForegroundColor Green
Start-StackService $Service $svc

Start-Sleep -Seconds 15
if (Test-Port $port) {
	Write-Host "[ok] $Service is up on :$port" -ForegroundColor Green
} else {
	Write-Host "[warn] $Service not up yet - check $StackLogDir" -ForegroundColor Red
}
