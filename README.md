# Calendar

A [Paseo](https://paseo.sh) plugin that puts the calendar accounts set up on a Mac on one board,
names the next meeting in a composer pill shortly before it starts, and joins its call in one
tap. It reads everything through macOS (EventKit), so there is nothing to sign in to.

## What it does

- **One board for every account.** Exchange or Outlook, Google, iCloud and other CalDAV
  accounts that macOS already syncs, side by side. The board opens on today; a list of the
  fortnight ahead and a month grid are one chip away. A meeting already behind you is faded,
  so the first row at full strength is the next one.
- **Overlaps are marked.** Two meetings that overlap are drawn as one block bordered in red,
  in the list and in a single day alike.
- **Copies are recognised.** The same meeting reached through two accounts (same title, start
  and end) is shown once, from the account listed first in Settings, and never overlaps
  itself. Its card names every calendar it was found in, each with its account. Two meetings
  with one title and time in a single account are two meetings, not copies: they stay two rows
  and are marked as an overlap. A meeting Outlook marked cancelled ("Canceled: …") is left off
  the board.
- **A card per meeting.** Who is coming and, for anyone outside your own domains, which
  company (free mail such as gmail.com names no company); the calendar and account it came
  from; how long an overlap runs and with which meeting; the location and notes (the
  Description field); and Join when a call link was found.
- **A composer pill.** It names the next meeting once it is within the lead time you choose,
  then deepens and pulses faster at ten minutes, five and one. Pressing it opens the meeting.
- **Join.** The location, then the notes, are searched for a Google Meet, Microsoft Teams or
  Zoom link. The daemon opens it on the Mac; a Teams link opens in the Teams app when it is
  installed.
- **Create** one-off events, and **edit and delete** the one-off meetings you organise, through
  EventKit.
- **ChatGPT through God Mode** can read the schedule and, after you confirm, add one event.

The interface is in English, Russian or Ukrainian, following Paseo's language setting.

## Requirements

- **macOS**, on the machine that runs Paseo's daemon. Calendars are read through EventKit,
  which exists only there.
- **Paseo 0.8.0 or later.** `paseo-plugin.json` declares `"requirements": { "paseo": ">=0.8.0" }`
  and `server/manifest.test.ts` pins it. The floor was measured, not guessed: the whole tree,
  tests included, typechecks with 0 errors against each minor release of `@getpaseo/plugin`
  from 0.8.0 to 0.13.0, and 0.8.0 is also the oldest daemon that reads `requirements` at all.
  Current Paseo apps check the floor themselves before they load a plugin's client code, but
  apps older than the release that added that check do not. So the client takes no API added
  after 0.8 (for example `Icon`, `Modal` and `TextInput` from `/client/ui`, which exist only
  from 0.13) and keeps to `/client/react-native`, and the 0.8.0 typecheck is the measure: such
  an app would otherwise fail at run time, not at install.
- **The Xcode Command Line Tools**, for `swiftc`: `xcode-select --install`. Nothing else here
  needs them.
- **Your accounts in System Settings → Internet Accounts**, with Calendars turned on.

## Install

First turn on **Enable plugins** under Paseo's Settings → Plugins: with it off, an installed
plugin does not load at all.

The simplest way in is the same screen: under Settings → Plugins → Plugin source, enter
`git:kostilal/paseo-calendar`.

From a terminal instead: the `paseo` CLI ships inside the app at
`/Applications/Paseo.app/Contents/Resources/bin/paseo` and is not on `PATH` by default. Call it
by that full path:

```sh
/Applications/Paseo.app/Contents/Resources/bin/paseo plugin add git:kostilal/paseo-calendar
```

or link it once into a folder on your `PATH`. `~/.local/bin` is a common choice, but it may not
exist and macOS does not put it on `PATH` by itself:

```sh
mkdir -p ~/.local/bin
ln -s "/Applications/Paseo.app/Contents/Resources/bin/paseo" ~/.local/bin/paseo
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # then open a new terminal
paseo plugin add git:kostilal/paseo-calendar
```

Later, `paseo plugin update calendar` fetches a new version. There is no build step: Paseo
compiles the TypeScript, and the plugin has no runtime dependencies.

Then open **Calendar** in the sidebar, or press ⌘K and type "calendar" to reach its settings.
`paseo plugin ls` shows whether the plugin is running and, if it failed to load, why.
`paseo plugin logs calendar` is the server side's output only: the board runs in the app, so a
mistake there shows on screen and not in that log.

## The macOS access prompt

The first time the plugin needs your calendars, macOS asks whether **"JobbyJobs Calendar
Helper"** may have full access to them. The dialog says "JobbyJobs shows your day by reading the
calendars already set up on this Mac. Nothing is sent anywhere." That sentence is about the
helper: it reads and writes the Mac's calendar store and opens no connection of its own. macOS
syncs what it writes to the account, and where the plugin's answers to ChatGPT go is under
[Asking ChatGPT](#asking-chatgpt-god-mode).

The prompt appears on the Mac that runs the daemon, so access is granted there, not from a
phone. Settings reads the permission state without asking, tells "never asked" apart from
"refused", and offers **Allow calendar access** again. You can change your answer under System
Settings → Privacy & Security → Calendars.

The helper is a small app the plugin compiles on first start, from the Swift source it ships, to
`~/.jobby-jobs/CalendarHelper.app`. It is signed ad hoc, and macOS ties the grant to the exact
build. The helper is rebuilt when a plugin update changes its source or its Info.plist, or when
the built copy is missing, and macOS then asks again; an update that leaves the helper alone
keeps the grant. The helper's name and folder are historical (the plugin started in a project
called JobbyJobs) and stay as they are for the same reason: changing them would ask everybody
again.

## Choosing accounts and calendars

Settings opens from the gear in the board's header, or from the Command Center item "Calendar:
accounts".

- **Found on this Mac** lists the calendar accounts macOS syncs that the board does not read
  yet. **Add** reads one and shows all its calendars; switch off the ones you do not want.
  Nothing is added on its own, because choosing is the point: without it the board would take
  every calendar on the Mac, birthdays included.
- **One row per account.** A row is named by its mailbox address once the plugin has seen it
  among the account's attendees, else by the account's name in macOS. Under it are the kind
  (Exchange, Google, iCloud, …) and "Calendars: N of M". Open the row to show or hide each
  calendar; a switch takes effect at once. **Disconnect** asks first, and the account stays on
  the Mac, ready to add again.
- **Re-link.** macOS sometimes re-adds an account under a new identity, and the row loses its
  meetings. When exactly one account on the Mac has the same kind, name and calendar names, the
  row offers "Use the … account found on this Mac". Accepting keeps the row and carries over
  which calendars are shown. It never happens without the tap.
- **Not on this Mac since …** is a row whose account is gone with nothing to re-link to. It
  stays greyed with its choices, in case the account comes back.

## The board, the pill and Join

- **Open on** chooses the view the board starts on: List (the fortnight), Day or Month. Day is
  the default. Switching view on the board lasts for that visit.
- **Show the pill** chooses how early the pill appears: always, or 60, 30, 15 or 10 minutes
  before a meeting. 30 is the default. A meeting already under way always shows.
- The pill is a button in each chat's composer. It is seen only while Paseo is open, and it
  adds nothing from your calendar to what you send an agent.
- Join appears only when a Meet, Teams or Zoom link was found; any other link in the notes is
  left alone. It opens on the Mac, also when tapped on the phone.

## Creating and changing events

The **+** on the board creates a one-off event: title, start, duration and notes, in a calendar
that accepts new events (subscribed and birthday calendars do not). A review step shows what
will be written before anything is. EventKit writes the event to the calendar on the Mac, and
the account's own sync uploads it. It invites nobody and creates no meeting link: it blocks your
own time.

**Edit** (title, time, notes) and **Delete** appear on the meetings you organise from today to
14 days ahead, the fortnight the daemon keeps; a meeting outside it says to change it in
Calendar. A repeating meeting is neither edited nor deleted here, because only the whole series
could be changed. An all-day event can be deleted but not edited. Deleting cannot be undone.
Answering invitations, guests and video links are not available through EventKit; use Calendar
or the invitation email.

## Asking ChatGPT (God Mode)

With [God Mode](https://github.com/devXpro/paseo-god-mode-plugin) installed, ChatGPT can use this
plugin. It describes itself through `meta.describe` (`paseo.capabilities/1`), and God Mode finds
it by its id `calendar`, its title, or an alias such as "schedule", "agenda", "meetings" or
"apple calendar".

| Operation | Kind | Arguments | What it does |
| --- | --- | --- | --- |
| `day` | read, the default | `date`, `time_zone`, `with_links`, `include_declined` | The schedule for one day. |
| `period` | read | `from`, `to`, `time_zone`, `with_links`, `include_declined` | The schedule from `from` to `to`, both included, at most 31 days. |
| `calendars` | read | none | The accounts with their addresses, their calendars, which ones accept new events and which are hidden, and accounts missing from the Mac. |
| `event_preview` | read | `title`, `date`, `start_time`, `duration_minutes`, `calendar` | Finds the exact calendar, says whether the same event already exists, and lists overlaps. Creates nothing. |
| `add_event` | action | the same as `event_preview` | Adds one timed event to that calendar. Asking again for the same event returns the one already there. |

- `date`, `from` and `to` take `YYYY-MM-DD`, `today`, `tomorrow`, `yesterday` or an English
  weekday name (the next one, today included); an empty `date` is today. `time_zone` is an IANA
  zone and defaults to the Mac's own. `with_links` adds each meeting's call link.
  `include_declined` lists meetings you declined, which are otherwise left out and counted in
  `hidden`.
- `start_time` is `HH:MM`, 24-hour, in the Mac's zone; `duration_minutes` is 5 to 720.
  `calendar` is an owner address, `Account/Calendar` or an exact calendar name; `calendars`
  lists them.
- **`add_event` always asks first.** Its risk is `outward`, and God Mode asks you before any
  action that is not `low`. It never edits, moves, answers or deletes a meeting.
- **`event_preview` and `add_event` answer within 25 seconds**, before Paseo's 30-second
  cut-off, even when an account on this Mac is slow to read. If the day could not be read by
  then, the answer says nothing was added. If the save had already started, it says the save is
  not confirmed and asks you to check that calendar before adding the event again.
- **What leaves the Mac.** God Mode passes these answers to ChatGPT, so they go to OpenAI:
  meeting titles, times, calendar names, the accounts' addresses (calendar names carry them),
  overlaps, and call links when asked. Notes, locations and guests are never in an answer.
- A day or period inside the fortnight the daemon keeps in memory, from local midnight, is
  answered from it while that copy is fresh (read in the last eleven minutes); anything else,
  or anything asked while the copy is older, is read from EventKit (a copy at most a minute
  old, since the same range asked again within a minute is answered from the first read).
  `stale` says the data is more than eleven minutes old, and `sources` names any account that
  could not be read.
- **God Mode versions.** Reads and `add_event` need God Mode 0.8 or later (`plugin_read`,
  `plugin_action`). From 0.10, God Mode also understands the refusal signals (`outcome`) and
  that titles written by other people are untrusted text (`untrusted`); older versions ignore
  both. Use 0.10 or later with `add_event`: an older God Mode announces a refused add as done,
  and only the answer's summary, which then starts with "Not added:", says otherwise.

## Where its state lives

Everything is under `~/.jobby-jobs/`:

- **`calendar.json`**, mode `0600`, written atomically (a temp file, then a rename) and only when
  its content changed. It is format version 2: the accounts (which macOS account each row reads,
  its name, kind and mailbox address, its calendars and which are shown, when it was last read,
  its last error and since when it has been missing) and two preferences, the view the board
  opens on and the pill's lead time. There are no passwords or tokens in it, because macOS holds
  the accounts' credentials, and no events: they live in the daemon's memory and are read again
  every five minutes, and when the board comes back into focus more than two minutes after the
  last read. Each read passes through a temporary file in your user's temp folder
  (`calendar-helper.*`), deleted as soon as it is read; one left behind by a daemon that was
  stopped mid-read is removed the next time the plugin starts.
- **`calendar.json.v1.bak`** appears only if you used a build older than 0.1.0. Its format 1 file
  is copied here once, mode `0600`, before the first version 2 write, and never touched again.
  That old format could hold Google sign-in tokens, so delete the copy once your accounts came
  through.
- **`calendar.json.broken-<timestamp>`** (UTC, `YYYYMMDDTHHMMSS`). A file that does not read
  cleanly is never treated as a first run. Whatever did validate is shown, the file is copied
  aside once, mode `0600`, and sync goes read-only with the code `store_broken`: nothing is
  written until the file reads valid again, and the board and Settings say so. If no copy could
  be made, they say that instead, because the original is then the only copy and must be fixed
  where it is.
- **`CalendarHelper.app`** and **`calendar-eventkit.swift`**: the helper and the source it was
  built from, which the plugin compares with the source it ships to decide whether a rebuild is
  due.

The folder is still `~/.jobby-jobs` rather than a name of this plugin's own because the helper
lives there, and moving the helper would mean a new access prompt.

## Known limits

- macOS only.
- No answering invitations, and no guests, invitations or video links on the events it writes.
- Repeating meetings are not edited or deleted, and all-day events are not edited.
- Edit and Delete are offered only from today to 14 days ahead. A past meeting, or one further
  out (in the Month view, say), is changed in Calendar.
- Some of your own Google (CalDAV) meetings lack Edit and Delete: macOS does not mark you as
  their organiser and gives no organiser address, and guessing would put Delete on somebody
  else's meeting.
- It cannot tell that macOS stopped syncing an account, for example when Internet Accounts
  needs a new password. The "Updated" time is when the plugin last read macOS's copy, not when
  macOS last synced it. In Calendar → Settings → Accounts, set Refresh Calendars to Push or a
  short interval.
- The pill is seen only while Paseo is open.
- The phone needs the Mac awake: it reaches the board through Paseo's connection to the daemon.
- The Day view does not show an overlap whose other meeting falls on the day before or after
  (one that crosses midnight). The List view, which covers the whole fortnight, does.

## Development

```sh
npm install
npm test
npm run typecheck
```

To run a working copy, register its directory instead of a git install, from inside the
checkout:

```sh
paseo plugin add .
paseo plugin reload calendar      # after every change
```

A directory install runs the working tree, so `reload` is all a change needs.

- **Tests are offline.** No network, no real account, and the helper is never launched: the
  sync tests replace it through the seams in `createSync`, and the guarantees that live in the
  Swift (no fallback to a default calendar, an occurrence date in a repeating event's id, a
  completion marker on both exits) are asserted against the source as text. Store tests use
  temporary directories, never `~/.jobby-jobs`. Three tests guard a release:
  `server/manifest.test.ts` (the manifest and its Paseo floor), `server/imports.test.ts` (every
  import is a module Paseo provides) and `server/listing.test.ts` (`OVERVIEW.md` follows the
  registry's listing rules, and no file carries a real address; tests use `example.com` names).
- **Relative imports keep their `.ts` or `.tsx` extension**, against Paseo's own scaffold,
  because `node --test` runs these files directly and Node, unlike a bundler, does not resolve
  an import without one.
- **Client logic lives in plain `.ts` modules.** `node --test` rejects `.tsx`, and cannot import
  `react-native` at all (it is written in Flow, which Node's type stripping does not handle). So
  any client logic that needs a test is pulled out first: `client/pill-registry.ts`,
  `client/pill-state.ts`, `client/create-input.ts`, `client/submit-latch.ts`, `client/issues.ts`,
  `client/focus.ts`, `client/settings-model.ts` and the rest exist as separate files for that
  reason, not for tidiness.
- `client/`, `server/` and `shared/` are compiler boundaries in Paseo 0.8 and later: a code module
  left at the plugin root is a build error. `index.client.tsx` and `index.server.ts` each
  export their own entry.

## Things that are the way they are for a reason

**`server/eventkit.swift.ts` and the helper's bundle id do not change casually.** The helper is
rebuilt whenever its Swift source or its Info.plist changes, and a new build has a new code hash,
so macOS asks every user for calendar access again. The bundle id
`pro.evodev.jobby.calendar-eventkit` is historical for the same reason: it is what existing
grants are keyed to. Improvements go through the helper's existing subcommands (`status`,
`access`, `sources`, `calendars`, `events`, `create`, `update`, `delete`).

**The helper is an app bundle, started through LaunchServices, and that is the whole of why
macOS will grant it anything.** TCC does not ask the process that calls
`requestFullAccessToEvents`; it asks the process it holds responsible, which is the root of the
launch chain. For anything this plugin spawns directly that is `Paseo.app`, whose Info.plist
declares no calendar use, so every request was refused before a dialog could appear. A bundle
started by LaunchServices is its own responsible process, so its own Info.plist governs. Two
smaller defects sat underneath and are fixed alongside: a command-line binary has no Info.plist
at all (and macOS 14 refuses silently without `NSCalendarsFullAccessUsageDescription`), and an
ad hoc linker signature takes its identifier from the output file name, which was a temp path
carrying the pid.

**Nothing waits on `open -W`.** It blocks by watching the launched process with kevent, and the
helper exits in milliseconds, so kevent regularly finds no such process and `open` fails while
the output file it redirected sits there, complete and correct. It is a race, so it also passes
sometimes. The helper prints a marker when it is done, and the Node side waits for that.

**A repeating occurrence carries its own date in its id.** `EKEvent.eventIdentifier` is the same
string for every occurrence of a series. That is correct for EventKit and wrong for a board that
keys an event by account and id: a daily standup over a fortnight arrived as ten rows sharing
one key, the overlap grouping merged them, and all ten drew on the earliest one's day.

**Connecting is not the RPC's return value.** Paseo's plugin host gives a handler thirty seconds,
and both a connect and the permission request can take longer: a connect waits its turn behind a
sync, and a permission dialog waits for somebody to find it behind their windows. A blocking
handler reported "Plugin RPC timed out" while the work carried on and often finished, so the
account appeared only after a reload, and the screen had already said it failed.
`calendar.connect` and `calendar.access` start the work and return at once; `calendar.settings`
reports how it ends.

## License

MIT, see [LICENSE](LICENSE).
