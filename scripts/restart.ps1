# scripts/restart.ps1 — restart ONE service by name without touching the rest.
#
#   powershell -File scripts\restart.ps1 demo-app
#   powershell -File scripts\restart.ps1 billing
#   powershell -File scripts\restart.ps1 gateway
#   powershell -File scripts\restart.ps1 mock-llm
#
# Kills only the process listening on that service's port, then restarts it.

param(
	[Parameter(Mandatory = $true)]
	[ValidateSet("demo-app", "billing", "gateway", "mock-llm")]
	[string]$Service
)

$root = Split-Path -Parent $PSScriptRoot

$map = @{
	"demo-app" = @{ port = 5173; dir = "$root\demo-app"; cmd = "bun server.ts" }
	"billing"  = @{ port = 8080; dir = "$root\billing\server"; cmd = "bun src/index.ts" }
	"gateway"  = @{ port = 4000; dir = "$root\gateway"; cmd = "cmd /c `"set -a && source .env && set +a && `%USERPROFILE`%\AppData\Roaming\Python\Python312\Scripts\litellm.exe --config config.yaml --port 4000`"" }
	"mock-llm" = @{ port = 9999; dir = "$root\demo"; cmd = "python mock_llm.py" }
}

$svc = $map[$Service]
$port = $svc.port

# Find and kill only the PID listening on this port.
$pidToKill = $null
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
	Select-Object -First 1
if ($conn) {
	$pidToKill = $conn.OwningProcess
	$procName = (Get-Process -Id $pidToKill).ProcessName
	Stop-Process -Id $pidToKill -Force
	Write-Host "[restart] killed $procName (pid $pidToKill) on :$port" -ForegroundColor Yellow
	Start-Sleep -Seconds 2
} else {
	Write-Host "[restart] nothing listening on :$port" -ForegroundColor DarkGray
}

Write-Host "[start] $Service on :$port" -ForegroundColor Green
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "cd /d `"$($svc.dir)`" && $($svc.cmd)" `
	-WindowStyle Minimized

Start-Sleep -Seconds 6
$client = New-Object Net.Sockets.TcpClient
try {
	$client.Connect("127.0.0.1", $port)
	Write-Host "[ok] $Service is up on :$port" -ForegroundColor Green
} catch {
	Write-Host "[warn] $Service not up yet — check its window" -ForegroundColor Red
} finally {
	$client.Close()
}
