import ApplicationServices
import Foundation

/// Accessibility notifications from one app, so a wait reads the tree when
/// the app says something changed instead of every few hundred
/// milliseconds. Not every change is announced, so waits still look at a
/// slow pace in between.
@MainActor
final class AXChangeEvents {
    static let notifications: [String] = [
        kAXValueChangedNotification, kAXUIElementDestroyedNotification, kAXCreatedNotification,
        kAXFocusedWindowChangedNotification, kAXFocusedUIElementChangedNotification, kAXWindowCreatedNotification,
        kAXWindowMiniaturizedNotification, kAXWindowDeminiaturizedNotification, kAXWindowMovedNotification, kAXWindowResizedNotification,
        kAXTitleChangedNotification, kAXLayoutChangedNotification, kAXSelectedChildrenChangedNotification,
        kAXSelectedTextChangedNotification, kAXSelectedRowsChangedNotification, kAXRowCountChangedNotification,
        kAXMenuOpenedNotification, kAXMenuClosedNotification, "AXSheetCreated", kAXDrawerCreatedNotification,
        kAXAnnouncementRequestedNotification, kAXApplicationHiddenNotification, kAXApplicationShownNotification
    ]

    private var observer: AXObserver?
    /// Notifications received, and kinds the app accepted.
    private(set) var received = 0
    private(set) var registered = 0
    var onChange: ((AXUIElement, String) -> Void)?
    private var lastChange: Double?
    private var pending = false
    private var waiter: CheckedContinuation<Void, Never>?
    private var timer: Task<Void, Never>?
    private var debounce: Task<Void, Never>?

    init?(pid: pid_t) {
        var created: AXObserver?
        guard AXObserverCreate(pid, axChangeCallback, &created) == .success, let created else { return nil }
        observer = created
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for name in Self.notifications where AXObserverAddNotification(created, app, name as CFString, refcon) == .success {
            registered += 1
        }
        guard registered > 0 else {
            observer = nil
            return nil
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .defaultMode)
    }

    /// Returns when a change is announced (after a short pause, so a burst
    /// counts once), or after `seconds`; at once when one came since the
    /// last wait.
    func wait(upTo seconds: Double) async {
        if pending {
            pending = false
            return
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                waiter = continuation
                timer = Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
                    if !Task.isCancelled { self?.resume() }
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.resume() }
        }
    }

    fileprivate func fire(_ element: AXUIElement, _ notification: String) {
        received += 1
        lastChange = ProcessInfo.processInfo.systemUptime
        onChange?(element, notification)
        guard waiter != nil else {
            pending = true
            return
        }
        guard debounce == nil else { return }
        debounce = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 60_000_000)
            if !Task.isCancelled { self?.resume() }
        }
    }

    /// Return after an announced change goes quiet. Apps without useful
    /// notifications keep the configured fallback delay.
    func settle(upTo seconds: Double, quietFor quiet: Double = 0.06) async {
        let deadline = ProcessInfo.processInfo.systemUptime + max(0, seconds)
        while !Task.isCancelled {
            let now = ProcessInfo.processInfo.systemUptime
            let remaining = deadline - now
            if remaining <= 0 { return }
            if let lastChange, now - lastChange >= quiet { return }
            let delay = lastChange.map { max(0, quiet - (now - $0)) } ?? remaining
            await wait(upTo: min(remaining, delay))
        }
    }

    private func resume() {
        timer?.cancel()
        timer = nil
        debounce?.cancel()
        debounce = nil
        let waiting = waiter
        waiter = nil
        waiting?.resume()
    }

    func stop() {
        if let observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        }
        observer = nil
        resume()
    }
}

private func axChangeCallback(_ observer: AXObserver, _ element: AXUIElement, _ notification: CFString, _ refcon: UnsafeMutableRawPointer?) {
    guard let refcon else { return }
    let events = Unmanaged<AXChangeEvents>.fromOpaque(refcon).takeUnretainedValue()
    MainActor.assumeIsolated { events.fire(element, notification as String) }
}
