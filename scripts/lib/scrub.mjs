/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Scrubs account-identifying data out of captured Alarm.com
 * payloads so they can be committed as test fixtures.
 *
 * The mappers under test care about `deviceType`, `state`, `openClosedStatus`,
 * and battery flags. None of them care what a sensor is called or which panel
 * it belongs to, so all of that is replaced. Identifiers are pseudonymized
 * consistently within a run, which preserves the cross-references between a
 * system's `relationships` and the device documents they point at.
 */

/** Device identifiers look like `<unitId>-<deviceId>`, e.g. `1234567-42`. */
const DEVICE_ID_PATTERN = /^\d{4,}-\d+$/

/** Bare numeric identifiers of this length or more are system/unit IDs. */
const BARE_ID_PATTERN = /^\d{4,}$/

/**
 * Alarm.com also issues identifiers with an environment prefix, e.g.
 * `PROD-9000999` for `customerId` and `visitorId`.
 *
 * These matched neither pattern above, so a customer number was written into
 * scrubbed output verbatim. The prefix names the environment and carries
 * nothing personal, so it is kept and only the number is rewritten.
 */
const PREFIXED_ID_PATTERN = /^([A-Z]{2,10})-(\d{4,})$/

/** Value-shape backstops, applied regardless of which key held the value. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_PATTERN = /^\+?\d[\d\s().-]{8,17}$/

/**
 * Replaced wholesale: these say nothing about protocol behavior.
 *
 * The contact fields are here because the two-factor document returns the
 * account's real phone number and email. Nothing in this codebase needs those
 * values, and a fixture must never carry them.
 */
const REDACTED_VALUES = {
  macAddress: '00:00:00:00:00:00',
  publicIp: '0.0.0.0',
  privateIp: '0.0.0.0',
  firmwareVersion: '0.0.0',
  deviceImagePath: '/redacted.png',
  email: 'user@example.com',
  emailAddress: 'user@example.com',
  mobileNumber: '5555550100',
  phoneNumber: '5555550100',
  phone: '5555550100',
  smsNumber: '5555550100',
  loginName: 'user@example.com',
  loginInitials: 'XX',

  // The monitoring provider's branding. `logoAlt` is the dealer's trading
  // name, which says who watches this particular house, and the image paths
  // identify the same dealer indirectly.
  logoAlt: 'Example Security',
  logoUrl: '/redacted.png',
  favIconUrl: '/redacted.png',

  // Coarse location, and Alarm.com's own server names. Neither affects any
  // mapping, and both describe the account holder or Alarm.com's estate.
  timezone: 'UTC',
  localizeTimeZone: 'UTC',
  country: 'XX',
  machineName: 'REDACTED',
}

/** Human-readable names. Personal, and irrelevant to state mapping. */
const NAME_KEYS = new Set([
  'description',
  'name',
  'displayName',
  'systemName',
  'dealerName',
  'providerName',
  'currentDeviceName',
  'selectedSystemDescription',
])

/** Keys whose values are identifiers needing consistent pseudonymization. */
const ID_KEYS = new Set([
  'id', 'unitId', 'UnitId', 'systemId', 'partitionId', 'customerId', 'dealerId', 'visitorId',
])

/**
 * WebSocket frames carry a `QstringForExtraData` query string that mixes
 * protocol data with account data: a login event includes the account email
 * (URL-encoded, so it evades a plain email match) and the originating public
 * IP, while a sensor event includes `openClosedStatusWord`, which the mappers
 * genuinely need. Keep the protocol params, drop the rest.
 */
const QSTRING_SAFE_PARAMS = new Set(['openClosedStatusWord', 'src', 'mrid', 'state', 'zone'])

function scrubQueryString(value) {
  const params = new URLSearchParams(value)
  const kept = [...params].filter(([key]) => QSTRING_SAFE_PARAMS.has(key))
  const dropped = [...params].length - kept.length
  const rendered = kept.map(([key, item]) => `${key}=${item}`).join('&')
  return dropped > 0 ? `${rendered}${rendered ? '&' : ''}redacted=${dropped}` : rendered
}

/**
 * Free-text equivalents of the shape patterns above.
 *
 * The anchored versions only match a value that is nothing but an identifier.
 * Error messages quote them mid-sentence.
 */
