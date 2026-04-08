# setup_scheduler.ps1
# Execute no PowerShell como Administrador:
#   Right-click no PowerShell → Run as Administrator
#   cd "C:\Users\caiom\OneDrive\Área de Trabalho\HLTV"
#   .\setup_scheduler.ps1
#
# Para rodar em horário diferente:
#   .\setup_scheduler.ps1 -Hour 8 -Minute 0

param(
    [int]$Hour   = 6,
    [int]$Minute = 0
)

$TaskName  = "VRS_ELO_DailyUpdate"
$BatchFile = "C:\Users\caiom\OneDrive\Área de Trabalho\HLTV\update.bat"
$WorkDir   = "C:\Users\caiom\OneDrive\Área de Trabalho\HLTV"

Write-Host "Configurando tarefa: $TaskName" -ForegroundColor Cyan
Write-Host "Script: $BatchFile"
Write-Host "Horario: $($Hour.ToString('00')):$($Minute.ToString('00')) diariamente"

# Remove tarefa existente se houver
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Tarefa anterior removida." -ForegroundColor Yellow
}

$Action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"$BatchFile`" >> `"$WorkDir\logs\scheduler.log`" 2>&1" `
    -WorkingDirectory $WorkDir

$Trigger = New-ScheduledTaskTrigger `
    -Daily `
    -At "$($Hour.ToString('00')):$($Minute.ToString('00'))"

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 30) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Atualiza VRS ELO ranking diariamente e publica no GitHub Pages" `
    -RunLevel Highest `
    -Force | Out-Null

Write-Host ""
Write-Host "Tarefa '$TaskName' criada!" -ForegroundColor Green
Write-Host "Proxima execucao: amanha as $($Hour.ToString('00')):$($Minute.ToString('00'))"
Write-Host ""
Write-Host "Para testar agora:" -ForegroundColor Yellow
Write-Host "   Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "Para ver o status:" -ForegroundColor Yellow
Write-Host "   Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host ""
Write-Host "Para remover:" -ForegroundColor Yellow
Write-Host "   Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
