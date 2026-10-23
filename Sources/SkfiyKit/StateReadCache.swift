import ApplicationServices
import Foundation

/// Opt-in incremental reads have a bounded age even when an app omits AX
/// notifications. Structural changes discard everything; value changes only
/// discard the announced node. A full read is forced every 2 s or 4 looks.
final class StateReadCache<Key: Hashable, Value> {
    private var values: [Key: Value] = [:]
    private var refreshed = -Double.infinity
    private var looks = 0
    private(set) var hits = 0
    private(set) var misses = 0

    func begin(reuse: Bool, now: Double = ProcessInfo.processInfo.systemUptime) {
        if !reuse || now - refreshed >= 2 || looks >= 4 {
            values.removeAll(); refreshed = now; looks = 0
        }
        looks += 1; hits = 0; misses = 0
    }

    func read(_ key: Key, _ load: () -> Value) -> Value {
        if let value = values[key] { hits += 1; return value }
        misses += 1
        let value = load()
        if values.count < 5000 { values[key] = value }
        return value
    }

    func invalidate(_ key: Key? = nil) {
        if let key { values[key] = nil } else { values.removeAll() }
    }
}

final class TreeReadCache {
    let attributes = StateReadCache<ElementKey, [String: CFTypeRef]>()
    let details = StateReadCache<ElementKey, NodeDetails>()

    func begin(reuse: Bool) { attributes.begin(reuse: reuse); details.begin(reuse: reuse) }
    func invalidate(_ element: AXUIElement? = nil) {
        attributes.invalidate(element.map(ElementKey.init)); details.invalidate(element.map(ElementKey.init))
    }
}

@MainActor
final class ObservedTreeCache {
    let cache = TreeReadCache()
    let events: AXChangeEvents

    init?(pid: pid_t) {
        guard let events = AXChangeEvents(pid: pid) else { return nil }
        self.events = events
        events.onChange = { [weak self] element, notification in
            self?.cache.invalidate(notification == kAXValueChangedNotification ? element : nil)
        }
    }
}
