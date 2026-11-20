import { DatabaseSync } from 'node:sqlite';
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

function waitFor(port, worker) {
  const started = Date.now();
  while (Date.now() - started < 70000) {
    const packet = receiveMessageOnPort(port);
    if (packet) return packet.message;
    if (worker.exitCode != null) throw new Error('No se pudo conectar con PostgreSQL.');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  throw new Error('PostgreSQL no respondió a tiempo.');
}

function openPostgres(schema = 'public') {
  const worker = new Worker(new URL('./db-worker.js', import.meta.url), {
    env: process.env,
    workerData: { schema },
  });
  worker.unref();
  const call = (op, sql, params) => {
    const { port1, port2 } = new MessageChannel();
    worker.postMessage({ op, sql, params, port: port2 }, [port2]);
    const message = waitFor(port1, worker);
    if (!message.ok) throw new Error(message.error || 'Error de base de datos.');
    return message.result;
  };
  return {
    exec(sql) {
      call('exec', sql, []);
    },
    prepare(sql) {
      return {
        get: (...params) => call('get', sql, params).rows[0],
        all: (...params) => call('all', sql, params).rows,
        run: (...params) => {
          const result = call('run', sql, params);
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
      };
    },
    close() {
      try {
        const { port1, port2 } = new MessageChannel();
        worker.postMessage({ op: 'close', port: port2 }, [port2]);
        waitFor(port1, worker);
      } catch {
        // El proceso ya está cerrando.
      }
      worker.terminate();
    },
  };
}

export function openDatabase(sqlitePath, options = {}) {
  if (process.env.DATABASE_URL) return openPostgres(options.schema || 'public');
  return new DatabaseSync(sqlitePath);
}
