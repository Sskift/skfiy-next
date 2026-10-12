// TEST ONLY. macOS versions and active screen capture can suppress natural
// occlusion notifications. Override the state of our own fixture's window and
// post the real AppKit notification, exercising Electron's native WasOccluded
// path. This addon is never loaded into user applications or shipped in skfiy.
#include <node_api.h>
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <cstring>

static NSMutableSet<NSNumber *> *forced;
static NSWindowOcclusionState (*originalState)(id, SEL);
static NSWindowOcclusionState state(id object, SEL selector) {
  return [forced containsObject:@([(NSWindow *)object windowNumber])]
      ? 0 : originalState(object, selector);
}

static napi_value setOccluded(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  void *data = nullptr;
  size_t length = 0;
  bool enabled = false;
  if (argc != 2 || napi_get_buffer_info(env, args[0], &data, &length) != napi_ok ||
      length != sizeof(void *) || napi_get_value_bool(env, args[1], &enabled) != napi_ok) {
    napi_throw_error(env, nullptr, "expected native window handle and boolean");
    return nullptr;
  }
  NSView *view;
  memcpy(&view, data, sizeof(view));
  NSWindow *window = view.window;
  if (!originalState) {
    forced = [NSMutableSet new];
    Class cls = [window class];
    Method method = class_getInstanceMethod(cls, @selector(occlusionState));
    originalState = (NSWindowOcclusionState (*)(id, SEL))method_getImplementation(method);
    if (!class_addMethod(cls, @selector(occlusionState), (IMP)state, method_getTypeEncoding(method)))
      method_setImplementation(method, (IMP)state);
  }
  if (enabled) [forced addObject:@(window.windowNumber)];
  else [forced removeObject:@(window.windowNumber)];
  [[NSNotificationCenter defaultCenter]
      postNotificationName:NSWindowDidChangeOcclusionStateNotification object:window];
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "setOccluded", NAPI_AUTO_LENGTH, setOccluded, nullptr, &function);
  napi_set_named_property(env, exports, "setOccluded", function);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
