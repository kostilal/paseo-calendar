export type Locale = "en" | "ru" | "uk";

export interface Strings {
  sidebarTitle: string;
  settingsTitle: string;
  noAccounts: string;
  /** Shown instead of noAccounts while the first getSettings call is still in flight. */
  loadingSettings: string;
  /** Shown instead of noAccounts when getSettings itself rejected. */
  settingsLoadError: string;
  disconnect: string;
  calendarsLabel: string;
  lastSync(when: string): string;
  /** A generic "still working" label for actions with no progress text of their own (a
   *  disconnect, a relink pressed on the board), which can queue behind a connect reading an account. */
  working: string;
  commandCenterSettings: string;

  // --- The accounts screen, redrawn ---

  /** The sentence under the screen title, saying what connecting an account buys. */
  settingsSubtitle: string;
  /** Heading over the list of already-connected accounts. */
  accountsSection: string;
  /** The explicit permission step, which exists because asking can no longer be a side
   *  effect of listing — and because an ad-hoc signed helper loses its grant on every
   *  rebuild, so this button has to be reachable again afterwards. */
  grantAccess: string;
  grantAccessWhy: string;
  /** The system dialog is open and nobody has answered it. */
  accessAsking: string;
  /** A connect is in flight: the daemon is reading the chosen account through macOS. */
  connectRunningSystem: string;
  /** What connecting reads, said over the permission step. */
  systemBlurb: string;
  /** The composer pill's lead time: how early it appears before a meeting. */
  pillLeadLabel: string;
  pillLeadHint: string;
  /** The choice that keeps the pill on screen all the time, as it used to be. */
  pillLeadAlways: string;
  pillLeadMinutes(minutes: number): string;
  /** Which of the board's views it opens on. The chips reuse periodAgenda/Day/Month. */
  defaultViewLabel: string;
  defaultViewHint: string;
  /** Written "Calendars: 3" rather than declined, the same dodge overlapWarning uses. */
  calendarCount(count: number): string;
  /** Opens System Settings at the calendar privacy pane, from the refusal banner. */
  openPrivacy: string;
  /** Said instead of openPrivacy's button where it cannot open: on a phone, the setting is on the Mac. */
  onTheMac: string;
  /** The macOS permission refusal, in our words rather than the helper's. */
  calendarAccessRefused: string;
  /** A row's second line: how many of its calendars are shown, out of how many it has. */
  calendarsShown(shown: number, total: number): string;
  /** A row whose macOS source is gone, with the day it was first missed. */
  notOnMacSince(date: string): string;
  /** The relink banner's button, naming the source the row would move onto. */
  relinkOffer(title: string): string;
  relinkHint: string;
  relinkFailed(message: string): string;
  /** The list under the rows: sources macOS has that no row reads. */
  foundSection: string;
  foundHint: string;
  foundNone: string;
  /** Listing this Mac's accounts failed, so "every account is already here" would be a guess. */
  foundFailed: string;
  /** A change refused because the store reads as broken; the banner above says why. */
  notSaved: string;
  addSource: string;
  /** Asked inside the row before a disconnect, naming the account. */
  disconnectConfirm(label: string): string;
  /** Kinds in words; Exchange, iCloud, Google and CalDAV are product names and are not here. */
  kindLocal: string;
  kindSubscribed: string;
  kindBirthdays: string;
  kindOther: string;
  /** Under noAccounts: accounts are added from the Found list below the rows. */
  noAccountsHint: string;
  accountRowA11y(label: string): string;
  /** For a row with no stored calendars, which is never read until they are read again. */
  rereadCalendars: string;

  // --- Agenda board ---
  /** The three ways of looking at the same events. */
  periodAgenda: string;
  periodDay: string;
  periodMonth: string;
  /** Jumps the cursor back to now, from wherever paging has wandered to. */
  jumpToday: string;
  /** The period arrows, said in words: a screen reader names an icon-only button by its label. */
  earlier: string;
  later: string;
  /** The date picker's month arrows, for the same reason. */
  previousMonth: string;
  nextMonth: string;
  /** Closes the date picker, keeping what was chosen. */
  done: string;
  /** Headings inside the picker, over the calendar and over the hour and minute rows. */
  pickDate: string;
  pickTime: string;
  /** A day cell's count in the month grid, kept short enough for a 40px cell. */
  eventCount(count: number): string;
  /** The same count, for a screen reader, written "Events: 3" rather than declined. */
  eventsA11y(count: number): string;
  /** Read out after a row's time, title and calendar when it is part of an overlap. */
  overlapsA11y: string;
  /** Shown in a day or month view that resolved with nothing in it. */
  nothingInPeriod: string;
  today: string;
  tomorrow: string;
  /** Named on the event card, where it can say which meeting is in the way. The agenda's
   *  collision block says it in red instead: a duration nobody asked for, on a row already
   *  drawn as a collision, was noise over the two titles that actually answer the question. */
  overlapWarning(minutes: number): string;
  /** Shown when getEvents resolved but there is nothing to list, on any day. */
  nothingToday: string;
  /** Accessible label for the board's gear button; commandCenterSettings is the palette entry. */
  settings: string;
  refresh: string;
  /** Shown instead of the agenda when getEvents itself rejected (not a per-account error). */
  eventsLoadError: string;
  /** A failure quoted as it came, when no code explains it and no row is there to name: a
   *  refresh that failed outright, a connect that failed, or an account's error after its row
   *  has gone. */
  syncIssue(message: string): string;

