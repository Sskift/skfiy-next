param([string]$Root)
$ErrorActionPreference = 'Stop'
# PowerShell targets an older .NET compatibility profile. Enable the standard
# Ctrl+A behavior for multiline TextBox (introduced in .NET Framework 4.6.1).
[AppContext]::SetSwitch('Switch.System.Windows.Forms.DoNotSupportSelectAllShortcutInMultilineTextBox',$false)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FixtureDpi {
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
}
'@
[FixtureDpi]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$form = New-Object Windows.Forms.Form
$form.Text = 'Skfiy remote input test'
$form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point(100,100)
$form.ClientSize = New-Object Drawing.Size(800,600)
$form.TopMost = $false
$label = New-Object Windows.Forms.Label
$label.Text = 'Disposable test window. No user documents are edited.'
$label.Location = New-Object Drawing.Point(20,15)
$label.Size = New-Object Drawing.Size(750,30)
$text = New-Object Windows.Forms.TextBox
$text.Multiline=$true
$text.Location=New-Object Drawing.Point(20,55)
$text.Size=New-Object Drawing.Size(740,120)
$button = New-Object Windows.Forms.Button
$button.Text='Count 0'
$button.Location=New-Object Drawing.Point(20,195)
$button.Size=New-Object Drawing.Size(160,45)
$scroll = New-Object Windows.Forms.Panel
$scroll.Location=New-Object Drawing.Point(20,265)
$scroll.Size=New-Object Drawing.Size(320,270)
$scroll.AutoScroll=$true
$scroll.TabStop=$true
$scroll.BackColor=[Drawing.Color]::AliceBlue
$content=New-Object Windows.Forms.Label
$content.Location=New-Object Drawing.Point(5,5)
$content.Size=New-Object Drawing.Size(260,1500)
$content.Text=((1..90)|ForEach-Object {"Remote scroll line $_"}) -join "`r`n"
$scroll.Controls.Add($content)
$canvas=New-Object Windows.Forms.Panel
$canvas.Location=New-Object Drawing.Point(390,265)
$canvas.Size=New-Object Drawing.Size(370,270)
$canvas.BackColor=[Drawing.Color]::LightGreen
$form.Controls.AddRange(@($label,$text,$button,$scroll,$canvas))
$script:count=0;$script:right=0;$script:double=0;$script:wheel=0;$script:drag=$false;$script:down=$null;$script:keys=@()
function Rect($control) {
    $p=$control.PointToScreen([Drawing.Point]::Empty)
    return @{x=$p.X;y=$p.Y;width=$control.Width;height=$control.Height}
}
function Save-State {
    $screen=[Windows.Forms.SystemInformation]::VirtualScreen
    $value=@{text=$text.Text;selectionStart=$text.SelectionStart;selectionLength=$text.SelectionLength;keys=$script:keys;clicks=$script:count;right=$script:right;double=$script:double;wheel=$script:wheel;scroll=$scroll.VerticalScroll.Value;drag=$script:drag;field=(Rect $text);button=(Rect $button);canvas=(Rect $canvas);scrollArea=(Rect $scroll);desktop=@{x=$screen.X;y=$screen.Y;width=$screen.Width;height=$screen.Height};session=(Get-Process -Id $PID).SessionId;pid=$PID}
    [IO.File]::WriteAllText((Join-Path $Root 'state.tmp'),($value|ConvertTo-Json -Compress -Depth 4),[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath (Join-Path $Root 'state.tmp') -Destination (Join-Path $Root 'state.json') -Force
}
$text.Add_TextChanged({Save-State})
$text.Add_KeyDown({param($sender,$event) $script:keys+=@{code=[int]$event.KeyCode;control=$event.Control;shift=$event.Shift};Save-State})
$button.Add_Click({$script:count++;$button.Text="Count $script:count";Save-State})
$canvas.Add_MouseDown({param($sender,$event) $script:down=$event.Location;if($event.Button -eq 'Right'){$script:right++};Save-State})
$canvas.Add_MouseDoubleClick({$script:double++;Save-State})
$canvas.Add_MouseUp({param($sender,$event) if($script:down -and [Math]::Abs($event.X-$script:down.X) -gt 30){$script:drag=$true};Save-State})
$content.Add_MouseDown({$scroll.Focus();Save-State})
$scroll.Add_MouseWheel({$script:wheel++;Save-State})
$scroll.Add_Scroll({Save-State})
$form.Add_Shown({$text.Focus();Save-State})
$timer=New-Object Windows.Forms.Timer
$timer.Interval=200
$deadline=[DateTime]::UtcNow.AddMinutes(8)
$timer.Add_Tick({Save-State;if([DateTime]::UtcNow -gt $deadline -or (Test-Path -LiteralPath (Join-Path $Root 'stop'))){$form.Close()}})
$timer.Start()
[Windows.Forms.Application]::Run($form)
$timer.Dispose()
$form.Dispose()
