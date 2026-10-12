// Read-only observer for native rendering tests. Never activates an app,
// changes window order, moves the pointer, or wakes/unlocks the display.
import AppKit
import CoreGraphics
setvbuf(stdout,nil,_IOLBF,0)
while true {
 let app=NSWorkspace.shared.frontmostApplication
 let rows=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],0) as? [[String:Any]] ?? []
 let top=rows.first{ row in
  guard row[kCGWindowLayer as String] as? Int==0,((row[kCGWindowAlpha as String] as? Double) ?? 1)>0.01,let b=row[kCGWindowBounds as String] as? [String:Double] else{return false}
  return (b["Width"] ?? 0)>80 && (b["Height"] ?? 0)>80
 }
 let d=CGSessionCopyCurrentDictionary() as? [String:Any] ?? [:]
 let state:[String:Any] = ["time":Date().timeIntervalSince1970,"frontPID":Int(app?.processIdentifier ?? 0),"topPID":top?[kCGWindowOwnerPID as String] as? Int ?? 0,"topWindow":top?[kCGWindowNumber as String] as? Int ?? 0,"locked":d["CGSSessionScreenIsLocked"] as? Bool ?? false]
 print(String(data:try!JSONSerialization.data(withJSONObject:state),encoding:.utf8)!)
 RunLoop.current.run(until:Date().addingTimeInterval(0.1))
}