  // --- A problem, by its code (client/issues.ts picks one) ---
  /** A row whose macOS source is gone; `label` is "" when no row is known. */
  issueGone(label: string): string;
  /** The board's banner for a gone row that has somewhere to move to; relinkOffer is its button. */
  issueMoved(label: string): string;
  issueMacos: string;
  /** The Swift helper would not build, run or answer; the message says which. */
  issueHelper(message: string): string;
  /**
   * The store read as broken. `aside` names the copy set aside, and only then is a copy claimed:
   * with "" none could be made, and the file as found is the only one, so it is to be fixed
   * where it is rather than replaced.
   */
  issueStoreBroken(aside: string): string;
  /** A failure no code explains, quoted, naming the account it happened to. */
  issueAccount(label: string, message: string): string;

  // --- Event card ---
  back: string;
  allDay: string;
  whoLabel: string;
  /** The viewer's own row in the attendee list, in place of their name. */
  you: string;
  /** Tag next to an attendee whose company differs from the viewer's own. */
  external: string;
  calendarLabel: string;
  /** The card's label when copies from several calendars were merged into one row. */
  calendarsFoundLabel: string;
  /** Where the meeting is, when the invitation says so. */
  whereLabel: string;
  descriptionLabel: string;
  joinMeet: string;
  joinTeams: string;
  joinZoom: string;
  joinGeneric: string;
  edit: string;
  /** The edit screen's own heading and its save control. */
  editTitle: string;
  save: string;
  saving: string;
  /** A series is not edited here; the button says why rather than being greyed in silence. */
  seriesNotEditable: string;
  /** An all-day event is not edited here; Delete still is offered. */
  allDayNotEditable: string;
  /** Your own meeting outside the fortnight the server edits and deletes in. */
  changeInCalendar: string;
  editFailed(message: string): string;
  /** Deleting: the control, the confirmation's own title, and what it warns about. */
  deleteLabel: string;
  deleteConfirmTitle: string;
  /** Names the meeting being removed, because "are you sure" names nothing. */
  deleteConfirm(title: string): string;
  deleting: string;
  seriesNotDeletable: string;
  deleteFailed(message: string): string;
  /** EventKit reports a participant's status and cannot change it. */
  rsvpUnavailable: string;

  // --- Creating an event ---
  createTitle: string;
  createNeedsAccount: string;
  /** Accounts exist but none can take a new event: subscribed and birthday sources are read-only,
   *  and an account the Mac no longer lists cannot be written to. */
  createNoWritable: string;
  titleLabel: string;
  startLabel: string;
  /** Names the zone the picked wall clock will be read in: the one thing that turns a 15:00
   *  that lands at 12:00 from a silent mistake into something visible before the write. */
  startHint(zone: string): string;
  durationLabel: string;
  /** Opens the confirmation. Nothing on the form itself calls the RPC. */
  review: string;
  cancel: string;
  create: string;
  creating: string;
  /** create() shares sync.ts's single queue with the tick and with connect(), so it can sit
   *  behind a connect still reading an account, or a slow tick. This says the wait is a queue. */
  createQueuedNote: string;
  confirmTitle: string;
  whenLabel: string;
  /** The summary's one line on what a create does: EventKit writes to this Mac's calendar and sends nothing. */
  confirmLocalOnly: string;
  /** The summary's extra line when the chosen calendar is switched off in Settings. */
  confirmHiddenCalendar: string;
  /** EventKit refused the save because the calendar inside a writable account is read-only. */
  createReadOnly: string;
  /** The helper no longer finds the chosen calendar in its account. */
  createCalendarMissing: string;
  createFailed(message: string): string;
  /** Create's answer was lost on the way: the event may well exist, so no plain retry is offered. */
  createMaybeSaved(message: string): string;
  problemCalendar: string;
  problemTitle: string;
  problemStart: string;
  problemDuration: string;

  // --- Composer pill ---
  /** The pill's label once its next meeting has started. Ladder colour lives in the icon
   *  next to this text, not in the string itself. */
  pillNow(title: string): string;
  /** The pill's label counting down to a meeting that has not started yet. */
  pillIn(title: string, minutes: number): string;
}

