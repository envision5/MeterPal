# scripts/lib/stack.ps1 - shared helpers for scripts\start.ps1 and scripts\restart.ps1.
#
# Dot-source this file; do not run it directly.
#
#   . (Join-Path $PSScriptRoot "lib\stack.ps1")
#
# ONE service table drives both scripts, and ONE launch mechanism per service
# kind.  Two Windows-specific problems force the design:
#
#   1. A service started as a child of the launching shell dies with it.  The
#      harness (and any CI runner) reaps that process tree, so a long-running
#      server must be launched by something OUTSIDE the tree.
#
#   2. LiteLLM's Prisma query engine reads the console title and aborts on
#      Windows when it cannot get one ("Assertion failed: process_title, file
#      src\win\util.c, line 412").  The engine needs a REAL console.
#
# A Windows SCHEDULED TASK solves both: the Task Scheduler service starts the
# process in the interactive session (so it has a console) and the process is
# not a descendant of the launching shell (so nothing reaps it).  Every service
# therefore runs as a scheduled task.

$StackRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$StackLogDir = Join-Path $StackRoot "demo\logs"

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

# Finds the PID listening on a port.
#
# Get-NetTCPConnection is the primary source, but it can report a bound
# socket with an empty State (and netstat then omits it), so a service that
# is really up looks free and the replacement collides with it ("Is port
# 8080 in use?").  netstat is the fallback.
function Get-PortOwner($port) {
	$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
		Select-Object -First 1
	if ($conn) { return $conn.OwningProcess }

	$rows = & netstat -ano -p tcp 2>$null
	foreach ($row in $rows) {
		if ($row -match '^\s*TCP\s+\S+:' + $port + '\s+\S+\s+LISTENING\s+(\d+)') {
			return [int]$matches[1]
		}
	}
	return $null
}

# Waits until nothing is listening on a port.  A service that is asked to
# restart collides with its own predecessor unless the port is really free:
# "Failed to start server. Is port 8080 in use?"
function Wait-PortFree($port, $timeoutSeconds = 20) {
	$deadline = (Get-Date).AddSeconds($timeoutSeconds)
	while ((Get-Date) -lt $deadline) {
		if (-not (Test-Port $port)) { return $true }
		Start-Sleep -Milliseconds 500
	}
	return -not (Test-Port $port)
}

# Reads a KEY=VALUE env file into the CURRENT process, so the next process it
# starts inherits it.  Used for the gateway: LiteLLM is a Python program and
# does not load .env on its own, and its PAB_* bridge settings have to be
# present in the process environment.
function Import-EnvFile($path) {
	if (-not $path -or -not (Test-Path $path)) { return }
	foreach ($line in Get-Content $path) {
		if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
			$name = $matches[1]
			$value = $matches[2].Trim('"', "'")
			[Environment]::SetEnvironmentVariable($name, $value, "Process")
		}
	}
}

function Resolve-Executable($name) {
	$cmd = Get-Command "$name.exe" -ErrorAction SilentlyContinue
	if (-not $cmd) { $cmd = Get-Command $name -ErrorAction SilentlyContinue }
	return $cmd.Source
}

# The service table.  One definition, used by both scripts.
function Get-StackServices {
	return @{
		"billing" = @{
			port = 8080
			dir = "$StackRoot\billing\server"
			exe = (Resolve-Executable "bun")
			args = @("src/index.ts")
			envFile = $null
			env = @{}
			log = "billing"
		}
		"demo-app" = @{
			port = 5173
			dir = "$StackRoot\demo-app"
			exe = (Resolve-Executable "bun")
			args = @("server.ts")
			envFile = $null
			env = @{}
			log = "demo-app"
		}
		"mock-llm" = @{
			port = 9999
			dir = "$StackRoot\demo"
			exe = (Resolve-Executable "python")
			args = @("mock_llm.py")
			envFile = $null
			env = @{ PYTHONIOENCODING = "utf-8"; PYTHONUNBUFFERED = "1" }
			log = "mock-llm"
		}
		"gateway" = @{
			port = 4000
			dir = "$StackRoot\gateway"
			exe = (Resolve-Executable "python")
			args = @("-m", "litellm.proxy.proxy_cli", "--config", "config.yaml", "--port", "4000")
			# LiteLLM is Python: its .env is loaded explicitly so the PAB_*
			# metering-bridge configuration is in the process environment.
			envFile = "$StackRoot\gateway\.env"
			env = @{ PYTHONIOENCODING = "utf-8"; PYTHONUNBUFFERED = "1" }
			log = "gateway"
		}
	}
}

# The scheduled-task name for a service.  One namespace for the whole stack.
function Get-StackTaskName($name) {
	return "MeterPal - $name"
}

# Starts a service as a Windows scheduled task.
#
# The task runs scripts\lib\run-service.ps1, which loads the service's env
# file and runs the program with its output appended to demo/logs\<name>.log.
function Start-StackService($name, $svc) {
	New-Item -ItemType Directory -Force -Path $StackLogDir | Out-Null
	$taskName = Get-StackTaskName $name
	$runner = Join-Path $PSScriptRoot "run-service.ps1"

	$action = New-ScheduledTaskAction `
		-Execute "powershell.exe" `
		-Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Service $name" `
		-WorkingDirectory $svc.dir
	$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5)
	$settings = New-ScheduledTaskSettingsSet `
		-AllowStartIfOnBatteries `
		-DontStopIfGoingOnBatteries `
		-ExecutionTimeLimit ([TimeSpan]::Zero) `
		-MultipleInstances IgnoreNew

	Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
	Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
	Start-ScheduledTask -TaskName $taskName
}

# Stops a service: the scheduled task first (so it cannot restart the
# program), then whatever is listening on its port.
function Stop-StackService($name, $svc) {
	$taskName = Get-StackTaskName $name
	Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
	Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

	# Stopping the task kills the program, but the listening socket can take a
	# moment to go away.  Kill any holder that is left and wait for the port
	# to be free, otherwise the replacement collides with its predecessor.
	$procName = $null
	for ($attempt = 0; $attempt -lt 10; $attempt++) {
		$owner = Get-PortOwner $svc.port
		if (-not $owner) { break }
		if (-not $procName) {
			$procName = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
		}
		Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
		Start-Sleep -Milliseconds 700
	}
	[void](Wait-PortFree $svc.port)

	# LiteLLM's Prisma client spawns a separate query-engine process.  It is
	# NOT a child that dies with the proxy, so a killed gateway leaves it
	# behind -- and the next gateway then fails its startup health check with
	# "All connection attempts failed".  Clear the orphans with the proxy.
	Get-CimInstance Win32_Process -Filter "Name = 'query-engine-windows.exe'" -ErrorAction SilentlyContinue |
		ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

	return $procName
}
