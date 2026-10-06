/**
 * Visitor identity (contracts v1.3, CR-WEB-01): the lead is UE's login. Guests are the page's `guest-<deviceId>` and UE's
 * "guest_tester" (nobody logged in: MaxiClientCommands::GetUserName / SaveSystemWidget::GetActiveUserName).
 * Guests keep a per-instance session, never become a lead, and named sessions are never merged into them.
 */
export function isGuest(username: string | undefined | null): boolean {
  const u = String(username ?? '').trim();
  return !u || /^guest[-_]/i.test(u) || u.toLowerCase() === 'guest_tester';
}