const en: Strings = {
  sidebarTitle: "Calendar",
  settingsTitle: "Calendar accounts",
  noAccounts: "No accounts yet. Connect one to see your day here.",
  loadingSettings: "Loading your accounts…",
  settingsLoadError: "Could not load your accounts. Retrying…",
  disconnect: "Disconnect",
  calendarsLabel: "Calendars shown",
  lastSync: (when: string) => `Updated ${when}`,
  working: "Working…",
  commandCenterSettings: "Calendar: accounts",

  settingsSubtitle: "Connect an account to see your day, and what collides with what.",
  accountsSection: "Accounts",
  grantAccess: "Allow calendar access",
  grantAccessWhy:
    "macOS asks once, for this helper. It asks again only if an update rebuilds the helper (a change to its source) or the helper is missing.",
  accessAsking: "Waiting for your answer in the macOS dialog…",
  connectRunningSystem: "Reading that account…",
  systemBlurb: "One account macOS already syncs — Exchange, Google or iCloud. No password, no admin rights.",
  pillLeadLabel: "Show the pill",
  pillLeadHint:
    "How long before a meeting the composer pill appears. A meeting already under way always shows, whatever this says.",
  pillLeadAlways: "Always",
  pillLeadMinutes: (minutes: number) => `${minutes} min`,
  defaultViewLabel: "Open on",
  defaultViewHint:
    "Which view the board starts on. Switching view on the board itself lasts for that visit; this is what it comes back to.",
  calendarCount: (count: number) => `Calendars: ${count}`,
  openPrivacy: "Open Privacy settings",
  onTheMac: "Do this on the Mac that runs Paseo.",
  calendarAccessRefused:
    "macOS refused calendar access. Allow the JobbyJobs calendar helper under Privacy & Security → Calendars, then connect again.",
  calendarsShown: (shown: number, total: number) => `Calendars: ${shown} of ${total}`,
  notOnMacSince: (date: string) => `Not on this Mac since ${date}`,
  relinkOffer: (title: string) => `Use the ${title} account found on this Mac`,
  relinkHint:
    "macOS re-added this account under a new identity. Re-linking keeps this row and which of its calendars are shown.",
  relinkFailed: (message: string) => `Could not re-link: ${message}`,
  foundSection: "Found on this Mac",
  foundHint:
    "Calendar accounts macOS already syncs that are not read here yet. Adding one shows all its calendars; switch off the ones you do not want.",
  foundNone: "Every calendar account on this Mac is already here.",
  foundFailed: "Could not list this Mac's calendar accounts just now. Trying again…",
  notSaved: "Nothing was changed: the accounts file is not being saved (see above).",
  addSource: "Add",
  disconnectConfirm: (label: string) =>
    `Stop reading ${label}? It stays on this Mac, and you can add it again from “Found on this Mac”.`,
  kindLocal: "On this Mac",
  kindSubscribed: "Subscribed",
  kindBirthdays: "Birthdays",
  kindOther: "Calendar account",
  noAccountsHint: "Add one of the accounts found on this Mac below.",
  accountRowA11y: (label: string) => `${label}: calendars and settings`,
  rereadCalendars: "Read its calendars again",

  periodAgenda: "List",
  periodDay: "Day",
  periodMonth: "Month",
  jumpToday: "Today",
  earlier: "Earlier",
  later: "Later",
  previousMonth: "Previous month",
  nextMonth: "Next month",
  done: "Done",
  pickDate: "Date",
  pickTime: "Time",
  eventCount: (count: number) => `${count}`,
  nothingInPeriod: "Nothing here.",
  eventsA11y: (count: number) => `Events: ${count}`,
  overlapsA11y: "overlaps another meeting",
  today: "Today",
  tomorrow: "Tomorrow",
  overlapWarning: (minutes: number) => `Overlap: ${minutes} min`,
  nothingToday: "Nothing on the calendar.",
  settings: "Settings",
  refresh: "Refresh",
  eventsLoadError: "Could not load your calendar. Retrying…",
  syncIssue: (message: string) => `Sync issue: ${message}`,

  issueGone: (label: string) => (label ? `${label} is no longer on this Mac.` : "That calendar account is no longer on this Mac."),
  issueMoved: (label: string) =>
    `${label} moved: macOS re-added it as a new account, so its meetings are missing here until it is re-linked.`,
  issueMacos: "Reading calendars needs macOS, and this Paseo daemon is not running on a Mac.",
  issueHelper: (message: string) => `The calendar helper on this Mac did not answer: ${message}`,
  issueStoreBroken: (aside: string) =>
    `The accounts file could not be read in full, so nothing is being saved.${
      aside
        ? ` A copy was kept as ${aside}. Restore a good calendar.json to start saving again.`
        : " No copy of it could be made, so do not delete or replace calendar.json: it is the only one. Fix it where it is to start saving again."
    }`,
  issueAccount: (label: string, message: string) => `Could not read ${label}: ${message}`,

  back: "Back",
  allDay: "All day",
  whoLabel: "Who",
  you: "You",
  external: "External",
  calendarLabel: "Calendar",
  calendarsFoundLabel: "Calendars",
  whereLabel: "Where",
  descriptionLabel: "Description",
  joinMeet: "Join with Meet",
  joinTeams: "Join with Teams",
  joinZoom: "Join with Zoom",
  joinGeneric: "Join",
  edit: "Edit",
  editTitle: "Edit meeting",
  save: "Save",
  saving: "Saving…",
  seriesNotEditable:
    "This meeting repeats. Editing one occurrence and editing the series are different things, and only the series would be changed here — so neither is.",
  allDayNotEditable: "An all-day event is not edited here: change it in Calendar. Deleting it works.",
  changeInCalendar: "Change it in Calendar: only meetings from today to 14 days ahead are changed here.",
  editFailed: (message: string) => `Could not save: ${message}`,
  deleteLabel: "Delete",
  deleteConfirmTitle: "Delete this meeting?",
  deleteConfirm: (title: string) => `"${title}" will be removed. This cannot be undone.`,
  deleting: "Deleting…",
  seriesNotDeletable:
    "This meeting repeats. Deleting it here would remove every occurrence of the series, so it is not offered.",
  deleteFailed: (message: string) => `Could not delete: ${message}`,
  rsvpUnavailable:
    "macOS cannot answer invitations for this account: it reports who replied what and cannot change it. Answer in Calendar or in the invitation email.",

  createTitle: "New event",
  createNeedsAccount: "Connect a calendar account before creating an event.",
  createNoWritable:
    "None of these accounts accepts new events: subscribed and birthday calendars are read-only, and an account missing from this Mac cannot be written to.",
  titleLabel: "Title",
  startLabel: "Start",
  startHint: (zone: string) => `Read in your own time zone (${zone}).`,
  durationLabel: "Duration in minutes",
  review: "Review",
  cancel: "Cancel",
  create: "Create",
  creating: "Creating…",
  createQueuedNote:
    "Creating shares one queue with syncing and connecting, so it can wait behind something already running. It has not failed.",
  confirmTitle: "Check this before it is created",
  whenLabel: "When",
  confirmLocalOnly:
    "This is written to the calendar on this Mac. No invitation is sent and no meeting link is created; it blocks your own time.",
  confirmHiddenCalendar:
    "This calendar is switched off in Calendar settings, so the event will not appear on the board until you switch it on there.",
  createReadOnly:
    "This calendar does not accept new events: macOS keeps it read-only. Go back and choose another calendar.",
  createCalendarMissing:
    "This calendar is no longer in that account on this Mac. Go back and choose another calendar.",
  createFailed: (message: string) => `Could not create the event: ${message}`,
  createMaybeSaved: (message: string) =>
    `The answer did not come back (${message}), so the event may have been created. Check the board before creating it again.`,
  problemCalendar: "Choose the calendar this goes on.",
  problemTitle: "Give the event a title.",
  problemStart: "Choose a start date and time.",
  problemDuration: "The duration must be a whole number of minutes, above zero.",

  pillNow: (title: string) => `${title} now`,
  pillIn: (title: string, minutes: number) => `${title} in ${minutes} min`,
};

