#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <objc/runtime.h>

// Test-only injection into skfiy: SCK accepts requests but never calls back.
// The system screencapture executable is not injected (macOS strips DYLD).
static void stalled(id self, SEL selector, id filter, id configuration, id completion) {}
static void stalledList(id self, SEL selector, BOOL exclude, BOOL onscreen, id completion) {}
__attribute__((constructor)) static void installStall(void) {
#ifdef STALL_LIST
    Method method = class_getClassMethod(SCShareableContent.class,
        @selector(getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:completionHandler:));
    if (method) method_setImplementation(method, (IMP)stalledList);
#else
    Method method = class_getClassMethod(SCScreenshotManager.class,
        @selector(captureImageWithFilter:configuration:completionHandler:));
    if (method) method_setImplementation(method, (IMP)stalled);
#endif
}
