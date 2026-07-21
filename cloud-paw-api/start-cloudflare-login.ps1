$env:HTTP_PROXY = 'http://127.0.0.1:9910'
$env:HTTPS_PROXY = 'http://127.0.0.1:9910'

# Do not hard-code Chinese directory names: PowerShell can misread them in a
# background process. The runtime lives under the current Windows user folder.
$runtime = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
$env:Path = (Join-Path $runtime 'node\bin') + ';' + $env:Path
$pnpm = Join-Path $runtime 'bin\fallback\pnpm.cmd'
$log = Join-Path $PSScriptRoot 'cloudflare-login.log'

& $pnpm dlx --reporter=append-only wrangler@latest login *>&1 | Out-File -LiteralPath $log -Encoding utf8