const ru: Strings = {
  sidebarTitle: "Календарь",
  settingsTitle: "Аккаунты календаря",
  noAccounts: "Аккаунтов пока нет. Подключите один, чтобы видеть здесь свой день.",
  loadingSettings: "Загружаем аккаунты…",
  settingsLoadError: "Не удалось загрузить аккаунты. Повторяем попытку…",
  disconnect: "Отключить",
  calendarsLabel: "Отображаемые календари",
  lastSync: (when: string) => `Обновлено ${when}`,
  working: "Выполняется…",
  commandCenterSettings: "Календарь: аккаунты",

  settingsSubtitle: "Подключите аккаунт, чтобы видеть свой день и то, что с чем пересекается.",
  accountsSection: "Аккаунты",
  grantAccess: "Разрешить доступ к календарю",
  grantAccessWhy:
    "macOS спросит один раз, про этот хелпер. Снова она спросит, только если обновление пересоберёт хелпер (изменится его исходный код) или хелпер пропадёт.",
  accessAsking: "Ждём вашего ответа в системном диалоге…",
  connectRunningSystem: "Читаем этот аккаунт…",
  systemBlurb: "Один аккаунт, который macOS уже синхронизирует — Exchange, Google или iCloud. Без пароля и прав администратора.",
  pillLeadLabel: "Показывать пилюлю",
  pillLeadHint:
    "За сколько до встречи появляется пилюля в композере. Уже идущая встреча показывается всегда, независимо от этой настройки.",
  pillLeadAlways: "Всегда",
  pillLeadMinutes: (minutes: number) => `${minutes} мин`,
  defaultViewLabel: "Открывать на",
  defaultViewHint:
    "С какого вида открывается календарь. Переключение на самой доске — только до следующего открытия; сюда он возвращается.",
  calendarCount: (count: number) => `Календарей: ${count}`,
  openPrivacy: "Открыть настройки приватности",
  onTheMac: "Сделайте это на Mac, на котором работает Paseo.",
  calendarAccessRefused:
    "macOS отказала в доступе к календарю. Разрешите «JobbyJobs Calendar Helper» в разделе Конфиденциальность и безопасность → Календари и подключитесь снова.",
  calendarsShown: (shown: number, total: number) => `Календарей: ${shown} из ${total}`,
  notOnMacSince: (date: string) => `Нет на этом Mac с ${date}`,
  relinkOffer: (title: string) => `Взять аккаунт «${title}», найденный на этом Mac`,
  relinkHint:
    "macOS заново добавила этот аккаунт под новым идентификатором. Перепривязка сохранит эту строку и выбор показываемых календарей.",
  relinkFailed: (message: string) => `Не удалось перепривязать: ${message}`,
  foundSection: "Найдено на этом Mac",
  foundHint:
    "Календарные аккаунты, которые macOS уже синхронизирует, но которые здесь ещё не читаются. Добавленный аккаунт показывает все свои календари; лишние можно выключить.",
  foundNone: "Все календарные аккаунты этого Mac уже здесь.",
  foundFailed: "Не удалось получить список календарных аккаунтов этого Mac. Пробуем снова…",
  notSaved: "Ничего не изменилось: файл аккаунтов сейчас не сохраняется (см. выше).",
  addSource: "Добавить",
  disconnectConfirm: (label: string) =>
    `Перестать читать ${label}? На этом Mac он останется, и его можно снова добавить из раздела «Найдено на этом Mac».`,
  kindLocal: "На этом Mac",
  kindSubscribed: "Подписка",
  kindBirthdays: "Дни рождения",
  kindOther: "Календарный аккаунт",
  noAccountsHint: "Добавьте ниже один из аккаунтов, найденных на этом Mac.",
  accountRowA11y: (label: string) => `${label}: календари и настройки`,
  rereadCalendars: "Прочитать его календари заново",

  periodAgenda: "Список",
  periodDay: "День",
  periodMonth: "Месяц",
  jumpToday: "Сегодня",
  earlier: "Раньше",
  later: "Позже",
  previousMonth: "Предыдущий месяц",
  nextMonth: "Следующий месяц",
  done: "Готово",
  pickDate: "Дата",
  pickTime: "Время",
  eventCount: (count: number) => `${count}`,
  nothingInPeriod: "Здесь пусто.",
  eventsA11y: (count: number) => `Событий: ${count}`,
  overlapsA11y: "пересекается с другой встречей",
  today: "Сегодня",
  tomorrow: "Завтра",
  overlapWarning: (minutes: number) => `Пересечение: ${minutes} мин`,
  nothingToday: "В календаре пока ничего нет.",
  settings: "Настройки",
  refresh: "Обновить",
  eventsLoadError: "Не удалось загрузить календарь. Повторяем попытку…",
  syncIssue: (message: string) => `Проблема синхронизации: ${message}`,

  issueGone: (label: string) => (label ? `${label} больше нет на этом Mac.` : "Этого календарного аккаунта больше нет на этом Mac."),
  issueMoved: (label: string) =>
    `${label} переехал: macOS заново добавила его как новый аккаунт, и его встреч здесь нет, пока его не перепривязать.`,
  issueMacos: "Для чтения календарей нужна macOS, а этот демон Paseo запущен не на Mac.",
  issueHelper: (message: string) => `Помощник календаря на этом Mac не ответил: ${message}`,
  issueStoreBroken: (aside: string) =>
    `Файл аккаунтов прочитан не полностью, поэтому ничего не сохраняется.${
      aside
        ? ` Копия сохранена как ${aside}. Верните исправный calendar.json, чтобы сохранение снова заработало.`
        : " Сделать его копию не удалось, поэтому не удаляйте и не заменяйте calendar.json: другой копии нет. Исправьте его на месте, чтобы сохранение снова заработало."
    }`,
  issueAccount: (label: string, message: string) => `Не удалось прочитать ${label}: ${message}`,

  back: "Назад",
  allDay: "Весь день",
  whoLabel: "Участники",
  you: "Вы",
  external: "Внешний",
  calendarLabel: "Календарь",
  calendarsFoundLabel: "Календари",
  whereLabel: "Место",
  descriptionLabel: "Описание",
  joinMeet: "Подключиться в Meet",
  joinTeams: "Подключиться в Teams",
  joinZoom: "Подключиться в Zoom",
  joinGeneric: "Подключиться",
  edit: "Изменить",
  editTitle: "Изменить встречу",
  save: "Сохранить",
  saving: "Сохраняем…",
  seriesNotEditable:
    "Это повторяющаяся встреча. Изменить одно вхождение и изменить всю серию — разные вещи, а изменилась бы именно серия, поэтому не меняется ничего.",
  allDayNotEditable: "Событие на весь день здесь не редактируется: измените его в Календаре. Удалить его можно.",
  changeInCalendar: "Измените её в Календаре: здесь меняются только встречи от сегодня до 14 дней вперёд.",
  editFailed: (message: string) => `Не удалось сохранить: ${message}`,
  deleteLabel: "Удалить",
  deleteConfirmTitle: "Удалить встречу?",
  deleteConfirm: (title: string) => `«${title}» будет удалена. Это необратимо.`,
  deleting: "Удаляем…",
  seriesNotDeletable:
    "Это повторяющаяся встреча. Удаление здесь убрало бы все вхождения серии, поэтому оно не предлагается.",
  deleteFailed: (message: string) => `Не удалось удалить: ${message}`,
  rsvpUnavailable:
    "macOS не может отвечать на приглашения для этого аккаунта: она показывает, кто как ответил, но изменить это не даёт. Ответьте в Календаре или в письме с приглашением.",

  createTitle: "Новое событие",
  createNeedsAccount: "Подключите аккаунт календаря, прежде чем создавать событие.",
  createNoWritable:
    "Ни одна из этих учётных записей не принимает новые события: подписки и дни рождения доступны только для чтения, а в учётную запись, которой нет на этом Mac, записать нельзя.",
  titleLabel: "Название",
  startLabel: "Начало",
  startHint: (zone: string) => `Читается в вашем часовом поясе (${zone}).`,
  durationLabel: "Длительность в минутах",
  review: "Проверить",
  cancel: "Отмена",
  create: "Создать",
  creating: "Создаём…",
  createQueuedNote:
    "Создание идёт в одной очереди с синхронизацией и подключением, поэтому может ждать уже запущенную операцию. Это не ошибка.",
  confirmTitle: "Проверьте, прежде чем создавать",
  whenLabel: "Когда",
  confirmLocalOnly:
    "Событие будет записано в календарь на этом Mac. Приглашения не отправляются и ссылка на встречу не создаётся; занимается только ваше время.",
  confirmHiddenCalendar:
    "Этот календарь выключен в настройках календаря, поэтому событие не появится на доске, пока вы его там не включите.",
  createReadOnly:
    "Этот календарь не принимает новые события: macOS держит его только для чтения. Вернитесь и выберите другой календарь.",
  createCalendarMissing:
    "Этого календаря больше нет в этой учётной записи на этом Mac. Вернитесь и выберите другой календарь.",
  createFailed: (message: string) => `Не удалось создать событие: ${message}`,
  createMaybeSaved: (message: string) =>
    `Ответ не пришёл (${message}), поэтому событие могло быть создано. Проверьте доску, прежде чем создавать его снова.`,
  problemCalendar: "Выберите календарь, в котором создать событие.",
  problemTitle: "Укажите название события.",
  problemStart: "Выберите дату и время начала.",
  problemDuration: "Длительность — целое число минут, больше нуля.",

  pillNow: (title: string) => `${title} сейчас`,
  pillIn: (title: string, minutes: number) => `${title} через ${minutes} мин`,
};

