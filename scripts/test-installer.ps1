# Destructive installation/registry tests: disposable GitHub-hosted Windows only.
param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Run this test only on a disposable GitHub-hosted Windows runner.'
}
$Installer = (Resolve-Path $Installer).Path
$destination = Join-Path $env:RUNNER_TEMP 'Paper install 中文 space'
$classes = 'HKCU:\Software\Classes'
$progId = 'studio.paper.reader.Markdown'
$capabilities = 'Software\studio.paper.reader\Capabilities'
$exe = Join-Path $destination 'paper-reader.exe'
$command = '"' + $exe + '" "%1"'
function Assert($Condition, $Message) { if (!$Condition) { throw $Message } }
function DefaultValue($Path) {
  if (Test-Path $Path) { return (Get-Item $Path).GetValue('') }
  return $null
}
function UserChoices {
  $result = @{}
  foreach ($ext in @('md', 'markdown', 'mdown')) {
    $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.$ext\UserChoice"
    $result[$ext] = if (Test-Path $key) { (Get-ItemProperty $key | Select-Object * -ExcludeProperty PS*) | ConvertTo-Json -Compress } else { $null }
  }
  return $result | ConvertTo-Json -Compress
}
function Install {
  $process = Start-Process -FilePath $Installer -ArgumentList "/S /D=$destination" -Wait -PassThru
  Assert ($process.ExitCode -eq 0) "Install failed: $($process.ExitCode)"
  Assert (Test-Path $exe) 'Installed executable missing'
}
function Uninstall {
  $uninstaller = Join-Path $destination 'uninstall.exe'
  $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
  Assert ($process.ExitCode -eq 0) "Uninstall failed: $($process.ExitCode)"
  for ($i = 0; $i -lt 60 -and (Test-Path $exe); $i++) { Start-Sleep -Seconds 1 }
  Assert (!(Test-Path $exe)) 'Executable remains after uninstall'
  # NSIS may spawn a temporary uninstaller; wait for its post-uninstall hook.
  Start-Sleep -Seconds 2
}
Assert (!(Test-Path "$classes\$progId")) 'Unexpected prior Paper registration on runner'
$choices = UserChoices
New-Item "$classes\.md\OpenWithProgids" -Force | Out-Null
Set-Item "$classes\.md" -Value 'PaperAssociationTest.Other'
New-ItemProperty "$classes\.md\OpenWithProgids" -Name 'PaperAssociationTest.Other' -Value '' -PropertyType String -Force | Out-Null
$defaults = @{}
foreach ($ext in @('md','markdown','mdown')) { $defaults[$ext] = DefaultValue "$classes\.$ext" }
Install
Assert ((DefaultValue "$classes\$progId\shell\open\command") -ceq $command) 'Command must quote executable and %1'
foreach ($ext in @('md','markdown','mdown')) {
  Assert ((DefaultValue "$classes\.$ext") -ceq $defaults[$ext]) "Changed .$ext default"
  Assert ((Get-Item "$classes\.$ext\OpenWithProgids").GetValueNames() -contains $progId) "Missing .$ext Open With candidate"
  Assert ((Get-Item "HKCU:\$capabilities\FileAssociations").GetValue(".$ext") -eq $progId) "Missing .$ext capability"
}
Assert ((Get-Item 'HKCU:\Software\RegisteredApplications').GetValue('Paper') -eq $capabilities) 'Missing Default Apps registration'
Assert ((UserChoices) -ceq $choices) 'UserChoice changed during installation'
node tests/native-smoke.mjs $exe
if ($LASTEXITCODE -ne 0) { throw 'Installed app native smoke failed' }
# Simulate a newer installation taking ownership. Old uninstall must leave it.
$newerCommand = '"C:\Paper newer\paper-reader.exe" "%1"'
Set-Item "$classes\$progId\shell\open\command" -Value $newerCommand
Uninstall
Assert ((DefaultValue "$classes\$progId\shell\open\command") -ceq $newerCommand) 'Old uninstall removed newer owner'
Assert ((Get-Item "$classes\.md\OpenWithProgids").GetValueNames() -contains $progId) 'Old uninstall removed newer candidate'
Install
Uninstall
Assert (!(Test-Path "$classes\$progId")) 'Owned ProgID remains'
Assert (!(Test-Path "HKCU:\$capabilities")) 'Owned capabilities remain'
Assert (!((Get-Item 'HKCU:\Software\RegisteredApplications').GetValueNames() -contains 'Paper')) 'Owned app registration remains'
foreach ($ext in @('md','markdown','mdown')) {
  Assert ((DefaultValue "$classes\.$ext") -ceq $defaults[$ext]) "Uninstall changed .$ext default"
  if (Test-Path "$classes\.$ext\OpenWithProgids") {
    Assert (!((Get-Item "$classes\.$ext\OpenWithProgids").GetValueNames() -contains $progId)) "Owned .$ext candidate remains"
  }
}
Assert ((Get-Item "$classes\.md\OpenWithProgids").GetValueNames() -contains 'PaperAssociationTest.Other') 'Another app candidate removed'
Assert ((UserChoices) -ceq $choices) 'UserChoice changed during uninstall'
Write-Host 'PASS: registration, quoted paths, default preservation, native opening, ownership-safe uninstall.'
