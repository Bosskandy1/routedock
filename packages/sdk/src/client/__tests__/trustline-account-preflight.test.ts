import assert from 'node:assert/strict'
import test from 'node:test'
import { Horizon, Keypair } from '@stellar/stellar-sdk'
import { signManifest } from '../../manifest/sign.js'
import { RouteDockClient } from '../RouteDockClient.js'
import { RouteDockAccountNotFoundError } from '../../errors.js'
import { USDC_ISSUERS } from '../../internal/usdc.js'
import type { RouteDockManifest } from '../../types.js'

const TESTNET_USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

function usdcManifest(): RouteDockManifest {
  const payee = Keypair.random()
  return signManifest({
    routedock: '1.0',
    name: 'Account Preflight Test Provider',
    description: 'Checks the payer account preflight',
    modes: ['x402'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: TESTNET_USDC_CONTRACT,
    payee: payee.publicKey(),
    pricing: {
      x402: {
        amount: '0.001',
        per: 'request',
        facilitator: 'https://channels.openzeppelin.com/x402/testnet',
      },
    },
    endpoints: { quote: { method: 'GET', path: '/quote' } },
    tags: ['test'],
  }, payee.secret())
}

function horizonError(status: number): Error {
  return Object.assign(new Error(`Horizon responded with ${status}`), {
    response: { status },
  })
}

test('preflight throws RouteDockAccountNotFoundError when Horizon returns 404', async (t) => {
  const failure = horizonError(404)
  t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => {
    throw failure
  })

  const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })

  await assert.rejects(client.preflight(usdcManifest()), (error: unknown) => {
    assert.ok(error instanceof RouteDockAccountNotFoundError)
    assert.equal(error.code, 'ACCOUNT_NOT_FOUND')
    assert.equal(error.cause, failure)
    return true
  })
})

test('preflight continues and logs the error on a transient Horizon failure', async (t) => {
  t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => {
    throw horizonError(503)
  })
  const logged: Array<{ level: string; message: string; fields: Record<string, unknown> | undefined }> = []
  const client = new RouteDockClient({
    wallet: Keypair.random(),
    network: 'testnet',
    logger: (level, message, fields) => {
      logged.push({ level, message, fields })
    },
  })

  await client.preflight(usdcManifest())

  assert.equal(logged.length, 1)
  assert.equal(logged[0]?.level, 'warn')
  assert.ok(typeof logged[0]?.fields?.error === 'string')
})

test('pay throws RouteDockAccountNotFoundError when Horizon returns 404', async (t) => {
  const failure = horizonError(404)
  t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => {
    throw failure
  })
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(usdcManifest()), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))

  const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })

  await assert.rejects(client.pay('https://provider.example/quote'), (error: unknown) => {
    assert.ok(error instanceof RouteDockAccountNotFoundError)
    assert.equal(error.code, 'ACCOUNT_NOT_FOUND')
    assert.equal(error.cause, failure)
    return true
  })
})

test('preflight continues on a transient error whose message mentions "account"', async (t) => {
  t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => {
    throw new Error('account service temporarily unavailable')
  })
  const logged: string[] = []
  const client = new RouteDockClient({
    wallet: Keypair.random(),
    network: 'testnet',
    logger: (_level, message) => {
      logged.push(message)
    },
  })

  await client.preflight(usdcManifest())

  assert.equal(logged.length, 1)
})

test('preflight passes for an existing account that holds the USDC trustline', async (t) => {
  t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
    balances: [
      { asset_type: 'native', balance: '10.0000000' },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: USDC_ISSUERS.testnet,
        balance: '5.0000000',
      },
    ],
  }))

  const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })

  await client.preflight(usdcManifest())
})
