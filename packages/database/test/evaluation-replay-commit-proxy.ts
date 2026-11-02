import { connect, createServer, type Socket } from 'node:net';

/** Test-only local PostgreSQL wire relay. Drops an acknowledged server COMMIT before client delivery. */
export async function commitLossProxy(target: string) {
  const url = new URL(target);
  if (url.hostname !== '127.0.0.1' || !url.port || url.search || url.hash)
    throw new Error('Commit fault proxy requires an owned loopback database.');
  const targetPort = Number(url.port);
  const sockets = new Set<Socket>();
  let armed = false,
    observed = false,
    failed = false;
  const server = createServer((downstream) => {
    const upstream = connect({ host: '127.0.0.1', port: targetPort });
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => {
        downstream.destroy();
        upstream.destroy();
      });
    }
    let initial = true,
      front = Buffer.alloc(0),
      back = Buffer.alloc(0),
      dropping = false;
    downstream.on('close', () => upstream.destroy());
    upstream.on('close', () => downstream.destroy());
    downstream.on('data', (chunk: Buffer) => {
      front = Buffer.concat([front, chunk]);
      if (front.length > 262144) {
        failed = true;
        downstream.destroy();
        upstream.destroy();
        return;
      }
      while (front.length >= (initial ? 4 : 5)) {
        const length = initial ? front.readInt32BE(0) : front.readInt32BE(1) + 1;
        if (length < 4 || length > 262144) {
          failed = true;
          downstream.destroy();
          upstream.destroy();
          return;
        }
        if (front.length < length) return;
        const frame = front.subarray(0, length);
        front = front.subarray(length);
        if (
          !initial &&
          armed &&
          frame[0] === 81 &&
          frame.subarray(5).equals(Buffer.from('COMMIT\0'))
        ) {
          dropping = true;
          armed = false;
        }
        initial = false;
        upstream.write(frame);
      }
    });
    upstream.on('data', (chunk: Buffer) => {
      if (!dropping) {
        downstream.write(chunk);
        return;
      }
      back = Buffer.concat([back, chunk]);
      if (back.length > 262144) {
        failed = true;
        downstream.destroy();
        upstream.destroy();
        return;
      }
      while (back.length >= 5) {
        const length = back.readInt32BE(1) + 1;
        if (length < 5 || length > 262144) {
          failed = true;
          downstream.destroy();
          upstream.destroy();
          return;
        }
        if (back.length < length) return;
        const frame = back.subarray(0, length);
        back = back.subarray(length);
        if (frame[0] === 67) {
          observed = frame.subarray(5).equals(Buffer.from('COMMIT\0'));
          if (!observed) failed = true;
          downstream.destroy();
          upstream.destroy();
          return;
        }
        if (frame[0] === 69) {
          failed = true;
          downstream.destroy();
          upstream.destroy();
          return;
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fault-proxy endpoint.');
  url.port = String(address.port);
  return {
    connectionString: url.href,
    arm() {
      armed = true;
    },
    get committed() {
      return observed && !failed;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve, reject) =>
            server.close((error) =>
              error ? reject(new Error('Owned fault proxy cleanup failed.')) : resolve(),
            ),
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Owned fault proxy cleanup deadline.')),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
