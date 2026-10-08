import ApplicationServices
import Foundation

/// Why accessibility may not change anything right now, or nil when it may.
/// Shared by synchronous AX actions and async helpers (file panels, selects).
/// Checked immediately before IPC so interruption cannot resume via a fallback.
func axMutationRefusal() -> String? {
    if EmergencyStop.isStopped { return EmergencyStop.refusal }
    if Task.isCancelled { return "The request was cancelled, so nothing was done." }
    if isScreenLocked() { return "The screen is locked, so nothing was done." }
    return nil
}

/// A refusal comes back as .failure: callers take .cannotComplete for a
/// menu that is still opening, so it must not be that.
func guardedAXPerformAction(_ element: AXUIElement, _ action: CFString) -> AXError {
    guard axMutationRefusal() == nil else { return .failure }
    return AXUIElementPerformAction(element, action)
}

func guardedAXSetAttributeValue(_ element: AXUIElement, _ attribute: CFString, _ value: CFTypeRef) -> AXError {
    guard axMutationRefusal() == nil else { return .failure }
    return AXUIElementSetAttributeValue(element, attribute, value)
}

/// Throws why a guarded call was refused, so no other way of doing it is
/// tried and nothing is reported as done.
func throwIfRefused(_ status: AXError) throws {
    if status == .failure, let refusal = axMutationRefusal() { throw ToolError(refusal) }
}

/// Thin, failure-tolerant wrappers over the AXUIElement C API.
extension AXUIElement {
    func value(_ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(self, attribute as CFString, &value) == .success else {
            return nil
        }
        return value
    }

    func string(_ attribute: String) -> String? {
        value(attribute).flatMap(axString)
    }

    func bool(_ attribute: String) -> Bool? {
        (value(attribute) as? NSNumber)?.boolValue
    }

    func element(_ attribute: String) -> AXUIElement? {
        axElement(value(attribute))
    }

    func elements(_ attribute: String) -> [AXUIElement] {
        (value(attribute) as? [AXUIElement]) ?? []
    }

    var frame: CGRect? {
        let values = multipleValues([kAXPositionAttribute, kAXSizeAttribute])
        return axFrame(position: values[kAXPositionAttribute], size: values[kAXSizeAttribute])
    }

    var pid: pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(self, &pid) == .success ? pid : nil
    }

    /// Fetches several attributes in one IPC round trip; missing ones are omitted.
    func multipleValues(_ attributes: [String]) -> [String: CFTypeRef] {
        var raw: CFArray?
        let status = AXUIElementCopyMultipleAttributeValues(
            self,
            attributes as CFArray,
            AXCopyMultipleAttributeOptions(rawValue: 0),
            &raw
        )
        guard status == .success, let values = raw as? [AnyObject], values.count == attributes.count else {
            var fallback: [String: CFTypeRef] = [:]
            for attribute in attributes {
                if let value = value(attribute) {
                    fallback[attribute] = value
                }
            }
            return fallback
        }
        var result: [String: CFTypeRef] = [:]
        for (attribute, value) in zip(attributes, values) {
            if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError {
                continue
            }
            result[attribute] = value
        }
        return result
    }

    func actionNames() -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(self, &names) == .success else {
            return []
        }
        return (names as? [String]) ?? []
    }

    func isSettable(_ attribute: String) -> Bool {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(self, attribute as CFString, &settable) == .success else {
            return false
        }
        return settable.boolValue
    }

    func perform(_ action: String) throws {
        try check(guardedAXPerformAction(self, action as CFString), "perform \(action)")
    }

    func set(_ attribute: String, _ value: CFTypeRef) throws {
        try check(guardedAXSetAttributeValue(self, attribute as CFString, value), "set \(attribute)")
    }

    /// The first element below this one that matches, breadth first,
    /// looking at no more than `limit` of them.
    func descendant(limit: Int, where matches: (AXUIElement) -> Bool) -> AXUIElement? {
        descendants(limit: limit, first: true, where: matches).first
    }

    /// The elements below this one that match, breadth first, looking at no
    /// more than `limit` of them; with `first`, only the first.
    func descendants(limit: Int, first: Bool = false, where matches: (AXUIElement) -> Bool) -> [AXUIElement] {
        var queue = elements(kAXChildrenAttribute)
        var found: [AXUIElement] = []
        var visited = 0
        while !queue.isEmpty, visited < limit {
            let element = queue.removeFirst()
            visited += 1
            if matches(element) {
                found.append(element)
                if first { break }
            }
            queue.append(contentsOf: element.elements(kAXChildrenAttribute))
        }
        return found
    }

    /// The closest element above this one with `role`, up to 30 levels up.
    func ancestor(role: String) -> AXUIElement? {
        var current = element(kAXParentAttribute)
        for _ in 0..<30 {
            guard let candidate = current else { return nil }
            if candidate.string(kAXRoleAttribute) == role { return candidate }
            current = candidate.element(kAXParentAttribute)
        }
        return nil
    }
}

/// An attribute value that is an element, or nil.
func axElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

/// "AXButton" → "Button", for display.
func withoutAXPrefix(_ name: String) -> String {
    name.hasPrefix("AX") ? String(name.dropFirst(2)) : name
}

func check(_ status: AXError, _ context: String) throws {
    guard status != .success else { return }
    try throwIfRefused(status)
    throw ToolError(axMessage(status, context))
}

