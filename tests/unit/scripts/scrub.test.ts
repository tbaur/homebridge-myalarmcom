/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The scrubber is what stands between a live security system's data and a
 * public git repository, so it is tested like a control rather than like a
 * development convenience. Every case here is a shape that was observed in a
 * real capture, and several are ones an earlier version let through.
 *
 * The cases assert that no real value survives, rather than that a particular
 * replacement was chosen. Over-redaction costs a duller fixture; a miss costs
 * a disclosure that cannot be taken back.
 */

/**
 * Import the scrubber as real ESM.
 *
 * The scripts are `.mjs` and this suite is compiled to CommonJS, where
 * TypeScript would rewrite a plain `import()` into a `require()` that cannot
 * load an ES module. Building the call through `Function` keeps it out of the
 * compiler's reach.
 */
const importEsm = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<ScrubModule>

interface Scrubber {
  scrub: (value: unknown) => never
  readonly identifierCount: number
}

interface ScrubModule {
  createScrubber: () => Scrubber
  redactFreeText: (value: string) => string
}

let createScrubber: () => Scrubber
let redactFreeText: (value: string) => string

beforeAll(async () => {
  ({ createScrubber, redactFreeText } = await importEsm('../../../scripts/lib/scrub.mjs'))
})

/** Scrub a document and return it as text, for "does this substring survive" checks. */
function scrubbedText(document: unknown): string {
  return JSON.stringify(createScrubber().scrub(document))
}

