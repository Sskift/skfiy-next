import Foundation

/// The approval policy for one skfiy session. In all mode tool actions are
/// preapproved and a manual handoff returns the outstanding step immediately.
public enum ApprovalMode: Equatable, Sendable {
    case ask
    case all

    public init(_ value: String?) {
        self = value == "all" || value == "bypass" ? .all : .ask
    }

    public static var current: ApprovalMode { ApprovalMode(ProcessInfo.processInfo.environment["SKFIY_APPROVE"]) }
}
