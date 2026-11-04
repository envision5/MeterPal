# scripts/get-otp.ps1 - print the latest sign-in OTP from the billing server log.
#
# Local dev has no email provider configured, so the email-OTP sign-in code is
# logged instead of sent.  Flow: enter your email on the sign-in page, click
# "Continue with Email", then run this script and type the code it prints.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\get-otp.ps1

$log = Join-Path (Split-Path -Parent $PSScriptRoot) "demo\logs\billing.log"
if (-not (Test-Path $log)) {
	Write-Host "billing log not found at $log" -ForegroundColor Red
	exit 1
}

# The OTP line looks like: RESEND NOT SET UP, SIGN IN OTP: 123456
$match = Select-String -Path $log -Pattern "SIGN IN OTP:\s*(\d{6})" |
	Select-Object -Last 1

if ($match) {
	$code = $match.Matches[0].Groups[1].Value
	Write-Host "OTP: $code" -ForegroundColor Green
} else {
	Write-Host "No OTP found yet. Enter your email on the sign-in page and click 'Continue with Email' first." -ForegroundColor Yellow
	exit 1
}