describe('scrubbing a captured Alarm.com payload', () => {
  describe('identifiers', () => {
    it('pseudonymizes bare system identifiers', () => {
      expect(scrubbedText({ systemId: '7654321' })).not.toContain('7654321')
    })

    /**
     * Regression. `customerId` and `visitorId` are prefixed, e.g.
     * `PROD-9000999`, which matched neither the device nor the bare pattern,
     * so a customer number was written into scrubbed output verbatim.
     */
    it.each(['customerId', 'visitorId', 'dealerId'])(
      'pseudonymizes the prefixed identifier under %s',
      (key) => {
        const text = scrubbedText({ [key]: 'PROD-9000999' })

        expect(text).not.toContain('9000999')
        // The prefix names the environment and is worth keeping.
        expect(text).toContain('PROD-')
      },
    )

    it('pseudonymizes a prefixed identifier under a key nobody listed', () => {
      expect(scrubbedText({ somethingNew: 'PROD-9000999' })).not.toContain('9000999')
    })

    /**
     * WebSocket frames name a device by `UnitId` and `DeviceId` separately and
     * the plugin matches them against the composite `id`. A scrubber that
     * broke that correspondence would silently invalidate every fixture that
     * tests the matching.
     */
    it('keeps a device identifier consistent with the unit it belongs to', () => {
      const scrubbed = createScrubber().scrub({
        id: '1234567-42',
        unitId: 1234567,
        related: { id: '1234567-9' },
      }) as unknown as { id: string, unitId: number, related: { id: string } }

      expect(scrubbed.id).not.toContain('1234567')
      expect(scrubbed.id.split('-')[0]).toBe(String(scrubbed.unitId))
      expect(scrubbed.related.id.split('-')[0]).toBe(String(scrubbed.unitId))
      // The device ordinal is protocol detail, not account data.
      expect(scrubbed.id.endsWith('-42')).toBe(true)
    })

    it('gives different accounts different pseudonyms', () => {
      const scrubbed = createScrubber().scrub({ a: { id: '1111111-1' }, b: { id: '2222222-1' } }) as
        unknown as { a: { id: string }, b: { id: string } }

      expect(scrubbed.a.id).not.toBe(scrubbed.b.id)
    })
  })

  describe('personal and account data', () => {
    it('replaces contact details wherever they appear', () => {
      const text = scrubbedText({
        emailAddress: 'real.person@example.org',
        mobileNumber: '+1 555 010 9999',
        loginName: 'real.person@example.org',
      })

      expect(text).not.toContain('real.person')
      expect(text).not.toContain('0109999')
    })

    /**
     * Backstop. A key allowlist only redacts what was anticipated, and the
     * two-factor document returned contact details under keys nothing else
     * uses.
     */
    it('catches contact details by shape, under a key it has never seen', () => {
      const text = scrubbedText({ someUndocumentedField: 'real.person@example.org' })

      expect(text).not.toContain('real.person')
    })

    it('replaces device names, which describe the inside of a house', () => {
      expect(scrubbedText({ description: 'Master Bedroom Window' }))
        .not.toContain('Master Bedroom')
    })

    /**
     * Regression. `logoAlt` carries the monitoring dealer's trading name,
     * which says who watches this particular house.
     */
    it('replaces the monitoring provider branding', () => {
      const text = scrubbedText({
        logoAlt: 'Acme Monitoring Co',
        logoUrl: '/api/PublishedImage/4242',
        favIconUrl: '/NewPublicLibraryFiles/images/favicons/adcfavicon.png',
      })

      expect(text).not.toContain('Acme Monitoring')
      expect(text).not.toContain('4242')
    })

    it('replaces coarse location and Alarm.com server names', () => {
      const text = scrubbedText({
        timezone: 'Pacific/Kiritimati',
        country: 'Ruritania',
        machineName: 'XX99FAKEADC01',
      })

      expect(text).not.toContain('Kiritimati')
      expect(text).not.toContain('Ruritania')
      expect(text).not.toContain('XX99FAKEADC01')
    })
  })

  describe('the event query string, which mixes protocol and account data', () => {
    it('keeps the parameters the mappers are built against', () => {
      const text = scrubbedText({ QstringForExtraData: 'openClosedStatusWord=closed&state=1' })

      expect(text).toContain('openClosedStatusWord=closed')
    })

    it('drops the account email it carries URL-encoded, evading a plain match', () => {
      const text = scrubbedText({
        QstringForExtraData: 'accountEmail=real.person%40example.org&originIp=203.0.113.9',
      })

      expect(text).not.toContain('real.person')
      expect(text).not.toContain('203.0.113.9')
    })
  })

  /**
   * Regression. The watch script records a change as `{ key, from, to }`, so
   * the value sits under `from` while the attribute it belongs to is named in
   * a sibling. Judging the value against the literal name `from` decides
   * nothing, and a real device name reached scrubbed output that way.
   */
  describe('a recorded before/after change', () => {
    it('judges the values against the attribute they describe', () => {
      const text = scrubbedText({
        changes: [{ key: 'description', from: 'Master Bedroom Window', to: 'Front Door' }],
      })

      expect(text).not.toContain('Master Bedroom')
      expect(text).not.toContain('Front Door')
    })

    it('pseudonymizes an identifier that changed', () => {
      const text = scrubbedText({ changes: [{ key: 'id', from: '1234567-1', to: '1234567-2' }] })

      expect(text).not.toContain('1234567')
    })

    it('leaves an ordinary state change readable, which is the point of the capture', () => {
      const text = scrubbedText({ changes: [{ key: 'state', from: 1, to: 2 }] })

      expect(text).toContain('"from":1')
      expect(text).toContain('"to":2')
    })

    it('does not mistake an unrelated three-key object for a change record', () => {
      const scrubbed = createScrubber().scrub({ key: 'a', from: 'b', to: 'c', extra: 'd' }) as
        unknown as Record<string, string>

      expect(scrubbed).toEqual({ key: 'a', from: 'b', to: 'c', extra: 'd' })
    })
  })

  /**
   * Alarm.com error bodies quote back what was asked for, inside prose. The
   * document scrubber judges whole values, so an identifier in the middle of a
   * sentence is invisible to it. These strings reach both the terminal and,
   * through the run summary, a committed file.
   */
  describe('free text, such as an API error message', () => {
    it.each([
      ['a prefixed identifier', 'System PROD-9000999 not found', '9000999'],
      ['a device identifier', 'No device 1234567-42 on that panel', '1234567'],
      ['an email address', 'Notify real.person@example.org of the alarm', 'real.person'],
      ['a percent-encoded email', 'accountEmail=real.person%40example.org', 'real.person'],
      ['a phone number', 'Sent an SMS to +1 (555) 010-9999', '0109999'],
      ['a bare phone number', 'Sent an SMS to 5550109999', '5550109999'],
    ])('redacts %s in the middle of a sentence', (_label, text, secret) => {
      expect(redactFreeText(text)).not.toContain(secret)
    })

    it.each([
      'Sensor state 2 is invalid',
      'firmware 1.2.3 is unsupported',
      'Request failed at 2026-07-29T02:05:00.000Z',
    ])('leaves diagnostic detail readable: %s', (text) => {
      expect(redactFreeText(text)).toBe(text)
    })

    it('passes a non-string through untouched', () => {
      expect(redactFreeText(null as unknown as string)).toBeNull()
    })
  })

  it('leaves the fields the mappers are actually built against alone', () => {
    const scrubbed = createScrubber().scrub({
      deviceType: 1,
      state: 2,
      openClosedStatus: 3,
      isMalfunctioning: false,
      lowBattery: true,
    })

    expect(scrubbed).toEqual({
      deviceType: 1,
      state: 2,
      openClosedStatus: 3,
      isMalfunctioning: false,
      lowBattery: true,
    })
  })
})