func axMessage(_ status: AXError, _ context: String) -> String {
    switch status {
    case .apiDisabled:
        return "Accessibility access is not granted (\(context)). Run `skfiy doctor`."
    case .invalidUIElement:
        return "The element no longer exists (\(context)). Call get_app_state to refresh the element indices."
    case .cannotComplete:
        return "The app did not respond in time (\(context)). It may be busy; retry or call get_app_state."
    case .actionUnsupported:
        return "The element does not support that action (\(context))."
    case .attributeUnsupported:
        return "The element does not support that attribute (\(context))."
    case .illegalArgument:
        return "The app rejected the value (\(context))."
    case .notImplemented:
        return "The app does not implement that accessibility feature (\(context))."
    default:
        return "Accessibility call failed with code \(status.rawValue) (\(context))."
    }
}

func axString(_ value: CFTypeRef) -> String? {
    if let string = value as? String {
        return string
    }
    if let attributed = value as? NSAttributedString {
        return attributed.string
    }
    return nil
}

/// Renders scalar attribute values (strings, numbers, booleans) for display.
func axDisplayValue(_ value: CFTypeRef) -> String? {
    if let string = axString(value) {
        return string
    }
    if CFGetTypeID(value) == CFBooleanGetTypeID() {
        return CFBooleanGetValue((value as! CFBoolean)) ? "true" : "false"
    }
    if let number = value as? NSNumber {
        let double = number.doubleValue
        if double.rounded() == double, abs(double) < 1e15 {
            return String(Int64(double))
        }
        return String(format: "%.4g", double)
    }
    return nil
}

func axFrame(position: CFTypeRef?, size: CFTypeRef?) -> CGRect? {
    guard let position, let size,
          CFGetTypeID(position) == AXValueGetTypeID(),
          CFGetTypeID(size) == AXValueGetTypeID() else {
        return nil
    }
    var point = CGPoint.zero
    var extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(size as! AXValue, .cgSize, &extent) else {
        return nil
    }
    return CGRect(origin: point, size: extent)
}

public struct ToolError: Error, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

/// Text in accessibility elements: the caret, the selection, where a click
/// would put the caret, and a value read back after a change.
extension ComputerUse {
    /// The app's focused element, when it takes text.
    func focusedTextElement(_ pid: pid_t) -> AXUIElement? {
        focusedElement(pid).flatMap { isTextLike($0) ? $0 : nil }
    }

    func ancestor(of element: AXUIElement, levels: Int, where matches: (AXUIElement) -> Bool) -> AXUIElement? {
        var current: AXUIElement? = element
        for _ in 0...levels {
            guard let candidate = current else { return nil }
            if matches(candidate) {
                return candidate
            }
            let role = candidate.string(kAXRoleAttribute) ?? ""
            if role == "AXWindow" || role == "AXApplication" || role == "AXWebArea" {
                return nil
            }
            current = candidate.element(kAXParentAttribute)
        }
        return nil
    }

    /// The caret index a click at `point` would produce.
    func textIndex(in element: AXUIElement, at point: CGPoint) -> Int? {
        let length = (element.string(kAXValueAttribute) as NSString?)?.length ?? 0
        // Below the last line a click lands at the end; AXRangeForPosition says 0.
        if length > 0, let last = textBounds(in: element, range: CFRange(location: length - 1, length: 1)),
           point.y > last.maxY {
            return length
        }
        var position = point
        guard let value = AXValueCreate(.cgPoint, &position) else { return nil }
        var result: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, "AXRangeForPosition" as CFString, value, &result) == .success,
              let result, CFGetTypeID(result) == AXValueGetTypeID() else {
            return nil
        }
        var range = CFRange()
        return AXValueGetValue(result as! AXValue, .cfRange, &range) ? range.location : nil
    }

    private func textBounds(in element: AXUIElement, range: CFRange) -> CGRect? {
        var range = range
        guard let value = AXValueCreate(.cfRange, &range) else { return nil }
        var result: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, "AXBoundsForRange" as CFString, value, &result) == .success,
              let result, CFGetTypeID(result) == AXValueGetTypeID() else {
            return nil
        }
        var rect = CGRect.zero
        return AXValueGetValue(result as! AXValue, .cgRect, &rect) && rect.height > 0 ? rect : nil
    }

    func setCaret(_ element: AXUIElement, _ location: Int) {
        try? setSelection(element, CFRange(location: location, length: 0))
    }

    /// The selected range of a text element, when it reports one.
    func selectedRange(_ element: AXUIElement) -> CFRange? {
        guard let value = element.value(kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var range = CFRange(location: 0, length: 0)
        return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil
    }

    func setSelection(_ element: AXUIElement, _ range: CFRange) throws {
        var selection = range
        guard let value = AXValueCreate(.cfRange, &selection) else {
            throw ToolError("Could not build the selection range.")
        }
        try element.set(kAXSelectedTextRangeAttribute, value)
    }

    /// A web field's value as accessibility reports it after a change:
    /// Chromium updates its tree asynchronously, so a read right after
    /// setting can still show the old value for a moment.
    func settledValue(_ element: AXUIElement, expecting: String? = nil, changedFrom: String? = nil) async -> String? {
        let timeout = 0.6
        let started = Date()
        var value = element.string(kAXValueAttribute)
        while Date().timeIntervalSince(started) < timeout {
            if let expecting, value == expecting { return value }
            if let changedFrom, value != changedFrom { return value }
            if expecting == nil, changedFrom == nil { return value }
            await Input.pause(0.05)
            value = element.string(kAXValueAttribute)
        }
        return value
    }
}
