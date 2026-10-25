param(
    [ValidateSet('release', 'debug', 'test', 'check', 'fmt')]
    [string]$Mode = 'release'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Push-Location $projectRoot
try {
    $privateCargo = Join-Path $projectRoot '.tools\cargo\bin'
    if (Test-Path (Join-Path $privateCargo 'cargo.exe')) {
        $env:CARGO_HOME = Join-Path $projectRoot '.tools\cargo'
        $env:RUSTUP_HOME = Join-Path $projectRoot '.tools\rustup'
        $env:PATH = $privateCargo + ';' + $env:PATH
    }
    $resourceTools = Join-Path $projectRoot '.tools\mingw64\bin'
    if (Test-Path (Join-Path $resourceTools 'windres.exe')) {
        $env:PATH = $resourceTools + ';' + $env:PATH
        $env:WINDRES = Join-Path $resourceTools 'windres.exe'
    }
    # Cargo does not automatically use the Windows system proxy.
    if (-not $env:HTTPS_PROXY) {
        $source = [uri]'https://index.crates.io'
        $proxy = [System.Net.WebRequest]::DefaultWebProxy.GetProxy($source)
        if ($proxy -and $proxy.Host -ne $source.Host) {
            $env:HTTPS_PROXY = $proxy.AbsoluteUri
        }
    }
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        throw 'Rust is missing. Install the recommended Rust MSVC toolchain, or run scripts/bootstrap-rust.ps1 for an isolated GNU toolchain.'
    }
    switch ($Mode) {
        'release' { cargo build --release --manifest-path src-tauri/Cargo.toml }
        'debug' { cargo build --manifest-path src-tauri/Cargo.toml }
        'test' { cargo test --manifest-path src-tauri/Cargo.toml }
        'check' { cargo check --manifest-path src-tauri/Cargo.toml }
        'fmt' { cargo fmt --manifest-path src-tauri/Cargo.toml -- --check }
    }
    if ($LASTEXITCODE -ne 0) { throw "Cargo $Mode failed with exit code $LASTEXITCODE." }
}
finally { Pop-Location }
