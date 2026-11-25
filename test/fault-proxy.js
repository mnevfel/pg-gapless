import net from 'node:net'

// A TCP proxy between the driver and PostgreSQL that cuts the connection at
// the next COMMIT, so the tests can see what happens when the network fails
// at the worst moment. It reads just enough of the wire protocol to find a
// simple-query message whose text is COMMIT; everything else passes through.
//
//   'before'  COMMIT never reaches the server: the transaction is rolled back.
//   'after'   the server commits, but its answer never reaches the driver.
//
// It speaks plain TCP only, so keep sslmode out of the test DATABASE_URL.
export async function startFaultProxy(databaseUrl) {
  const target = new URL(databaseUrl)
  const sockets = new Set()
  let pending = null
  let cuts = 0

  const server = net.createServer((client) => {
    const upstream = net.connect({ host: target.hostname, port: Number(target.port) || 5432 })
    const pair = [client, upstream]
    for (const s of pair) sockets.add(s)
    const close = () => pair.forEach((s) => s.destroy())
    client.on('error', close)
    upstream.on('error', close)
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())

    let swallow = false
    upstream.on('data', (chunk) => {
      // The first bytes after our forwarded COMMIT are the server's answer to it.
      if (swallow) return close()
      client.write(chunk)
    })

    let buffer = Buffer.alloc(0)
    let started = false
    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        // The startup message has no type byte; every later message has one.
        const head = started ? 1 : 0
        if (buffer.length < head + 4) return
        const size = head + buffer.readUInt32BE(head)
        if (buffer.length < size) return
        const message = buffer.subarray(0, size)
        buffer = buffer.subarray(size)
        if (!started) {
          if (message.readUInt32BE(4) === 80877103) return close() // SSLRequest
          started = true
        }
        const isCommit = head === 1 && message[0] === 0x51 && message.toString('utf8', 5, size - 1) === 'COMMIT'
        if (isCommit && pending) {
          const mode = pending
          pending = null
          cuts++
          if (mode === 'before') return close()
          swallow = true
        }
        upstream.write(message)
      }
    })
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))

  const url = new URL(databaseUrl)
  url.hostname = '127.0.0.1'
  url.port = String(server.address().port)
  return {
    url: url.href,
    // Cuts the connection at the next COMMIT that passes through.
    cutNextCommit(mode) {
      if (mode !== 'before' && mode !== 'after') throw new RangeError('mode is before or after')
      pending = mode
    },
    get cuts() {
      return cuts
    },
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
