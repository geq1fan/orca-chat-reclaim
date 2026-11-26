import { assert, test } from 'orca/testing'
import { buildTitleMap, type ChatTitleOps } from './botChats'

function ops(overrides: Partial<ChatTitleOps> = {}): ChatTitleOps {
  return {
    bots: async () => ['小小', '上线助手'],
    chats: async (bot) =>
      bot === '小小'
        ? [{ id: 'orca-1', title: 'Took over 错题本三期' }]
        : [{ id: 'orca-2', title: '上线单 13703928' }],
    sessionPairs: async () => [{ sessionId: 'orca-1', nativeId: 'native-1' }],
    ...overrides
  }
}

test('titles answer for both the Orca id and the provider id', async () => {
  const titles = await buildTitleMap(ops())

  assert.equal(titles['orca-1'], 'Took over 错题本三期')
  assert.equal(titles['native-1'], 'Took over 错题本三期')
  assert.equal(titles['orca-2'], '上线单 13703928')
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

test('an unreadable session database still answers for Orca ids', async () => {
  const titles = await buildTitleMap(
    ops({
      sessionPairs: async () => {
        throw new Error('database is locked')
      }
    })
  )

  assert.deepEqual(Object.keys(titles).sort(), ['orca-1', 'orca-2'])
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
