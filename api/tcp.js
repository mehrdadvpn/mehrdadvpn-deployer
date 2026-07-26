// api/tcp.js — TCP Proxy: ping domain only (strip port)
const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';
const net = require('net');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { action, railwayToken, serviceId, environmentId, domainId, host } = req.body || {};
  if (!railwayToken) return res.status(400).json({ error: 'Token required' });

  try {
    if (action === 'test') {
      if (!host) return res.status(400).json({ error: 'host required' });
      // Strip port: "domain:12345" → "domain"
      const cleanHost = host.split(':')[0].trim();
      // Simple TCP ping on port 80
      try {
        await tcpPing(cleanHost, 80, 5000);
        return res.json({ status: 'ok', host: cleanHost });
      } catch (e) {
        // Try port 443
        try {
          await tcpPing(cleanHost, 443, 5000);
          return res.json({ status: 'ok', host: cleanHost });
        } catch (e2) {
          return res.json({ status: 'filtered', host: cleanHost });
        }
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(200).json({ status: 'error', error: err.message });
  }
};

function tcpPing(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, timeout);
    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}
