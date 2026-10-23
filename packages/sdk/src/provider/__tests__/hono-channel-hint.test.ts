/**
 * Hono mpp-session over real HTTP: a client with no credential names the
 * channel it wants with the `X-RouteDock-Channel` header and must get that
 * channel's challenge. Only allowlisted channels are honored. Like
 * hono-verified-voucher-e2e.test.ts, this drives requests through routedockHono
 * with a stubbed channel verifier and real mppx Challenge/Credential codecs.
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import { Credential, Challenge } from 'mppx'
import type { Method } from 'mppx'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const DEFAULT_CHANNEL = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const SECOND_CHANNEL = 'CCHANNELBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const UNLISTED_CHANNEL = 'CUNLISTEDCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
const BAD_SIGNATURE = 'bad-signature-sentinel'

let closeCalls: Array<{ channel: string; amount: bigint }> = []

mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    Store: {
      memory: () => {
        const m = new Map<string, unknown>()
        return {
          async get(k: string) { return m.get(k) },
          async put(k: string, v: unknown) { m.set(k, v) },
          async delete(k: string) { m.delete(k) },
          update(k: string, fn: (v: unknown) => unknown) { m.set(k, fn(m.get(k))) },
        }
      },
    },
    close: async (opts: { channel: string; amount: bigint }) => {
      closeCalls.push({ channel: opts.channel, amount: opts.amount })
      return 'mock-close-tx-hash'
    },
    stellar: (): Method.AnyServer =>
      ({
        name: 'stellar',
        intent: 'channel',
        verify: async ({ credential }: { credential: { payload?: { signature?: unknown } } }) => {
          if (credential?.payload?.signature === BAD_SIGNATURE) {
            throw new Error('Commitment signature verification failed.')
          }
          return { status: 'success' }
        },
      }) as unknown as Method.AnyServer,
  },
})

// Mppx.create runs once per allowlisted channel, in the order the provider
// builds them: the default channel first, then each allowlisted channel. The
// mock hands each instance the channel it was created for.
let createOrder: string[] = []
let createIndex = 0

const actualMppxServer = await import('mppx/server')
mock.module('mppx/server', {
  namedExports: {
    ...actualMppxServer,
    Mppx: {
      create: (config: { methods: Method.AnyServer[] }) => {
        const channel = createOrder[createIndex++]!
        const channelMethod = config.methods[0]!
        return {
          channel:
            () =>
            async (request: globalThis.Request) => {
              const auth = request.headers.get('authorization')
              if (!auth) return { status: 402, challenge: buildChallengeResponse(channel) }
              let credential
              try {
                credential = Credential.deserialize(auth)
              } catch {
                return { status: 402, challenge: buildChallengeResponse(channel) }
              }
              try {
                await channelMethod.verify({ credential, request: {} } as Parameters<
                  Method.AnyServer['verify']
                >[0])
                return { status: 200 }
              } catch {
                return { status: 402, challenge: buildChallengeResponse(channel) }
              }
            },
        }
      },
    },
  },
})

/** A 402 whose challenge names the channel it was issued for. */
function buildChallengeResponse(channel: string): Response {
  const challenge = Challenge.from({
    id: `challenge-${channel}`,
    realm: 'test-realm',
    method: 'stellar',
    intent: 'channel',
    request: { channel },
  })
  return new Response('Payment Required', {
    status: 402,
    headers: { 'www-authenticate': Challenge.serialize(challenge) },
  })
}

const { routedockHono } = await import('../hono.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Service',
  description: 'Channel hint test provider',
  modes: ['mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: DEFAULT_CHANNEL,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

/** Builds the provider with `SECOND_CHANNEL` allowlisted next to the default. */
function buildApp(): Hono {
  closeCalls = []
  createOrder = [DEFAULT_CHANNEL, SECOND_CHANNEL]
  createIndex = 0
  const app = new Hono()
  app.use(
    '*',
    routedockHono({
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      commitmentPublicKey: commitKeypair.publicKey(),
      manifest,
      modes: ['mpp-session'],
      pricing: {
        'mpp-session': {
          rate: '0.0001',
          channelFactory: DEFAULT_CHANNEL,
          channels: [{ channel: SECOND_CHANNEL, commitmentKey: Keypair.random().publicKey() }],
        },
      },
    }),
  )
  app.get('/price', (c) => c.json({ price: '42' }))
  return app
}

/** The channel named by a 402 response's challenge. */
function challengedChannel(res: Response): string {
  const header = res.headers.get('www-authenticate')
  assert.ok(header, 'expected a WWW-Authenticate challenge')
  const challenge = Challenge.deserialize(header)
  const channel = (challenge.request as { channel?: unknown }).channel
  assert.equal(typeof channel, 'string', 'challenge must name a channel')
  return channel as string
}

describe('routedockHono — channel hint on the first, credential-less request', () => {
  it('issues the hinted allowlisted channel challenge when no credential is sent', async () => {
    const app = buildApp()

    const res = await app.request('/price', {
      method: 'GET',
      headers: { 'X-RouteDock-Channel': SECOND_CHANNEL },
    })

    assert.equal(res.status, 402)
    assert.equal(challengedChannel(res), SECOND_CHANNEL)
  })

  it('issues the default channel challenge when no hint is sent', async () => {
    const app = buildApp()

    const res = await app.request('/price', { method: 'GET' })

    assert.equal(res.status, 402)
    assert.equal(challengedChannel(res), DEFAULT_CHANNEL)
  })

  it('issues the default channel challenge for a hint naming an unlisted channel', async () => {
    const app = buildApp()

    const res = await app.request('/price', {
      method: 'GET',
      headers: { 'X-RouteDock-Channel': UNLISTED_CHANNEL },
    })

    assert.equal(res.status, 402)
    assert.equal(challengedChannel(res), DEFAULT_CHANNEL)
  })

  it('verifies a voucher on the hinted channel and closes that channel', async () => {
    const app = buildApp()

    // 1. Credential-less request names the second channel and gets its challenge.
    const challengeRes = await app.request('/price', {
      method: 'GET',
      headers: { 'X-RouteDock-Channel': SECOND_CHANNEL },
    })
    assert.equal(challengedChannel(challengeRes), SECOND_CHANNEL)
    const challenge = Challenge.deserialize(challengeRes.headers.get('www-authenticate')!)

    // 2. Answer that challenge with a voucher and expect it to be accepted.
    const credential = Credential.from({
      challenge,
      payload: { amount: '1000', signature: 'cd'.repeat(32) },
    })
    const paidRes = await app.request('/price', {
      method: 'GET',
      headers: { authorization: Credential.serialize(credential) },
    })
    assert.equal(paidRes.status, 200)

    // 3. Close the second channel and check the close targets it.
    const closeRes = await app.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: SECOND_CHANNEL, amount: '1000', signature: 'cd'.repeat(32) }),
    })
    assert.equal(closeRes.status, 200)
    assert.equal(closeCalls.length, 1)
    assert.equal(closeCalls[0]?.channel, SECOND_CHANNEL)
    assert.equal(closeCalls[0]?.amount, 1000n)
  })
})
