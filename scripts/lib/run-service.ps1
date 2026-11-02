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

# cmd's redirection writes the program's OWN bytes to the file.  PowerShell's
# own ">>" re-encodes them as UTF-16, which makes the logs unreadable to any
# UTF-8 tool (and to grep).
$argStr = ($svc.args | ForEach-Object { "`"$_`"" }) -join " "
& cmd.exe /c "`"$($svc.exe)`" $argStr >> `"$log`" 2>> `"$err`""

$code = $LASTEXITCODE
$stamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
"$stamp $Service exited with code $code" | Out-File -Append -FilePath $exitLog -Encoding UTF8
exit $code
