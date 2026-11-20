let appPromise;

function loadApp() {
  if (!appPromise) appPromise = import('../gateway.js').then((mod) => mod.default);
  return appPromise;
}

export default async function handler(req, res) {
  try {
    const app = await loadApp();
    return app(req, res);
  } catch (error) {
    appPromise = null;
    console.error(error);
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(`No se pudo iniciar.\n${error.message}`);
  }
}
