import XCTest
@testable import open_dot_notch

final class GrantTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 10_000)

  private func grant(expiresAt: Double) -> Grant {
    Grant(id: 1, operation: "merge", summary: "merge into feat/foo in acme/app", expiresAt: expiresAt, createdAt: 0)
  }

  func testTheRowSaysHowLongTheGrantHasLeft() {
    XCTAssertEqual(grantRemaining(grant(expiresAt: 10_000_000), now: now), "Ends now")
    XCTAssertEqual(grantRemaining(grant(expiresAt: 12_700_000), now: now), "Ends in 45m")
    XCTAssertEqual(grantRemaining(grant(expiresAt: 10_000_000 + 3 * 3_600_000), now: now), "Ends in 3h")
    XCTAssertEqual(grantRemaining(grant(expiresAt: 10_000_000 + 3 * 86_400_000), now: now), "Ends in 3d")
  }

  func testMemoryFromADaemonWithGrantsDecodesThem() throws {
    let json = #"{"notes":[],"responsibilities":[],"reminders":[],"grants":[{"id":4,"operation":"deploy","repo":null,"branch":null,"pr":null,"target":"preview","summary":"deploy to a target matching \"preview\" in any repository","expiresAt":2,"createdBy":"owner (CLI)","createdAt":1}]}"#
    let memory = try JSONDecoder().decode(Memory.self, from: Data(json.utf8))
    XCTAssertEqual(memory.grants?.first?.id, 4)
    let older = try JSONDecoder().decode(Memory.self, from: Data(#"{"notes":[],"responsibilities":[],"reminders":[]}"#.utf8))
    XCTAssertNil(older.grants)
  }
}
