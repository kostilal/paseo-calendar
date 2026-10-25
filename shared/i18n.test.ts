import { test } from "node:test";
import assert from "node:assert/strict";
import { type Locale, t } from "./i18n.ts";

const LOCALES: Locale[] = ["en", "ru", "uk"];
const GONE = [
  "connecting", "needsReconnect", "reconnect", "googleBlurb", "googleUnconfigured", "microsoftUnavailable",
  "connectRunningGoogle", "connectInvalidClient", "connectRedirectMismatch", "connectAccessDenied",
  "connectExpiredGrant", "connectConsentTimeout", "connectStateMismatch", "rsvpLabel", "rsvpGoing", "rsvpMaybe",
  "rsvpNo", "rsvpFailed", "notifyLabel", "notifyHint", "deleteNotifyHint", "conferencingLabel",
  "conferencingUnavailable", "confirmGoogleInvites", "confirmGoogleMeet", "confirmGoogleAlone",
];

/** Every string a locale can show; functions are called on a placeholder argument. */
function texts(locale: Locale): string[] {
  return Object.values(t(locale)).map((value) =>
    typeof value === "function" ? String((value as (...args: unknown[]) => string)("x", "x")) : String(value),
  );
}

test("the strings only the Google sign-in used are gone from every locale", () => {
  for (const locale of LOCALES) for (const key of GONE) assert.equal(key in t(locale), false, `${locale}.${key}`);
});

test("no locale still talks about a sign-in, a consent window, a browser or Microsoft's own door", () => {
  const banned: Record<Locale, RegExp> = {
    en: /\b(OAuth|consent|sign(ing)? in|reconnect|Microsoft|Graph|Testing|browser)\b/i,
    ru: /OAuth|согласия|переподключ|Microsoft|браузер/i,
    uk: /OAuth|згоди|перепідключ|Microsoft|браузер/i,
  };
  for (const locale of LOCALES) for (const text of texts(locale)) assert.doesNotMatch(text, banned[locale], `${locale}: ${text}`);
});

test("every locale names the arrow and back buttons in words a screen reader can say", () => {
  for (const locale of ["en", "ru", "uk"] as const) {
    const strings = t(locale);
    for (const label of [strings.back, strings.earlier, strings.later, strings.previousMonth, strings.nextMonth]) {
      assert.ok(label.trim().length > 1, `${locale}: ${label}`);
      assert.doesNotMatch(label, /^[\s−+‹›<>]*$/);
    }
  }
  assert.notEqual(t("ru").previousMonth, t("en").previousMonth);
  assert.notEqual(t("uk").nextMonth, t("ru").nextMonth);
});
