/** Helpers to fabricate Telegram updates and read what the bot sent. */

let updateSeq = 1
let messageSeq = 100

export function tgUser(id = 111) {
  return { id, is_bot: false, first_name: 'Test', username: 'tester', language_code: 'ar' }
}

export function tgChat(id = 111) {
  return { id, type: 'private' }
}

export function textUpdate(text, { userId = 111 } = {}) {
  const message_id = ++messageSeq
  // Real Telegram clients attach a `bot_command` entity to messages that start
  // with "/". Telegraf 4 only routes commands when that entity is present, so
  // synthetic updates must include it.
  const entities = String(text).startsWith('/')
    ? [{ type: 'bot_command', offset: 0, length: String(text).split(' ')[0].length }]
    : undefined

  const message = { message_id, from: tgUser(userId), chat: tgChat(userId), date: 0, text }
  if (entities) message.entities = entities

  return { update_id: updateSeq++, message }
}

export function callbackUpdate(data, { userId = 111, messageId = ++messageSeq, text = 'card' } = {}) {
  return {
    update_id: updateSeq++,
    callback_query: {
      id: `cb-${updateSeq}`,
      from: tgUser(userId),
      message: { message_id: messageId, chat: tgChat(userId), date: 0, text },
      data
    }
  }
}

/** All inline buttons in a payload, as [text, callback_data] pairs. */
export function buttonsOf(payload) {
  const rows = payload?.reply_markup?.inline_keyboard || []
  return rows.flat().map((b) => [b.text, b.callback_data])
}

export function findButton(payload, predicate) {
  return buttonsOf(payload).find(([text, data]) =>
    typeof predicate === 'function' ? predicate(data, text) : String(data).startsWith(predicate)
  )
}
