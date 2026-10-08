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
