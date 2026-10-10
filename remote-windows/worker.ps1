# Runs only as the SSH user's interactive, unelevated scheduled task.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Join-Path $env:LOCALAPPDATA 'skfiy\desktop'
try {
Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
public class DesktopFrame {
    public string id, image, title;
    public int x, y, width, height, imageWidth, imageHeight;
    public long foreground;
    public DateTime time;
    public List<DesktopWindow> windows = new List<DesktopWindow>();
}
public class DesktopWindow { public long id; public int left, top, right, bottom; }
public static class SkfiyDesktop {
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; public POINT(int a,int b){x=a;y=b;} }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int left,top,right,bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MI { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KI { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MI mouse; [FieldOffset(0)] public KI key; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr param);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd,uint attr,out int value,int size);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder title,int count);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj,int index,StringBuilder info,int length,out int needed);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
    public static void Ready() {
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        if(Process.GetCurrentProcess().SessionId == 0) throw new Exception("No interactive user session. Sign in on Windows first.");
        IntPtr d=OpenInputDesktop(0,false,1); int needed;
        if(d==IntPtr.Zero) throw new Exception("Remote desktop is locked, secure, or unavailable. No input sent.");
        try { var n=new StringBuilder(256); if(!GetUserObjectInformation(d,2,n,512,out needed) || n.ToString()!="Default") throw new Exception("Remote desktop is locked or secure. No input sent."); }
        finally {CloseDesktop(d);}
    }
    public static DesktopFrame Capture() {
        Ready();
        var f=new DesktopFrame(); f.id=Guid.NewGuid().ToString("N"); f.time=DateTime.UtcNow;
        f.x=GetSystemMetrics(76); f.y=GetSystemMetrics(77); f.width=GetSystemMetrics(78); f.height=GetSystemMetrics(79);
        if(f.width<1 || f.height<1 || (long)f.width*f.height>80000000) throw new Exception("Unsupported remote display dimensions.");
        f.foreground=GetForegroundWindow().ToInt64(); var title=new StringBuilder(512); GetWindowText(new IntPtr(f.foreground),title,512); f.title=title.ToString();
        EnumWindows(delegate(IntPtr h,IntPtr p) { RECT r;int cloaked;DwmGetWindowAttribute(h,14,out cloaked,4);if(cloaked==0 && IsWindowVisible(h) && GetWindowRect(h,out r) && r.right>r.left && r.bottom>r.top) f.windows.Add(new DesktopWindow {id=h.ToInt64(),left=r.left,top=r.top,right=r.right,bottom=r.bottom}); return true; },IntPtr.Zero);
        double scale=Math.Min(1.0,1600.0/f.width); f.imageWidth=(int)Math.Round(f.width*scale); f.imageHeight=(int)Math.Round(f.height*scale);
        using(var full=new Bitmap(f.width,f.height)) {
            using(var g=Graphics.FromImage(full)) g.CopyFromScreen(f.x,f.y,0,0,full.Size,CopyPixelOperation.SourceCopy);
            using(var small=new Bitmap(full,new Size(f.imageWidth,f.imageHeight))) using(var stream=new MemoryStream()) { small.Save(stream,ImageFormat.Jpeg); f.image=Convert.ToBase64String(stream.ToArray()); }
        }
        return f;
    }
    public static void Validate(DesktopFrame f,bool keyboard) {
        Ready();
        if(f==null || (DateTime.UtcNow-f.time).TotalSeconds>30) throw new Exception("Screenshot expired. Request state again; no input sent.");
        if(f.x!=GetSystemMetrics(76) || f.y!=GetSystemMetrics(77) || f.width!=GetSystemMetrics(78) || f.height!=GetSystemMetrics(79)) throw new Exception("Display layout changed. Request state again.");
        if(keyboard && f.foreground!=GetForegroundWindow().ToInt64()) throw new Exception("Remote foreground window changed. Request state again.");
    }
    static POINT Point(DesktopFrame f,int x,int y) {
        if(x<0 || y<0 || x>=f.imageWidth || y>=f.imageHeight) throw new Exception("Coordinates outside the remote screenshot.");
        return new POINT(f.x+(int)((long)x*f.width/f.imageWidth),f.y+(int)((long)y*f.height/f.imageHeight));
    }
    static void Target(DesktopFrame f,POINT p) {
        Validate(f,false); DesktopWindow target=null;
        foreach(var w in f.windows) if(p.x>=w.left && p.x<w.right && p.y>=w.top && p.y<w.bottom){target=w;break;}
        var current=GetAncestor(WindowFromPoint(p),2); RECT r;
        if(target==null || target.id!=current.ToInt64() || !GetWindowRect(current,out r) || r.left!=target.left || r.top!=target.top || r.right!=target.right || r.bottom!=target.bottom) throw new Exception("Window at the target moved or changed. Request state again.");
    }
    static void Send(params INPUT[] events) {
        uint sent=SendInput((uint)events.Length,events,Marshal.SizeOf(typeof(INPUT)));
        if(sent==events.Length)return;
        // A partial insertion must not leave a modifier or mouse button held.
        var release=new List<INPUT>();
        for(int i=0;i<sent;i++){
            var e=events[i];
            if(e.type==1 && (e.u.key.flags&2)==0){e.u.key.flags|=2;release.Add(e);}
            if(e.type==0 && (e.u.mouse.flags&10)!=0){e.u.mouse.flags=(e.u.mouse.flags&~10u)|((e.u.mouse.flags&2)!=0?4u:16u);release.Add(e);}
        }
        if(release.Count>0)SendInput((uint)release.Count,release.ToArray(),Marshal.SizeOf(typeof(INPUT)));
        throw new Exception("Windows rejected input (the target may be elevated). Some input may have been sent; inspect state before retrying.");
    }
    static INPUT Mouse(uint flags,int data,POINT p,DesktopFrame f) { return new INPUT {type=0,u=new UNION {mouse=new MI {dx=(int)((long)(p.x-f.x)*65535/Math.Max(1,f.width-1)),dy=(int)((long)(p.y-f.y)*65535/Math.Max(1,f.height-1)),data=unchecked((uint)data),flags=flags|0xC000}}}; }
    static INPUT Key(ushort vk,bool up,ushort unicode=0) { return new INPUT {type=1,u=new UNION {key=new KI {vk=vk,scan=unicode,flags=(up?2u:0u)|(unicode!=0?4u:((vk>=33 && vk<=46)||vk==91?1u:0u))}}}; }
    static void ModifiersFree() { foreach(int k in new[]{16,17,18,91,92}) if((GetAsyncKeyState(k)&0x8000)!=0) throw new Exception("A remote modifier key is held. Release it before sending input."); }
    public static void Click(DesktopFrame f,int x,int y,string button,int count) {
        if(count<1 || count>2 || (button!="left" && button!="right")) throw new Exception("Invalid mouse button or click count.");
        ModifiersFree(); var p=Point(f,x,y); Target(f,p); uint down=button=="right"?8u:2u,up=button=="right"?16u:4u;
        for(int i=0;i<count;i++){Validate(f,false); Send(Mouse(1,0,p,f),Mouse(down,0,p,f),Mouse(up,0,p,f)); if(i+1<count)Thread.Sleep(60);}
    }
    public static void Scroll(DesktopFrame f,int x,int y,string direction,int amount) {
        if(amount<1 || amount>10 || !new List<string>{"up","down","left","right"}.Contains(direction))throw new Exception("Invalid scroll direction or amount.");
        ModifiersFree(); var p=Point(f,x,y);Target(f,p); bool horizontal=direction=="left"||direction=="right";
        int delta=120*amount*((direction=="down"||direction=="left")?-1:1); Send(Mouse(1,0,p,f),Mouse(horizontal?0x1000u:0x800u,delta,p,f));
    }
    public static void Drag(DesktopFrame f,int x,int y,int tx,int ty) {
        ModifiersFree(); var a=Point(f,x,y);var b=Point(f,tx,ty);Target(f,a);Send(Mouse(1,0,a,f),Mouse(2,0,a,f));
        var p=a;try {for(int i=1;i<=15;i++){Validate(f,false);p=new POINT(a.x+(b.x-a.x)*i/15,a.y+(b.y-a.y)*i/15);Send(Mouse(1,0,p,f));Thread.Sleep(20);}}finally{Send(Mouse(4,0,p,f));}
    }
    public static void Type(DesktopFrame f,string text) {
        if(text==null || text.Length<1 || text.Length>2000)throw new Exception("Text must contain 1-2000 UTF-16 units.");
        ModifiersFree(); foreach(char c in text){Validate(f,true); if(c=='\n')Send(Key(13,false),Key(13,true));else if(c=='\t')Send(Key(9,false),Key(9,true));else if(c!='\r')Send(Key(0,false,c),Key(0,true,c));}
    }
    public static void Press(DesktopFrame f,string chord) {
        if(chord==null)throw new Exception("Missing key.");
        var parts=chord.ToLowerInvariant().Split('+');var mods=new List<ushort>();
        for(int i=0;i<parts.Length-1;i++){ushort m;switch(parts[i]){case "ctrl":case "control":m=17;break;case "alt":m=18;break;case "shift":m=16;break;case "win":m=91;break;default:throw new Exception("Use ctrl, alt, shift, or win modifiers.");}if(mods.Contains(m))throw new Exception("Repeated modifier.");mods.Add(m);}
        string key=parts[parts.Length-1];ushort vk;
        switch(key){case "enter":case "return":vk=13;break;case "backspace":vk=8;break;case "escape":case "esc":vk=27;break;case "space":vk=32;break;case "delete":vk=46;break;case "tab":vk=9;break;case "left":vk=37;break;case "up":vk=38;break;case "right":vk=39;break;case "down":vk=40;break;case "home":vk=36;break;case "end":vk=35;break;case "pageup":vk=33;break;case "pagedown":vk=34;break;
        default:int n;if(key.Length==1 && char.IsLetterOrDigit(key[0]) && key[0]<128)vk=(ushort)char.ToUpperInvariant(key[0]);else if(key.StartsWith("f") && int.TryParse(key.Substring(1),out n) && n>=1 && n<=12)vk=(ushort)(111+n);else throw new Exception("Unsupported key. Use type for literal text.");break;}
        Validate(f,true);ModifiersFree();var events=new List<INPUT>();foreach(var m in mods)events.Add(Key(m,false));events.Add(Key(vk,false));events.Add(Key(vk,true));mods.Reverse();foreach(var m in mods)events.Add(Key(m,true));Send(events.ToArray());
    }
}
'@
} catch {
    [IO.File]::WriteAllText((Join-Path $root 'startup-error.txt'),$_.Exception.Message)
    exit 1
}
$frames = @{}
$idle = [DateTime]::UtcNow.AddSeconds(120)
while ([DateTime]::UtcNow -lt $idle) {
    foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter '*.request')) {
        $id = $file.BaseName
        if ($id -notmatch '^[a-f0-9]{32}$') { continue }
        $working = Join-Path $root "$id.working"
        try { Move-Item -LiteralPath $file.FullName -Destination $working -ErrorAction Stop } catch { continue }
        $idle = [DateTime]::UtcNow.AddSeconds(120)
        try {
            $q = [IO.File]::ReadAllText($working) | ConvertFrom-Json
            Remove-Item -LiteralPath $working -Force
            if ($q.protocol -ne 1 -or $q.id -ne $id) { throw 'Protocol mismatch.' }
            if ([DateTime]::UtcNow -gt [DateTime]::Parse($q.expires).ToUniversalTime()) { throw 'Request expired. No input sent.' }
            foreach ($old in @($frames.Keys)) { if (([DateTime]::UtcNow - $frames[$old].time).TotalSeconds -gt 30) { $frames.Remove($old) } }
            if ($q.action -ne 'state') {
                $frame = $frames[[string]$q.frame_id]
                if (!$frame) { throw 'Unknown or expired frame_id. Request state first; no input sent.' }
                # Consume once, including failed attempts. Never replay an input request.
                $frames.Remove([string]$q.frame_id)
                switch ($q.action) {
                    'click' { [SkfiyDesktop]::Click($frame,$q.x,$q.y,$q.button,$q.count) }
                    'scroll' { [SkfiyDesktop]::Scroll($frame,$q.x,$q.y,$q.direction,$q.amount) }
                    'drag' { [SkfiyDesktop]::Drag($frame,$q.x,$q.y,$q.to_x,$q.to_y) }
                    'type' { [SkfiyDesktop]::Type($frame,$q.text) }
                    'key' { [SkfiyDesktop]::Press($frame,$q.key) }
                    default { throw 'Unknown remote action.' }
                }
                Start-Sleep -Milliseconds 180
            }
            $f = [SkfiyDesktop]::Capture()
            if ($frames.Count -ge 20) { $frames.Clear() }
            $frames[$f.id] = $f
            $reply = @{ok=$true;protocol=1;frame_id=$f.id;computer=$env:COMPUTERNAME;user=$env:USERNAME;session=(Get-Process -Id $PID).SessionId;width=$f.imageWidth;height=$f.imageHeight;desktop_width=$f.width;desktop_height=$f.height;foreground=$f.foreground.ToString();title=$f.title;image=$f.image}
        } catch { $reply = @{ok=$false;protocol=1;error=$_.Exception.Message} }
        $tmp = Join-Path $root "$id.tmp"
        [IO.File]::WriteAllText($tmp,($reply|ConvertTo-Json -Compress -Depth 5),[Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tmp -Destination (Join-Path $root "$id.reply") -Force
        Remove-Variable q,reply -ErrorAction SilentlyContinue
    }
    Get-ChildItem -LiteralPath $root | Where-Object { $_.Extension -in '.request','.working','.reply','.tmp','.upload' -and $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddSeconds(-60) } | Remove-Item -Force
    Start-Sleep -Milliseconds 80
}
