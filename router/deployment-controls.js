
function injectDeploymentControl(html, node) {
  if (!['electric-sky', 'indoor-sky'].includes(node) || html.includes('id="wb-deployment"')) return html;
  const control = `<section id="wb-deployment" data-node="${node}"></section>`;
  const withControl = /<\/header>/i.test(html) ? html.replace(/<\/header>/i, `</header>${control}`) :
    html.replace(/<body[^>]*>/i, match => match + control);
  return withControl.replace(/<\/head>/i, '<link rel="stylesheet" href="/deployment-control.css"></head>')
    .replace(/<\/body>/i, '<script src="/deployment-control.js" defer></script></body>');
}

function installDeploymentProxy(app, requireAdmin, env = process.env, transport = fetch) {
  async function proxy(req, res) {
    res.set('Cache-Control', 'no-store');
    const node = req.params.node;
    const action = req.params.action;
    if (!['electric-sky', 'indoor-sky'].includes(node) ||
        (action && !['start', 'change', 'end'].includes(action))) {
      return res.status(404).json({ detail: 'Unknown deployment operation' });
    }
    const expected = env.WEATHER_BRAIN_STATUS_TOKEN;
    if (!expected || !env.WEATHER_BRAIN_URL || (action && !env.WEATHER_BRAIN_INGEST_TOKEN)) {
      return res.status(503).json({ detail: 'Deployment management is not configured' });
    }
    // The proxy never enables cross-origin browser access or stores deployment state.
    if (req.get('Origin')) {
      try {
        if (new URL(req.get('Origin')).host !== req.get('Host')) throw new Error();
      } catch { return res.status(403).json({ detail: 'Same-origin request required' }); }
    }
    try {
      const base = new URL(env.WEATHER_BRAIN_URL);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        throw new Error('Invalid configuration');
      }
      const url = new URL(`${base.href.replace(/\/$/, '')}/nodes/${node}/deployment${action ? '/' + action : ''}`);
      const upstream = await transport(url, {
        method: action ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: action ? { 'Content-Type': 'application/json', 'X-Ingest-Token': env.WEATHER_BRAIN_INGEST_TOKEN } :
          { 'X-Status-Token': expected },
        ...(action && { body: JSON.stringify(req.body) })
      });
      const data = await upstream.json();
      // Never relay arbitrary upstream error bodies (which may echo request headers).
      if (!upstream.ok) return res.status(upstream.status).json({ detail:
        upstream.status === 409 ? 'Deployment changed; refresh before retrying' : 'Weather Brain rejected the deployment request' });
      const serialized = JSON.stringify(data);
      if ([env.WEATHER_BRAIN_STATUS_TOKEN, env.WEATHER_BRAIN_INGEST_TOKEN].some(secret => secret && serialized.includes(JSON.stringify(secret).slice(1, -1)))) {
        throw new Error('Credential in upstream response');
      }
      res.status(upstream.status).json(data);
    } catch { res.status(502).json({ detail: 'Weather Brain deployment API unavailable' }); }
  }
  app.get('/api/deployments/:node', proxy);
  app.post('/api/deployments/:node/:action', requireAdmin, proxy);
}

module.exports = { injectDeploymentControl, installDeploymentProxy };
