# scripts/verify-tenant-isolation.ps1
#
# Proves the gateway's tenant resolution, end to end.
#
# The gateway serves every merchant from one deployment, so the only thing
# that can say which merchant a call belongs to is the caller's virtual key.
# A header the caller controls must never be able to redirect a charge, and
# an admin key must never be able to bill anyone.
#
# These checks drive the gateway directly (port 4000), because the billing
# proxy resolves the tenant itself and would hide what is being tested here.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-tenant-isolation.ps1
#
# Exit code 0 when every check passes, 1 otherwise.

$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent $PSScriptRoot
$Gateway = "http://localhost:4000"
$PostgresContainer = "meterpal-postgres-billing"
$PsqlUser = "autumn"
$PsqlDb = "autumn"
$OrgId = "org_demo"

$script:Failures = 0

function Write-Section($text) {
	Write-Output ""
	Write-Output "=== $text ==="
}

function Assert-Status {
	param([string]$Label, [int]$Expected, $Result)
	$ok = ($Result.status -eq $Expected)
	if (-not $ok) { $script:Failures++ }
	$mark = if ($ok) { "PASS" } else { "FAIL" }
	Write-Output ("[{0}] {1} -> HTTP {2} (expected {3})" -f $mark, $Label, $Result.status, $Expected)
	if (-not $ok) {
		$snippet = $Result.body
		if ($snippet -and $snippet.Length -gt 240) { $snippet = $snippet.Substring(0, 240) + " ..." }
		Write-Output "       $snippet"
	}
}

