# Optional isolated Windows GNU toolchain. Tauri recommends MSVC for general development:
# https://v2.tauri.app/start/prerequisites/#windows
# Downloads official Rust and MSYS2 packages; does not install system software or modify user PATH.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$toolsRoot = Join-Path $projectRoot '.tools'
New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
$env:CARGO_HOME = Join-Path $toolsRoot 'cargo'
$env:RUSTUP_HOME = Join-Path $toolsRoot 'rustup'
$source = [uri]'https://static.rust-lang.org'
$proxy = [System.Net.WebRequest]::DefaultWebProxy.GetProxy($source)
if (-not $env:HTTPS_PROXY -and $proxy -and $proxy.Host -ne $source.Host) {
    $env:HTTPS_PROXY = $proxy.AbsoluteUri
}
$rustup = Join-Path $env:CARGO_HOME 'bin\rustup.exe'
if (-not (Test-Path $rustup)) {
    $installer = Join-Path $toolsRoot 'rustup-init.exe'
    $download = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-gnu/rustup-init.exe'
    Invoke-WebRequest -UseBasicParsing $download -OutFile $installer
    Invoke-WebRequest -UseBasicParsing "$download.sha256" -OutFile "$installer.sha256"
    $expected = ((Get-Content "$installer.sha256" -Raw).Trim() -split '\s+')[0]
    if ((Get-FileHash $installer -Algorithm SHA256).Hash -ne $expected) {
        throw 'Rust installer SHA-256 mismatch.'
    }
    & $installer -y --no-modify-path --profile minimal --default-host x86_64-pc-windows-gnu
    if ($LASTEXITCODE -ne 0) { throw 'Rust setup failed.' }
}
& $rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal --component rustfmt
if ($LASTEXITCODE -ne 0) { throw 'Rust toolchain download failed.' }
& $rustup default stable-x86_64-pc-windows-gnu
if ($LASTEXITCODE -ne 0) { throw 'Private Rust toolchain selection failed.' }

# Rust supplies a linker; Windows resources additionally need windres and a C preprocessor.
# Packages are pinned to the versions verified for this project.
$packages = @(
    'mingw-w64-x86_64-binutils-2.47-4-any.pkg.tar.zst',
    'mingw-w64-x86_64-gettext-runtime-1.0-1-any.pkg.tar.zst',
    'mingw-w64-x86_64-libwinpthread-14.0.0.r98.g19f5121a2-1-any.pkg.tar.zst',
    'mingw-w64-x86_64-zlib-1.3.2-2-any.pkg.tar.zst',
    'mingw-w64-x86_64-zstd-1.5.7-2-any.pkg.tar.zst',
    'mingw-w64-x86_64-libiconv-1.19-1-any.pkg.tar.zst',
    'mingw-w64-x86_64-gcc-16.2.0-6-any.pkg.tar.zst',
    'mingw-w64-x86_64-gmp-6.3.0-2-any.pkg.tar.zst',
    'mingw-w64-x86_64-mpfr-4.2.2-3-any.pkg.tar.zst',
    'mingw-w64-x86_64-mpc-1.4.1-1-any.pkg.tar.zst',
    'mingw-w64-x86_64-isl-0.28-1-any.pkg.tar.zst',
    'mingw-w64-x86_64-headers-14.0.0.r98.g19f5121a2-1-any.pkg.tar.zst',
    'mingw-w64-x86_64-crt-14.0.0.r98.g19f5121a2-1-any.pkg.tar.zst',
    'mingw-w64-x86_64-winpthreads-14.0.0.r98.g19f5121a2-1-any.pkg.tar.zst',
    'mingw-w64-x86_64-libgcc-16.2.0-6-any.pkg.tar.zst',
    'mingw-w64-x86_64-libstdc++-16.2.0-6-any.pkg.tar.zst',
    'mingw-w64-x86_64-windows-default-manifest-6.4-4-any.pkg.tar.zst'
)
foreach ($package in $packages) {
    $archive = Join-Path $toolsRoot $package
    if (-not (Test-Path $archive)) {
        Invoke-WebRequest -UseBasicParsing "https://repo.msys2.org/mingw/mingw64/$package" -OutFile $archive
    }
    & tar.exe -xf $archive -C $toolsRoot
    if ($LASTEXITCODE -ne 0) { throw "Could not extract $package." }
}
& (Join-Path $toolsRoot 'mingw64\bin\windres.exe') --version
if ($LASTEXITCODE -ne 0) { throw 'Windows resource compiler verification failed.' }
Write-Host 'Ready. Build with: powershell -ExecutionPolicy Bypass -File scripts/build.ps1'
