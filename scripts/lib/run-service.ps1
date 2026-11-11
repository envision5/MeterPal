# scripts/lib/run-service.ps1 - run ONE stack service.  Launched by a Windows
# scheduled task (see scripts\lib\stack.ps1).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\lib\run-service.ps1 -Service gateway
#
# The scheduled task gives this process a REAL console (LiteLLM's Prisma query
# engine aborts on Windows without one) and keeps it alive after the shell
# that launched it is gone.
#
# The service's own .env is loaded into THIS process before the program starts,
# so a child inherits it.  For the gateway that is what puts the PAB_* metering
# bridge configuration in the environment: without it LiteLLM logs
# "MeterPalBridge: PAB_API_KEY missing -- bridge disabled" and no inference
# call is ever metered.

param(
	[Parameter(Mandatory = $true)]
	[string]$Service
)

$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "stack.ps1")

$svc = (Get-StackServices)[$Service]
if (-not $svc) {
	Write-Error "unknown service: $Service"
	exit 1
}

if ($svc.envFile) { Import-EnvFile $svc.envFile }
foreach ($name in $svc.env.Keys) {
	[Environment]::SetEnvironmentVariable($name, $svc.env[$name], "Process")
}

New-Item -ItemType Directory -Force -Path $StackLogDir | Out-Null
$log = Join-Path $StackLogDir "$($svc.log).log"
$err = Join-Path $StackLogDir "$($svc.log).err.log"
$exitLog = Join-Path $StackLogDir "$($svc.log).exit.log"

Set-Location $svc.dir

# ---- idempotent start --------------------------------------------------
# The scheduled task re-fires every few minutes so a crashed service comes
# back on its own.  That re-fire must NOT start a second instance while the
# first is still serving: the two race for the port, the loser dies with
# "Failed to start server. Is port 8080 in use?", and on its way out it takes
# the healthy instance's listener with it.  demo/logs/billing.exit.log is the
# record of that race -- one "exited with code 1" every five minutes, while
# the demo app meanwhile sees ConnectionRefused for the seconds in between.
#
# "Is it already serving?" is an HTTP question, not a port question: a socket
# left behind by a dying process still accepts TCP connections, so the port
# looks taken while nothing answers, and the netstat/netstat-fallback lookup
# misses a listener whose state Windows reports as blank.
if (Test-ServiceServing $svc.port) {
	$stamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
	"$stamp $Service already serving on :$($svc.port) - not starting a second instance." |
		Out-File -Append -FilePath $log -Encoding UTF8
	exit 0
}

# Something holds the port but nothing is answering on it: a listener left
# behind by a previous run.  Clear it, or the replacement collides with it.
$stale = Get-PortOwner $svc.port
if ($stale) {
	$stamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
	"$stamp $Service found a stale listener on :$($svc.port) (pid $stale) - clearing it." |
		Out-File -Append -FilePath $log -Encoding UTF8
	Stop-Process -Id $stale -Force -ErrorAction SilentlyContinue
	[void](Wait-PortFree $svc.port)
}

# cmd's redirection writes the program's OWN bytes to the file.  PowerShell's
# own ">>" re-encodes them as UTF-16, which makes the logs unreadable to any
# UTF-8 tool (and to grep).
$argStr = ($svc.args | ForEach-Object { "`"$_`"" }) -join " "
& cmd.exe /c "`"$($svc.exe)`" $argStr >> `"$log`" 2>> `"$err`""

$code = $LASTEXITCODE
$stamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
"$stamp $Service exited with code $code" | Out-File -Append -FilePath $exitLog -Encoding UTF8
exit $code