function Invoke-GatewayCall {
	param([string]$Key, [string]$Model, [hashtable]$Headers = @{}, [string]$BodyUser)
	$payload = @{
		model    = $Model
		messages = @(@{ role = "user"; content = "verify" })
		max_tokens = 8
	}
	if ($BodyUser) { $payload["user"] = $BodyUser }
	$json = $payload | ConvertTo-Json -Depth 5 -Compress

	$hdrs = @{ Authorization = "Bearer $Key" }
	foreach ($h in $Headers.GetEnumerator()) { $hdrs[$h.Key] = $h.Value }

	try {
		$resp = Invoke-WebRequest -UseBasicParsing -Uri "$Gateway/chat/completions" `
			-Method POST -Headers $hdrs -ContentType "application/json" -Body $json -TimeoutSec 30
		return @{ status = [int]$resp.StatusCode; body = $resp.Content }
	} catch {
		$status = 0
		$content = ""
		if ($_.Exception.Response) {
			$status = [int]$_.Exception.Response.StatusCode
			# PowerShell puts the response body in ErrorDetails for a failed
			# web call; the raw stream is only a fallback.
			if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
				$content = $_.ErrorDetails.Message
			} else {
				try {
					$reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
					$content = $reader.ReadToEnd()
				} catch { }
			}
		}
		return @{ status = $status; body = $content }
	}
}

function Invoke-Db {
	param([string]$Sql)
	$rows = & docker exec $PostgresContainer psql -U $PsqlUser -d $PsqlDb -t -A -F "|" -c $Sql 2>$null
	return @($rows | Where-Object { $_ -and $_.Trim() -ne "" })
}

# --- the fixtures -------------------------------------------------------
$masterKey = ""
foreach ($line in (Get-Content (Join-Path $Root "gateway\.env"))) {
	if ($line -match "^LITELLM_MASTER_KEY=(.*)$") { $masterKey = $matches[1].Trim() }
}
if (-not $masterKey) {
	Write-Output "LITELLM_MASTER_KEY is missing from gateway\.env"
	exit 1
}

$keys = @{}
foreach ($row in (Invoke-Db "select id, litellm_virtual_key from customers where org_id = '$OrgId' and litellm_virtual_key is not null order by id")) {
	$parts = $row -split "\|"
	if ($parts.Count -ge 2) { $keys[$parts[0]] = $parts[1] }
}
if ($keys.Count -lt 2) {
	Write-Output "expected at least two provisioned customers in $OrgId, found $($keys.Count)"
	exit 1
}

$allowedModels = @(Invoke-Db "select upstream_model from served_models where org_id = '$OrgId' and enabled = true and upstream_model is not null")
if ($allowedModels.Count -eq 0) {
	Write-Output "no enabled models on $OrgId's price sheet"
	exit 1
}
$allowedModel = $allowedModels[0].Trim()

# A model the gateway serves but this merchant does not sell.
$notOnSheet = "gpt-4o"

$customerIds = @($keys.Keys | Sort-Object)
$customerKey = $keys[$customerIds[0]]
$otherCustomerKey = $keys[$customerIds[1]]

Write-Output "org            : $OrgId"
Write-Output "customers      : $($customerIds -join ', ')"
Write-Output "price sheet    : $($allowedModels -join ', ')"

# --- 1. the key carries the tenant --------------------------------------
Write-Section "the virtual key carries the tenant"
$info = & curl.exe -s "$Gateway/key/info?key=$customerKey" -H "Authorization: Bearer $masterKey" | ConvertFrom-Json
$expectAlias = "meterpal:$OrgId`:$($customerIds[0])"
if ($info.info.user_id -eq "$OrgId`:$($customerIds[0])") {
	Write-Output "[PASS] key identity -> $($info.info.user_id)"
} else {
	Write-Output "[FAIL] key identity -> $($info.info.user_id) (expected $OrgId`:$($customerIds[0]))"
	$script:Failures++
}
if ($info.info.key_alias -eq $expectAlias) {
	Write-Output "[PASS] key alias    -> $($info.info.key_alias)"
} else {
	Write-Output "[FAIL] key alias    -> $($info.info.key_alias) (expected $expectAlias)"
	$script:Failures++
}
if ($info.info.rpm_limit -gt 0 -and $info.info.tpm_limit -gt 0) {
	Write-Output "[PASS] plan limits  -> rpm $($info.info.rpm_limit), tpm $($info.info.tpm_limit)"
} else {
	Write-Output "[FAIL] plan limits  -> rpm $($info.info.rpm_limit), tpm $($info.info.tpm_limit)"
	$script:Failures++
}

# --- 2. a caller-supplied customer cannot redirect the charge ------------
Write-Section "the key's identity wins over a customer named in the request"
Assert-Status -Label "key + header user=<unknown customer>" -Expected 200 `
	-Result (Invoke-GatewayCall -Key $customerKey -Model $allowedModel -Headers @{ user = "ghost-customer-0000" })
Assert-Status -Label "key + header user=<another real customer>" -Expected 200 `
	-Result (Invoke-GatewayCall -Key $customerKey -Model $allowedModel -Headers @{ user = $customerIds[1] })

# --- 3. an admin key cannot bill anyone ---------------------------------
Write-Section "an admin key carries no tenant, so it cannot bill"
Assert-Status -Label "master key, no customer named" -Expected 403 `
	-Result (Invoke-GatewayCall -Key $masterKey -Model $allowedModel)
$unresolved = Invoke-GatewayCall -Key $masterKey -Model $allowedModel -BodyUser $customerIds[0]
Assert-Status -Label "master key + body user=<customer>" -Expected 403 -Result $unresolved
if ($unresolved.body -match "unresolvable_tenant") {
	Write-Output "[PASS] refused as unresolvable_tenant"
} else {
	Write-Output "[FAIL] refused with the wrong reason: $($unresolved.body)"
	$script:Failures++
}

# --- 4. the price sheet is the allow-list -------------------------------
Write-Section "the merchant's price sheet is the gateway's allow-list"
Assert-Status -Label "model on the price sheet ($allowedModel)" -Expected 200 `
	-Result (Invoke-GatewayCall -Key $customerKey -Model $allowedModel)
Assert-Status -Label "model NOT on the price sheet ($notOnSheet)" -Expected 403 `
	-Result (Invoke-GatewayCall -Key $customerKey -Model $notOnSheet)

# --- 5. an unknown key is refused ---------------------------------------
Write-Section "an unknown key is refused"
Assert-Status -Label "key that does not exist" -Expected 401 `
	-Result (Invoke-GatewayCall -Key "sk-not-a-real-key" -Model $allowedModel)

Write-Output ""
if ($script:Failures -eq 0) {
	Write-Output "ALL CHECKS PASSED"
	exit 0
} else {
	Write-Output "$script:Failures CHECK(S) FAILED"
	exit 1
}
