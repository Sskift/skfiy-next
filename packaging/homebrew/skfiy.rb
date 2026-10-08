# Template for a Homebrew tap (not published). To use it: create a tap repo
# (e.g. Sskift/homebrew-skfiy), copy this file to Formula/skfiy.rb, set url and
# sha256 for the release tag, and add a license line once the repo has one.
# Builds from source, so it needs Xcode or the Command Line Tools (Swift 6).
# A cask is not suitable: casks are quarantined and the binary is ad-hoc signed.
class Skfiy < Formula
  desc "macOS computer use for Claude Code and other MCP clients, in the background"
  homepage "https://github.com/Sskift/skfiy-next"
  url "https://github.com/Sskift/skfiy-next/archive/refs/tags/v0.6.0.tar.gz"
  sha256 "REPLACE_WITH_THE_TARBALL_SHA256"

  depends_on xcode: ["16.0", :build]
  depends_on macos: :sonoma

  def install
    system "swift", "build", "--disable-sandbox", "-c", "release", "--product", "skfiy"
    bin.install ".build/release/skfiy"
  end

  def caveats
    <<~EOS
      Finish the setup (browser extension files and bridge, Claude Code registration,
      permission check); run it again after `brew upgrade`:
        #{opt_bin}/skfiy setup
      Registrations use #{opt_bin}/skfiy, which stays valid across upgrades.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/skfiy --version")
  end
end
