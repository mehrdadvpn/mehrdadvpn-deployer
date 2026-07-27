// api/auto-setup.js — Auto-setup 3x-ui panel: login → inbound → subscription → client
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { panelUrl, panelDomain, tcpDomain, tcpPort } = req.body || {};
  if (!panelUrl || !tcpDomain || !tcpPort) {
    return res.status(400).json({ error: 'panelUrl, tcpDomain, tcpPort required' });
  }

  const base = panelUrl.replace(/\/$/, '');
  const log = [];
  const step = (msg) => { log.push(msg); };

  try {
    // ═══ Step 1: Login ═══
    step('🔐 ورود به پنل...');
    const { cookie, csrf } = await login(base);
    step('✅ ورود موفق');

    // ═══ Step 2: Generate Reality keys ═══
    step('🔑 ساخت کلیدهای Reality...');
    const keys = generateRealityKeys();
    step('✅ کلیدها ساخته شد');

    // ═══ Step 3: Create inbound ═══
    step('🌐 ساخت Inbound (VLESS + Xhttp + Reality)...');
    const inboundId = await createInbound(base, cookie, csrf, { tcpDomain, tcpPort, privateKey: keys.privateKey, shortId: keys.shortId });
    step(`✅ Inbound ساخته شد (ID: ${inboundId})`);

    // ═══ Step 4: Configure subscription ═══
    step('📋 تنظیم Subscription...');
    await configureSubscription(base, cookie, csrf, panelDomain);
    step('✅ Subscription تنظیم شد');

    // ═══ Step 5: Restart panel ═══
    step('🔄 ری‌استارت پنل...');
    await restartPanel(base, cookie, csrf);
    step('⏳ ۱۰ ثانیه صبر...');
    await sleep(10000);

    // ═══ Step 6: Create client ═══
    step('👤 ساخت Client...');
    const clientInfo = await createClient(base, cookie, csrf, inboundId);
    step('✅ Client ساخته شد');

    return res.status(200).json({
      status: 'ok',
      config: clientInfo.config,
      subscription: clientInfo.subscription,
      email: clientInfo.email,
      log
    });

  } catch (err) {
    step(`❌ خطا: ${err.message}`);
    return res.status(200).json({ status: 'error', error: err.message, log });
  }
};

// ═══════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════
async function login(base) {
  const pageRes = await fetch(`${base}/`, { redirect: 'manual' });
  const pageHtml = await pageRes.text();
  const csrfMatch = pageHtml.match(/csrf-token["\s]+content="([^"]+)"/);
  if (!csrfMatch) throw new Error('CSRF token not found');
  const csrfToken = csrfMatch[1];

  const setCookie = pageRes.headers.get('set-cookie');
  if (!setCookie) throw new Error('No session cookie');
  const sessionCookie = setCookie.split(';')[0];

  const loginRes = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie,
      'x-csrf-token': csrfToken,
      'x-requested-with': 'XMLHttpRequest'
    },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
    redirect: 'manual'
  });

  const loginData = await loginRes.json();
  if (!loginData.success) throw new Error(loginData.msg || 'Login failed');

  const loginCookie = loginRes.headers.get('set-cookie');
  let cookie = sessionCookie;
  if (loginCookie) {
    cookie = sessionCookie.split('=')[0] + '=' + loginCookie.split(';')[0].split('=').slice(1).join('=');
  }
  return { cookie, csrf: csrfToken };
}

// ═══════════════════════════════════════════
// API HELPER
// ═══════════════════════════════════════════
async function apiCall(base, path, cookie, csrf, body = null) {
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/json',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${base}${path}`, opts);
  const text = await r.text();
  try { return JSON.parse(text); } catch(e) { return { success: false, msg: 'Empty response: ' + text.substring(0, 100) }; }
}

// ═══════════════════════════════════════════
// REALITY KEY GENERATION
// ═══════════════════════════════════════════
function generateRealityKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32);
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  return {
    privateKey: privRaw.toString('base64'),
    publicKey: pubRaw.toString('base64'),
    shortId: crypto.randomBytes(4).toString('hex')
  };
}

// ═══════════════════════════════════════════
// CREATE INBOUND
// ═══════════════════════════════════════════
async function createInbound(base, cookie, csrf, { tcpDomain, tcpPort, privateKey, shortId }) {
  const hostDomain = base.replace('https://', '').replace('http://', '');

  const streamSettings = {
    network: 'xhttp',
    security: 'reality',
    realitySettings: {
      show: false,
      dest: 'www.samsung.com:443',
      serverNames: ['www.samsung.com'],
      privateKey: privateKey,
      shortIds: [shortId],
      source: '',
      xver: 0
    },
    xhttpSettings: {
      path: '/',
      mode: 'auto',
      extra: {
        header: { type: 'none' },
        download: 14,
        host: hostDomain + '/managepanel/'
      }
    }
  };

  const data = await apiCall(base, '/managepanel/api/inbounds/add', cookie, csrf, {
    up: 0, down: 0, total: 0,
    remark: '@saweg78', enable: true, expiryTime: 0,
    listen: '', port: 8080, protocol: 'vless',
    settings: { clients: [], decryption: 'none', fallbacks: [] },
    streamSettings,
    sniffing: { enabled: true, destOverride: ['http', 'tls'], routeOnly: false },
    tag: 'vless_xhttp_reality'
  });

  if (data.success === false) throw new Error(data.msg || 'Create inbound failed');

  const listData = await apiCall(base, '/managepanel/api/inbounds', cookie, csrf);
  const inbounds = listData.obj || [];
  const inbound = inbounds.find(i => i.remark === '@saweg78');
  if (!inbound) throw new Error('Inbound not found after creation');
  return inbound.id;
}

// ═══════════════════════════════════════════
// CONFIGURE SUBSCRIPTION
// ═══════════════════════════════════════════
async function configureSubscription(base, cookie, csrf, panelDomain) {
  const data = await apiCall(base, '/managepanel/api/panel/updatePanelSettings', cookie, csrf, {
    settings: {
      sub: {
        subEnable: true,
        subPath: '/sub/',
        subDomain: '',
        subUri: `https://${panelDomain}/sub/`
      }
    }
  });
  if (data.success === false) throw new Error(data.msg || 'Configure subscription failed');
}

// ═══════════════════════════════════════════
// RESTART PANEL
// ═══════════════════════════════════════════
async function restartPanel(base, cookie, csrf) {
  await apiCall(base, '/managepanel/api/restart', cookie, csrf, {});
}

// ═══════════════════════════════════════════
// CREATE CLIENT
// ═══════════════════════════════════════════
async function createClient(base, cookie, csrf, inboundId) {
  const expiryTime = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
  const uuid = crypto.randomUUID();
  const email = `user-${uuid.substring(0, 8)}`;

  const client = {
    email, enable: true, expiryTime,
    trafficLimit: 100, trafficLimitUnit: 'GB',
    uuid, subId: '', limitIp: 0,
    flow: 'xtls-rprx-vision'
  };

  const data = await apiCall(base, `/managepanel/api/inbounds/update/${inboundId}`, cookie, csrf, {
    id: inboundId,
    settings: { clients: [client] }
  });
  if (data.success === false) throw new Error(data.msg || 'Create client failed');

  const hostDomain = base.replace('https://', '').replace('http://', '');
  const configUrl = `vless://${uuid}@${hostDomain}:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.samsung.com&fp=chrome&type=xhttp&path=%2F&mode=auto#${encodeURIComponent(email)}`;
  const subscriptionUrl = `${base}/sub/${uuid}`;

  return { config: configUrl, subscription: subscriptionUrl, email };
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
