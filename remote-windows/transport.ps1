# Fixed SSH entry point; the only variable input is a JSON line on stdin.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$root = Join-Path $env:LOCALAPPDATA 'skfiy\desktop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskName = "Skfiy Desktop $sid"
try {
    $q = [Console]::In.ReadLine() | ConvertFrom-Json
    if ($q.operation -eq 'install') {
        [IO.Directory]::CreateDirectory($root) | Out-Null
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true,$false)
        foreach ($account in @($sid,'S-1-5-18','S-1-5-32-544')) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($account),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $root -AclObject $acl
        $worker = Join-Path $root 'worker.ps1'
        $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($existing -and $existing.State -eq 'Running') { throw 'Remote worker is running. Wait two minutes for idle exit before updating.' }
        [IO.File]::WriteAllBytes($worker,[Convert]::FromBase64String($q.worker))
        $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $action = New-ScheduledTaskAction -Execute $exe -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$worker+'"')
        $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
        [Console]::WriteLine((@{ok=$true;protocol=1;computer=$env:COMPUTERNAME;user=$env:USERNAME}|ConvertTo-Json -Compress))
    } elseif ($q.operation -eq 'remove') {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($task) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
        if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
        [Console]::WriteLine('{"ok":true,"protocol":1}')
    } elseif ($q.operation -eq 'call') {
        if ($q.computer -ne $env:COMPUTERNAME -or $q.user -ne $env:USERNAME) { throw 'Remote identity changed. No input sent; check the SSH binding.' }
        if ($q.request.id -notmatch '^[a-f0-9]{32}$') { throw 'Invalid request id.' }
        if (!(Test-Path -LiteralPath (Join-Path $root 'worker.ps1'))) { throw 'Run skfiy remote add first.' }
        # COM avoids importing the ScheduledTasks CIM module for every click.
        $scheduler = New-Object -ComObject Schedule.Service
        $scheduler.Connect()
        $task = $scheduler.GetFolder('\').GetTask($taskName)
        # Start before queuing: a worker exiting after idle must not strand input.
        if ($task.State -ne 4) {
            Remove-Item -LiteralPath (Join-Path $root 'startup-error.txt') -ErrorAction SilentlyContinue
            $null = $task.Run($null)
        }
        $id = $q.request.id
        $request = Join-Path $root "$id.request"
        $reply = Join-Path $root "$id.reply"
        $tmp = Join-Path $root "$id.upload"
        try {
            [IO.File]::WriteAllText($tmp,($q.request|ConvertTo-Json -Compress -Depth 5),[Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $tmp -Destination $request
            $deadline = [DateTime]::UtcNow.AddSeconds(25)
            while (!(Test-Path -LiteralPath $reply)) {
                if (Test-Path -LiteralPath (Join-Path $root 'startup-error.txt')) { throw ([IO.File]::ReadAllText((Join-Path $root 'startup-error.txt'))) }
                if ([DateTime]::UtcNow -gt $deadline) { throw 'Remote response timed out. Input may have executed; inspect state before retrying.' }
                Start-Sleep -Milliseconds 80
            }
            [Console]::WriteLine([IO.File]::ReadAllText($reply))
        } finally {
            Remove-Item -LiteralPath $tmp,$request,$reply -Force -ErrorAction SilentlyContinue
        }
    } else { throw 'Unknown transport operation.' }
} catch { [Console]::WriteLine((@{ok=$false;protocol=1;error=$_.Exception.Message}|ConvertTo-Json -Compress)) }
# Nonexistent optional cleanup files must not turn a valid JSON reply into an
# SSH process failure through PowerShell's final-command status.
exit 0