const uk: Strings = {
  sidebarTitle: "Календар",
  settingsTitle: "Акаунти календаря",
  noAccounts: "Акаунтів поки немає. Підключіть один, щоб бачити тут свій день.",
  loadingSettings: "Завантажуємо акаунти…",
  settingsLoadError: "Не вдалося завантажити акаунти. Повторюємо спробу…",
  disconnect: "Відключити",
  calendarsLabel: "Календарі, що показуються",
  lastSync: (when: string) => `Оновлено ${when}`,
  working: "Виконується…",
  commandCenterSettings: "Календар: акаунти",

  settingsSubtitle: "Підключіть акаунт, щоб бачити свій день і те, що з чим накладається.",
  accountsSection: "Акаунти",
  grantAccess: "Дозволити доступ до календаря",
  grantAccessWhy:
    "macOS запитає один раз, про цей хелпер. Знову вона запитає, лише якщо оновлення перезбере хелпер (зміниться його вихідний код) або хелпер зникне.",
  accessAsking: "Чекаємо на вашу відповідь у системному діалозі…",
  connectRunningSystem: "Читаємо цей акаунт…",
  systemBlurb: "Один акаунт, який macOS уже синхронізує — Exchange, Google або iCloud. Без пароля та прав адміністратора.",
  pillLeadLabel: "Показувати пігулку",
  pillLeadHint:
    "За скільки до зустрічі з\u0027являється пігулка в композері. Зустріч, що вже триває, показується завжди, незалежно від цього налаштування.",
  pillLeadAlways: "Завжди",
  pillLeadMinutes: (minutes: number) => `${minutes} хв`,
  defaultViewLabel: "Відкривати на",
  defaultViewHint:
    "З якого вигляду відкривається календар. Перемикання на самій дошці — лише до наступного відкриття; сюди він повертається.",
  calendarCount: (count: number) => `Календарів: ${count}`,
  openPrivacy: "Відкрити налаштування приватності",
  onTheMac: "Зробіть це на Mac, на якому працює Paseo.",
  calendarAccessRefused:
    "macOS відмовила в доступі до календаря. Дозвольте «JobbyJobs Calendar Helper» у розділі Конфіденційність і безпека → Календарі та підключіться знову.",
  calendarsShown: (shown: number, total: number) => `Календарів: ${shown} з ${total}`,
  notOnMacSince: (date: string) => `Немає на цьому Mac з ${date}`,
  relinkOffer: (title: string) => `Узяти акаунт «${title}», знайдений на цьому Mac`,
  relinkHint:
    "macOS знову додала цей акаунт під новим ідентифікатором. Переприв'язка збереже цей рядок і вибір календарів, що показуються.",
  relinkFailed: (message: string) => `Не вдалося переприв'язати: ${message}`,
  foundSection: "Знайдено на цьому Mac",
  foundHint:
    "Календарні акаунти, які macOS уже синхронізує, але які тут ще не читаються. Доданий акаунт показує всі свої календарі; зайві можна вимкнути.",
  foundNone: "Усі календарні акаунти цього Mac уже тут.",
  foundFailed: "Не вдалося отримати список календарних акаунтів цього Mac. Пробуємо знову…",
  notSaved: "Нічого не змінилося: файл акаунтів зараз не зберігається (див. вище).",
  addSource: "Додати",
  disconnectConfirm: (label: string) =>
    `Перестати читати ${label}? На цьому Mac він залишиться, і його можна знову додати з розділу «Знайдено на цьому Mac».`,
  kindLocal: "На цьому Mac",
  kindSubscribed: "Підписка",
  kindBirthdays: "Дні народження",
  kindOther: "Календарний акаунт",
  noAccountsHint: "Додайте нижче один з акаунтів, знайдених на цьому Mac.",
  accountRowA11y: (label: string) => `${label}: календарі та налаштування`,
  rereadCalendars: "Прочитати його календарі заново",

  periodAgenda: "Список",
  periodDay: "День",
  periodMonth: "Місяць",
  jumpToday: "Сьогодні",
  earlier: "Раніше",
  later: "Пізніше",
  previousMonth: "Попередній місяць",
  nextMonth: "Наступний місяць",
  done: "Готово",
  pickDate: "Дата",
  pickTime: "Час",
  eventCount: (count: number) => `${count}`,
  nothingInPeriod: "Тут порожньо.",
  eventsA11y: (count: number) => `Подій: ${count}`,
  overlapsA11y: "накладається на іншу зустріч",
  today: "Сьогодні",
  tomorrow: "Завтра",
  overlapWarning: (minutes: number) => `Накладання: ${minutes} хв`,
  nothingToday: "У календарі поки нічого немає.",
  settings: "Налаштування",
  refresh: "Оновити",
  eventsLoadError: "Не вдалося завантажити календар. Повторюємо спробу…",
  syncIssue: (message: string) => `Проблема синхронізації: ${message}`,

  issueGone: (label: string) => (label ? `${label} більше немає на цьому Mac.` : "Цього календарного акаунта більше немає на цьому Mac."),
  issueMoved: (label: string) =>
    `${label} переїхав: macOS знову додала його як новий акаунт, і його зустрічей тут немає, доки його не переприв'язати.`,
  issueMacos: "Для читання календарів потрібна macOS, а цей демон Paseo запущено не на Mac.",
  issueHelper: (message: string) => `Помічник календаря на цьому Mac не відповів: ${message}`,
  issueStoreBroken: (aside: string) =>
    `Файл акаунтів прочитано не повністю, тому нічого не зберігається.${
      aside
        ? ` Копію збережено як ${aside}. Поверніть справний calendar.json, щоб збереження знову запрацювало.`
        : " Зробити його копію не вдалося, тож не видаляйте й не замінюйте calendar.json: іншої копії немає. Виправте його на місці, щоб збереження знову запрацювало."
    }`,
  issueAccount: (label: string, message: string) => `Не вдалося прочитати ${label}: ${message}`,

  back: "Назад",
  allDay: "Увесь день",
  whoLabel: "Учасники",
  you: "Ви",
  external: "Зовнішній",
  calendarLabel: "Календар",
  calendarsFoundLabel: "Календарі",
  whereLabel: "Місце",
  descriptionLabel: "Опис",
  joinMeet: "Приєднатися в Meet",
  joinTeams: "Приєднатися в Teams",
  joinZoom: "Приєднатися в Zoom",
  joinGeneric: "Приєднатися",
  edit: "Змінити",
  editTitle: "Змінити зустріч",
  save: "Зберегти",
  saving: "Зберігаємо…",
  seriesNotEditable:
    "Це повторювана зустріч. Змінити одне входження і змінити всю серію — різні речі, а змінилася б саме серія, тому не змінюється нічого.",
  allDayNotEditable: "Подію на весь день тут не редагують: змініть її в Календарі. Видалити її можна.",
  changeInCalendar: "Змініть її в Календарі: тут змінюються лише зустрічі від сьогодні до 14 днів наперед.",
  editFailed: (message: string) => `Не вдалося зберегти: ${message}`,
  deleteLabel: "Видалити",
  deleteConfirmTitle: "Видалити зустріч?",
  deleteConfirm: (title: string) => `«${title}» буде видалено. Це незворотно.`,
  deleting: "Видаляємо…",
  seriesNotDeletable:
    "Це повторювана зустріч. Видалення тут прибрало б усі входження серії, тому воно не пропонується.",
  deleteFailed: (message: string) => `Не вдалося видалити: ${message}`,
  rsvpUnavailable:
    "macOS не може відповідати на запрошення для цього акаунта: вона показує, хто як відповів, але змінити це не дає. Відповідайте в Календарі або в листі із запрошенням.",

  createTitle: "Нова подія",
  createNeedsAccount: "Підключіть акаунт календаря, перш ніж створювати подію.",
  createNoWritable:
    "Жоден із цих облікових записів не приймає нових подій: підписки й дні народження доступні лише для перегляду, а до облікового запису, якого немає на цьому Mac, записати не можна.",
  titleLabel: "Назва",
  startLabel: "Початок",
  startHint: (zone: string) => `Читається у вашому часовому поясі (${zone}).`,
  durationLabel: "Тривалість у хвилинах",
  review: "Перевірити",
  cancel: "Скасувати",
  create: "Створити",
  creating: "Створюємо…",
  createQueuedNote:
    "Створення йде в одній черзі із синхронізацією та підключенням, тож може чекати вже запущену операцію. Це не помилка.",
  confirmTitle: "Перевірте, перш ніж створювати",
  whenLabel: "Коли",
  confirmLocalOnly:
    "Подію буде записано в календар на цьому Mac. Запрошення не надсилаються й посилання на зустріч не створюється; займається лише ваш час.",
  confirmHiddenCalendar:
    "Цей календар вимкнено в налаштуваннях календаря, тож подія не з'явиться на дошці, доки ви його там не ввімкнете.",
  createReadOnly:
    "Цей календар не приймає нових подій: macOS тримає його лише для перегляду. Поверніться й виберіть інший календар.",
  createCalendarMissing:
    "Цього календаря більше немає в цьому обліковому записі на цьому Mac. Поверніться й виберіть інший календар.",
  createFailed: (message: string) => `Не вдалося створити подію: ${message}`,
  createMaybeSaved: (message: string) =>
    `Відповідь не надійшла (${message}), тож подію могло бути створено. Перевірте дошку, перш ніж створювати її знову.`,
  problemCalendar: "Виберіть календар, у якому створити подію.",
  problemTitle: "Вкажіть назву події.",
  problemStart: "Виберіть дату й час початку.",
  problemDuration: "Тривалість — ціле число хвилин, більше за нуль.",

  pillNow: (title: string) => `${title} зараз`,
  pillIn: (title: string, minutes: number) => `${title} через ${minutes} хв`,
};

