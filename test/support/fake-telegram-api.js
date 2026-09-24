/**
 * A local stand-in for the Telegram Bot API.
 *
 * Telegraf talks to `${apiRoot}/bot<token>/<method>`, so pointing `apiRoot` at
 * this server means tests drive the *real* Telegraf and the real HTTP client,
 * and we simply record what the bot tried to send.
 */

import http from 'http'

export async function startFakeTelegramApi({ failMarkdown = false } = {}) {
  const calls = []
  let nextMessageId = 5000

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)

    let body = {}
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    } catch {
      body = {}
    }

    const method = String(req.url || '').split('/').pop()

    if (method === 'getMe') {
      return reply(res, {
        ok: true,
        result: {
          id: 8616670303,
          is_bot: true,
          first_name: 'Corner',
          username: 'corner_rest_bot'
        }
      })
    }

    const call = { method, payload: body }
    if (method === 'sendMessage') {
      call.messageId = ++nextMessageId
    }
    calls.push(call)

    // Simulate Telegram's fragile Markdown parser rejecting bad entities.
    if (failMarkdown && body.parse_mode && /[*_`\[]/.test(String(body.text || ''))) {
      call.failed = true
      return reply(res, {
        ok: false,
        error_code: 400,
        description: "Bad Request: can't parse entities"
      })
    }

    const result =
      method === 'sendMessage'
        ? { message_id: call.messageId, date: 0, chat: { id: body.chat_id, type: 'private' }, text: body.text }
        : method === 'editMessageText'
          ? { message_id: body.message_id, date: 0, chat: { id: body.chat_id, type: 'private' }, text: body.text }
          : true

    return reply(res, { ok: true, result })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    apiRoot: `http://127.0.0.1:${port}`,
    calls,
    take() {
      const taken = [...calls]
      calls.length = 0
      return taken
    },
    messages() {
      return calls.filter((c) => c.method === 'sendMessage')
    },
    edits() {
      return calls.filter((c) => c.method === 'editMessageText')
    },
    lastPayload(method) {
      return [...calls].reverse().find((c) => c.method === method)?.payload || null
    },
    close() {
      return new Promise((resolve) => server.close(resolve))
    }
  }
}

function reply(res, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(body)
}
