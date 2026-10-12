import Foundation

/// Who answers when skfiy needs the user's approval: uploading a file to a website, bringing an app
/// forward (run_in_front), using what the user copied, brief keyboard focus for a background app.
///
/// SKFIY_APPROVE=all grants all of these without asking. hand_over still waits for the user: it hands
/// them a step only they can do (signing in, a code), not a permission.
public enum ApprovalMode: Equatable, Sendable {
    case ask
    case all

    public init(_ value: String?) {
        self = value == "all" ? .all : .ask
    }

    public static var current: ApprovalMode { ApprovalMode(ProcessInfo.processInfo.environment["SKFIY_APPROVE"]) }
}
