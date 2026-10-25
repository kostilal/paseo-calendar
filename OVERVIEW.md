Calendar puts the calendar accounts set up on this Mac on one board inside Paseo: Exchange or Outlook, Google, iCloud and other CalDAV accounts. The board shows today, a fortnight agenda and a month grid. Overlapping meetings are marked. The same meeting reached through two accounts is shown once, while a meeting entered twice in one account stays two meetings and is marked as an overlap. A composer pill names the next meeting once it is within the lead time you choose, and Join opens the meeting's Meet, Teams or Zoom link, found in its location or notes (the Description field), on the Mac.

It reads the macOS calendar store through EventKit, using a small helper app it builds on first start. There is no Google or other sign-in. The helper is compiled from Swift source shipped with the plugin, with `swiftc` from the Xcode Command Line Tools. The plugin downloads nothing itself: if the tools are missing, macOS offers Apple's installer, and nothing is built until you accept. The helper lives at `~/.jobby-jobs/CalendarHelper.app`. It is rebuilt when an update changes its source or its Info.plist, or when the built copy is missing, and macOS then asks for calendar access again.

Setup:

- Run Paseo's daemon on a Mac, with Paseo 0.8.0 or later.
- Add your accounts in System Settings → Internet Accounts, with Calendars turned on.
- The first time, macOS asks whether "JobbyJobs Calendar Helper" may have full access to your calendars. Allow it then, or later under System Settings → Privacy & Security → Calendars.
- In the plugin's settings, choose the accounts and calendars to show. A row whose account macOS re-added offers a one-tap re-link.
- The phone shows the same board through Paseo's own connection while the Mac is awake.

What it reads and where it goes:

- It reads titles, times, attendees, locations and notes from the calendars you chose. A meeting's card shows them, and the location and notes are searched for a call link.
- Events are shown in the Paseo apps connected to your daemon and kept in the daemon's memory. Each read passes through a temporary file in your user's temp folder that is deleted at once (one left by a daemon stopped mid-read is removed at the next start). `~/.jobby-jobs/calendar.json` (mode 0600) keeps your choices and what names them: each account's name, kind and mailbox address, its calendars and which are shown, when it was last read and its last error, and the pill's lead time and the view the board opens on. It holds no events, passwords or tokens.
- The plugin contacts no calendar service itself: macOS syncs your accounts.
- The composer pill is only a button: nothing from your calendar is added to what you send an agent.
- You can create one-off events, and edit and delete the one-off meetings you organise in the next two weeks (title, time, notes), and macOS uploads the change to the account. A new event invites nobody.
- With God Mode installed, ChatGPT can read your schedule (titles, times and calendar names, plus call links when asked, never notes or guests), list your accounts and calendars with their addresses, and add one event after you confirm. That data goes to OpenAI through God Mode.
- The access dialog's "Nothing is sent anywhere" describes the helper itself.

Limits:

- macOS only.
- No answering invitations, and no guests, invitations or video links on the events it writes.
- Repeating meetings are not edited or deleted, and all-day events are not edited.
- Edit and Delete are offered only from today to 14 days ahead; other meetings are changed in Calendar.
- Some of your own Google (CalDAV) meetings lack Edit and Delete, because macOS does not mark you as their organiser.
- It cannot tell that macOS stopped syncing an account, for example when Internet Accounts needs a new password. The "Updated" time is when the plugin last read macOS's copy. Set Calendar → Settings → Accounts → Refresh Calendars to Push or a short interval.
- The pill is seen only while Paseo is open.