const EMAIL_IN_TEXT = /[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/gi
/** The same address percent-encoded, which is how it arrives in query strings. */
const ENCODED_EMAIL_IN_TEXT = /[^\s@"'<>&=]+%40[^\s@"'<>&=]+\.[a-z]{2,}/gi
const PHONE_IN_TEXT = /\+?\d[\d\s().-]{7,16}\d/g
/** Below this many digits a run is a date or a version, not a phone number. */
const PHONE_MIN_DIGITS = 10
const PREFIXED_ID_IN_TEXT = /\b[A-Z]{2,10}-\d{4,}\b/g
/**
 * A device identifier in prose.
 *
 * The trailing lookahead keeps `2026-07-29` out of it. An ISO date has the
 * same shape as `<unitId>-<deviceId>` up to its second hyphen, and rewriting
 * the timestamps in an error message makes it harder to read for no gain.
 */
const DEVICE_ID_IN_TEXT = /\b\d{4,}-\d+\b(?!-\d)/g
const BARE_ID_IN_TEXT = /\b\d{7,}\b/g

/**
 * Redact identifiers and contact details from a free-text string.
 *
 * For text that is printed rather than stored as a document: API error
 * messages, redirect targets, and the like. These are quoted verbatim from
 * Alarm.com, and the terminal they land in is what gets pasted into an issue.
 *
 * Deliberately blunt, and not a substitute for {@link createScrubber}: it has
 * no memory, so the placeholders it writes do not cross-reference anything.
 */
export function redactFreeText(value) {
  if (typeof value !== 'string') {return value}

  // Identifiers before phone numbers: a bare identifier is a run of digits and
  // would otherwise be claimed by the phone pattern and mislabelled.
  return value
    .replace(EMAIL_IN_TEXT, 'user@example.com')
    .replace(ENCODED_EMAIL_IN_TEXT, 'user%40example.com')
    .replace(PREFIXED_ID_IN_TEXT, '<id>')
    .replace(DEVICE_ID_IN_TEXT, '<device-id>')
    .replace(BARE_ID_IN_TEXT, '<id>')
    .replace(PHONE_IN_TEXT, (match) =>
      match.replace(/\D/g, '').length >= PHONE_MIN_DIGITS ? '<phone>' : match)
}

/**
 * Build a scrubber with its own identifier namespace.
 *
 * Each real identifier maps to one stable fake for the lifetime of the
 * scrubber, so `relationships.sensors.data[3].id` still resolves to the same
 * document it did before scrubbing.
 */
export function createScrubber() {
  const units = new Map()
  const names = new Map()

  /** Map one real panel/unit identifier to a stable fake one. */
  const pseudonymizeUnit = (value) => {
    if (!units.has(value)) {units.set(value, String(9000000 + units.size + 1))}
    return units.get(value)
  }

  /**
   * Device identifiers are `<unitId>-<deviceId>`. Rewrite only the unit half,
   * using the same mapping as bare system identifiers, and keep the trailing
   * ordinal as-is.
   *
   * Preserving that structure is not cosmetic: WebSocket frames identify a
   * device by `UnitId` and `DeviceId` separately, and the plugin matches them
   * against the composite id. A fixture that broke the correspondence would
   * quietly invalidate every test of that matching logic.
   */
  const pseudonymizeId = (value) => {
    const prefixed = PREFIXED_ID_PATTERN.exec(value)
    if (prefixed) {
      const [, prefix, number] = prefixed
      return `${prefix}-${pseudonymizeUnit(number)}`
    }

    const separator = value.indexOf('-')
    if (separator === -1) {return pseudonymizeUnit(value)}
    return `${pseudonymizeUnit(value.slice(0, separator))}-${value.slice(separator + 1)}`
  }

  const pseudonymizeName = (value) => {
    if (!names.has(value)) {names.set(value, `Device ${names.size + 1}`)}
    return names.get(value)
  }

  const scrubValue = (key, value) => {
    if (typeof value !== 'string') {return value}
    if (key === 'QstringForExtraData') {return scrubQueryString(value)}
    if (key in REDACTED_VALUES) {return REDACTED_VALUES[key]}
    if (NAME_KEYS.has(key)) {return pseudonymizeName(value)}
    if (ID_KEYS.has(key)
      && (DEVICE_ID_PATTERN.test(value) || BARE_ID_PATTERN.test(value) || PREFIXED_ID_PATTERN.test(value))) {
      return pseudonymizeId(value)
    }
    // Identifiers also appear embedded in values that are not under an `id`
    // key, such as `included` references and self links. Matching on shape
    // rather than on key is what catches the ones nobody thought to list:
    // `visitorId` held a real customer number under a key of its own.
    if (DEVICE_ID_PATTERN.test(value) || PREFIXED_ID_PATTERN.test(value)) {
      return pseudonymizeId(value)
    }
    // Backstop. A key allowlist only redacts what was anticipated, and the
    // two-factor document proved that assumption wrong by returning contact
    // details under keys nothing else uses. Catch the shapes regardless of key.
    if (EMAIL_PATTERN.test(value)) {return 'user@example.com'}
    if (PHONE_PATTERN.test(value)) {return '5555550100'}
    return value
  }

  /**
   * A recorded before/after change, as the watch script emits.
   *
   * The value lives under `from` and `to` while the attribute it belongs to is
   * named in a sibling `key`, so scrubbing against the literal names `from`
   * and `to` decides nothing. The values have to be judged against the
   * attribute they describe.
   */
  const isChangeRecord = (node) =>
    typeof node.key === 'string' && 'from' in node && 'to' in node && Object.keys(node).length === 3

  const walk = (node, key = '') => {
    if (Array.isArray(node)) {return node.map((item) => walk(item, key))}
    if (node !== null && typeof node === 'object') {
      if (isChangeRecord(node)) {
        return { key: node.key, from: walk(node.from, node.key), to: walk(node.to, node.key) }
      }
      return Object.fromEntries(Object.entries(node).map(([childKey, child]) => [childKey, walk(child, childKey)]))
    }
    if (typeof node === 'number' && ID_KEYS.has(key) && node > 9999) {
      return Number(pseudonymizeId(String(node)))
    }
    return scrubValue(key, node)
  }

  return {
    scrub: walk,
    /** Count of distinct panels rewritten, for the run summary. */
    get identifierCount() {
      return units.size
    },
  }
}
