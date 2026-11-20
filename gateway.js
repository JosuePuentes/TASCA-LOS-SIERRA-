import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import tasca from './server.js';
import licoreria, { hosts } from './licoreria-ad/server.js';

const gate = express();
gate.set('trust proxy', true);
gate.use((req, res, next) => {
  const host = String(req.hostname || '').toLowerCase();
  if (hosts.has(host)) return licoreria(req, res, next);
  return tasca(req, res, next);
});

export default gate;

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const server = gate.listen(port, () => {
    const licoreriaHost = [...hosts][0] || 'licoreria.localhost';
    console.log('');
    console.log('  Tasca Los Sierra');
    console.log(`  Abre http://localhost:${port}/`);
    console.log('');
    console.log('  Licorería A&D');
    console.log(`  Abre http://${licoreriaHost}:${port}/`);
    console.log('');
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`El puerto ${port} ya está en uso. Cierra el otro programa o inicia con otro puerto.`);
      process.exit(1);
    }
    console.error(error);
    process.exit(1);
  });
}
