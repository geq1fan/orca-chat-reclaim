import { assert, test } from 'orca/testing'
import { buildTitleMap, type ChatTitleOps } from './botChats'
import { aliasTitles, chainSessionIds } from './sessionRecord'

function ops(overrides: Partial<ChatTitleOps> = {}): ChatTitleOps {
  return {
    bots: async () => ['小小', '上线助手'],
    chats: async (bot) =>
      bot === '小小'
        ? [{ id: 'orca-1', title: 'Took over 错题本三期' }]
        : [{ id: 'orca-2', title: '上线单 13703928' }],
    ...overrides
  }
}

test('the title table is keyed by Orca session id', async () => {
  const titles = await buildTitleMap(ops())

  assert.deepEqual(titles, {
    'orca-1': 'Took over 错题本三期',
    'orca-2': '上线单 13703928'
  })
})

test('a record aliases its title onto every conversation id in its chain', async () => {
  // A rewind keeps the old provider id in the chain; both must answer with the same title.
  const titles = aliasTitles(await buildTitleMap(ops()), [
    { sessionId: 'orca-1', nativeId: 'native-1', chainIds: ['native-old', 'native-1'] }
  ])

  assert.equal(titles['orca-1'], 'Took over 错题本三期')
  assert.equal(titles['native-old'], 'Took over 错题本三期')
  assert.equal(titles['native-1'], 'Took over 错题本三期')
  assert.equal(titles['orca-2'], '上线单 13703928')
})

test('a record with only an adopted native id still answers that id with its title', async () => {
  // antigravity keeps no claude-style handle chain; its row shows the native id, so the
  // adopted id alone must carry the title.
  const titles = aliasTitles(await buildTitleMap(ops()), [
    { sessionId: 'orca-1', nativeId: 'native-1', chainIds: [] }
  ])

  assert.equal(titles['native-1'], 'Took over 错题本三期')
  assert.equal(titles['orca-1'], 'Took over 错题本三期')
})

test('a title stored under the native id or chain id also answers the Orca session id', () => {
  const fromNative = aliasTitles({ 'native-1': 'Took over 错题本三期' }, [
    { sessionId: 'orca-1', nativeId: 'native-1', chainIds: [] }
  ])
  assert.equal(fromNative['orca-1'], 'Took over 错题本三期')

  const fromChain = aliasTitles({ 'chain-old': '链条历史标题' }, [
    { sessionId: 'orca-1', nativeId: 'native-1', chainIds: ['chain-old'] }
  ])
  assert.equal(fromChain['orca-1'], '链条历史标题')
  assert.equal(fromChain['native-1'], '链条历史标题')
})

test('a chain registers nativeId handles as well as sessionId ones', () => {
  const chain = JSON.stringify([
    { handle: { agent: 'antigravity', nativeId: 'native-anti' } },
    { handle: { agent: 'claude', sessionId: 'native-claude' } }
  ])

  assert.deepEqual(chainSessionIds(chain), ['native-anti', 'native-claude'])
})

test('one unreachable bot does not cost the others their titles', async () => {
  const titles = await buildTitleMap(
    ops({
      chats: async (bot) => {
        if (bot === '小小') throw new Error('no such bot')
        return [{ id: 'orca-2', title: '上线单 13703928' }]
      }
    })
  )

  assert.deepEqual(titles, { 'orca-2': '上线单 13703928' })
})

test('an unreachable bot list yields no titles instead of throwing', async () => {
  const titles = await buildTitleMap(
    ops({
      bots: async () => {
        throw new Error('orca: command not found')
      }
    })
  )

  assert.deepEqual(titles, {})
})

test('a chat without a title is skipped', async () => {
  const titles = await buildTitleMap(ops({ chats: async () => [{ id: 'orca-3', title: '' }] }))

  assert.deepEqual(titles, {})
})

test('a record without a title lends none to its chain ids', async () => {
  const titles = aliasTitles({}, [
    { sessionId: 'orca-1', nativeId: 'native-1', chainIds: ['native-1'] }
  ])

  assert.deepEqual(titles, {})
})
