$ErrorActionPreference = 'Stop'
$originalPath = $env:PATH
$originalBrowsers = $env:PLAYWRIGHT_BROWSERS_PATH
$runtimeRoot = Join-Path $PSScriptRoot 'portable-runtime'
$prepared = Join-Path $PSScriptRoot 'prepared-consumer'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $PSScriptRoot 'browser-cache'

function Invoke-Node([string]$Node, [string[]]$Arguments) {
    & $Node @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Node workload failed with exit $LASTEXITCODE" }
}

try {
    Set-Location $PSScriptRoot
    $runtimes = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'windows-runtimes.json') | ConvertFrom-Json
    $candidate = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'candidate.json') | ConvertFrom-Json
    $archive = Join-Path $PSScriptRoot $candidate.filename
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $candidate.sha256) {
        throw 'Candidate archive checksum mismatch'
    }
    $reports = @()
    foreach ($runtime in $runtimes) {
        $zip = Join-Path $PSScriptRoot $runtime.filename
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant() -ne $runtime.sha256) {
            throw 'Portable Node archive checksum mismatch'
        }
        Expand-Archive -LiteralPath $zip -DestinationPath $runtimeRoot -Force
        $nodeDirectory = Join-Path $runtimeRoot $runtime.directory
        $node = Join-Path $nodeDirectory 'node.exe'
        $npm = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
        $env:PATH = "$nodeDirectory;$originalPath"
        Invoke-Node -Node $node -Arguments @('--version')
        if (-not (Test-Path -LiteralPath $prepared)) {
            New-Item -ItemType Directory -Path $prepared | Out-Null
            Set-Content -LiteralPath (Join-Path $prepared 'package.json') -Value '{"private":true}' -Encoding ASCII
            Invoke-Node -Node $node -Arguments @($npm, 'install', '--prefix', $prepared, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', $archive)
            $playwright = Join-Path $prepared 'node_modules\playwright\cli.js'
            Invoke-Node -Node $node -Arguments @($playwright, 'install', '--no-shell', 'chromium')
        }
        $output = Join-Path $PSScriptRoot ("evidence-node" + $runtime.major)
        Invoke-Node -Node $node -Arguments @((Join-Path $PSScriptRoot 'scripts\qualify.mjs'), '--archive', $archive, '--output', $output)
        $report = Get-Content -Raw -LiteralPath (Join-Path $output 'qualification.json') | ConvertFrom-Json
        $browser = Get-Content -Raw -LiteralPath (Join-Path $output 'browser.json') | ConvertFrom-Json
        $launcher = Get-Content -Raw -LiteralPath (Join-Path $output 'launcher.json') | ConvertFrom-Json
        $acl = Get-Content -Raw -LiteralPath (Join-Path $output 'windows-acl.json') | ConvertFrom-Json
        $api = Get-Content -Raw -LiteralPath (Join-Path $output 'api.json') | ConvertFrom-Json
        $reports += [PSCustomObject]@{ platform = $report.platform; arch = $report.arch; osRelease = $report.osRelease;
            node = $report.node; status = $report.status; package = $report.package;
            browser = $browser; launcher = $launcher; windowsAcl = $acl; api = $api;
            steps = $report.steps; liveFigma = $report.liveFigma }
    }
    Write-Output 'FIGMA_WINDOWS_QUALIFICATION'
    $reports | ConvertTo-Json -Depth 8
} finally {
    $env:PATH = $originalPath
    $env:PLAYWRIGHT_BROWSERS_PATH = $originalBrowsers
    if (Test-Path -LiteralPath $runtimeRoot) { Remove-Item -LiteralPath $runtimeRoot -Recurse -Force }
    if (Test-Path -LiteralPath $prepared) { Remove-Item -LiteralPath $prepared -Recurse -Force }
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'browser-cache')) {
        Remove-Item -LiteralPath (Join-Path $PSScriptRoot 'browser-cache') -Recurse -Force
    }
}
