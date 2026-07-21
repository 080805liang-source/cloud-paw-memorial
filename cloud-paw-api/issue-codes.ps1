param(
  [ValidateRange(1, 3650)][int]$Days = 30,
  [ValidateRange(1, 100)][int]$Count = 1
)

$ErrorActionPreference = 'Stop'
$runtime = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
$env:HTTP_PROXY = 'http://127.0.0.1:9910'
$env:HTTPS_PROXY = 'http://127.0.0.1:9910'
$env:Path = (Join-Path $runtime 'node\bin') + ';' + $env:Path
$pnpm = Join-Path $runtime 'bin\fallback\pnpm.cmd'

function Get-Hash([string]$Text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $hash = $algorithm.ComputeHash($bytes)
  $algorithm.Dispose()
  return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
}
function New-Code {
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
  $bytes = New-Object byte[] 16
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $part = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
  return "PAW-$($part.Substring(0,4))-$($part.Substring(4,4))-$($part.Substring(8,4))-$($part.Substring(12,4))"
}

$issued = @()
for ($i = 0; $i -lt $Count; $i++) {
  $code = New-Code
  $hash = Get-Hash $code
  $id = [guid]::NewGuid().ToString()
  $sql = "INSERT INTO redeem_codes (id, code_hash, duration_days) VALUES ('$id', '$hash', $Days);"
  & $pnpm dlx --reporter=append-only wrangler@latest d1 execute cloud-paw-vip-db --remote --command $sql | Out-Null
  $issued += $code
}

Write-Output "Issued $Count code(s), $Days day(s) each:"
$issued