const FALLBACK: Locale = "en";

/** Narrows any BCP-47 tag to a catalogue entry: `ru-RU` and `ru` both land on `ru`. */
export function resolveLocale(tag: string | undefined): Locale {
  const base = (tag ?? "").toLowerCase().split(/[-_]/)[0];
  return base === "ru" || base === "uk" || base === "en" ? base : FALLBACK;
}

/**
 * Works on every runtime a plugin reaches: Hermes on the phones, the browser engine on
 * desktop and web, and Node in the daemon subprocess. `process.env.LANG` — this function's
 * previous source — is undefined under both Hermes and a desktop webview, so every surface
 * rendered English regardless of the viewer's own language until this asked Intl instead.
 */
export function detectLocale(): Locale {
  try {
    return resolveLocale(new Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return FALLBACK;
  }
}

/**
 * The language chosen in Paseo's own settings, when it can be read, so this plugin follows the
 * app's language rather than only the device's. The SDK hands a surface the app's language only
 * from 0.13 on (useTranslation), and the manifest asks for 0.8. But on the desktop and the web
 * the plugin runs in the same window as Paseo, whose settings live in localStorage as one JSON
 * record carrying `language` and `theme`. The record is found by shape rather than by key, so a
 * renamed key degrades to the device language instead of breaking. "system" means the device
 * language; the phone has no localStorage and gets the same, and so does the daemon (server/
 * never calls this, but shared/ compiles into both bundles, and Node has no localStorage either).
 */
export function detectAppLocale(): Locale {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        const raw = key ? storage.getItem(key) : null;
        if (!raw || raw[0] !== "{" || !raw.includes('"language"')) continue;
        const parsed = JSON.parse(raw) as { language?: unknown; theme?: unknown };
        if (typeof parsed.language !== "string" || !("theme" in parsed)) continue;
        if (parsed.language === "system") break;
        return resolveLocale(parsed.language);
      }
    }
  } catch {
    // Storage may be absent, blocked, or hold something that is not JSON; the device
    // language is the right answer in every one of those cases.
  }
  return detectLocale();
}

export function t(locale: Locale): Strings {
  return locale === "ru" ? ru : locale === "uk" ? uk : en;
}
