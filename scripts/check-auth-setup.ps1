# scripts/check-auth-setup.ps1 - report which sign-in provider mode is active
# and print the exact values needed to configure the authentic ones.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-auth-setup.ps1

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot

function Read-DotEnv($path) {
	$map = @{}
	if (Test-Path $path) {
		foreach ($line in (Get-Content $path)) {
			if ($line -match "^\s*([A-Z_][A-Z0-9_]*)=(.*)$") {
				$map[$matches[1]] = $matches[2].Trim()
			}
		}
	}
	return $map
}

$server = Read-DotEnv (Join-Path $root "billing\server\.env")
$vite = Read-DotEnv (Join-Path $root "billing\vite\.env")

$googleMock = $server["EMULATE_GOOGLE_URL"]
$mailMock = $server["RESEND_BASE_URL"]
$googleReal = $server["GOOGLE_CLIENT_ID"] -and -not $googleMock -and $server["GOOGLE_CLIENT_ID"] -notmatch "^mock-"
$resendReal = $server["RESEND_API_KEY"] -and -not $mailMock -and $server["RESEND_API_KEY"] -notmatch "^mock-"

Write-Output "=== MeterPal sign-in provider setup ==="
Write-Output ("Redirect URI to register in Google Cloud Console:")
	$apiUrl = if ($server['AUTUMN_API_URL']) { $server['AUTUMN_API_URL'] } else { 'http://localhost:8080' }
	Write-Output "  $apiUrl/api/auth/callback/google"
Write-Output ""
Write-Output ("Google : " + $(if ($googleReal) { "AUTHENTIC (real OAuth client)" }
	elseif ($googleMock) { "LOCAL MOCK (emulated chooser on $($googleMock))" }
	else { "NOT CONFIGURED - the button is hidden" }))
Write-Output ("Email  : " + $(if ($resendReal) {
	$from = $server["RESEND_FROM"]
	if ($from) { "AUTHENTIC (real Resend, from $from)" } else { "AUTHENTIC (real Resend, domain $($server['RESEND_DOMAIN']))" }
} elseif ($mailMock) { "LOCAL MOCK (web inbox on $($mailMock)/inbox)" }
	else { "NOT CONFIGURED - OTP codes only in demo\logs\billing.log" }))
Write-Output ""
$dash = if ($vite["VITE_BACKEND_URL"]) { $vite["VITE_BACKEND_URL"] } else { "(unset)" }
Write-Output "Dashboard: $dash"
Write-Output ("  Google button   : " + $(if ($vite["VITE_ENABLE_GOOGLE_SIGNIN"] -eq "1") { "shown" } else { "hidden" }))
Write-Output ("  Emulate proxy   : " + $(if ($vite["VITE_EMULATE_GOOGLE_PROXY"] -eq "1") { "on (mock mode)" } else { "off" }))

if ($googleReal -and $googleMock) {
	Write-Output ""
	Write-Output "WARNING: both mock (EMULATE_GOOGLE_URL) and real Google creds are set - the mock wins. Comment EMULATE_GOOGLE_URL for authentic mode." -ForegroundColor Yellow
}
if ($resendReal -and $mailMock) {
	Write-Output ""
	Write-Output "WARNING: both mock (RESEND_BASE_URL) and real Resend are set - the mock wins. Comment RESEND_BASE_URL for authentic mode." -ForegroundColor Yellow
}
