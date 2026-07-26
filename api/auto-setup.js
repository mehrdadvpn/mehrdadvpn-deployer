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

  const log = [];
  const step = (msg) => { log.push(msg); };

  try {
    // ═══ Step 1: Login ═══
    step('🔐 ورود به پنل...');
    const cookie = await login(panelUrl);
    step('✅ ورود موفق');

    // ═══ Step 2: Generate Reality keys ═══
    step('🔑 ساخت کلیدهای Reality...');
    const keys = generateRealityKeys();
    step('✅ کلیدها ساخته شد');

    // ═══ Step 3: Create inbound ═══
    step('🌐 ساخت Inbound (VLESS + Xhttp + Reality)...');
    const inboundId = await createInbound(panelUrl, cookie, {
      tcpDomain, tcpPort, privateKey: keys.privateKey, shortId: keys.shortId
    });
    step(`✅ Inbound ساخته شد (ID: ${inboundId})`);

    // ═══ Step 4: Configure subscription ═══
    step('📋 تنظیم Subscription...');
    await configureSubscription(panelUrl, cookie, panelDomain);
    step('✅ Subscription تنظیم شد');

    // ═══ Step 5: Restart panel ═══
    step('🔄 ری‌استارت پنل...');
    await restartPanel(panelUrl, cookie);
    step('⏳ ۱۰ ثانیه صبر...');
    await sleep(10000);

    // ═══ Step 6: Create client ═══
    step('👤 ساخت Client...');
    const clientInfo = await createClient(panelUrl, cookie, inboundId);
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
async function login(panelUrl) {
  const base = panelUrl.replace(/\/$/, '');
  const r = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=admin',
    redirect: 'manual'
  });
  const setCookie = r.headers.get('set-cookie');
  if (!setCookie) throw new Error('Login failed — no cookie');
  const session = setCookie.split(';')[0];
  // Follow redirect to get session established
  const cookie = session.split('=')[1];
  const check = await fetch(`${base}/`, {
    headers: { 'Cookie': session },
    redirect: 'manual'
  });
  return session;
}

// ═══════════════════════════════════════════
// REALITY KEY GENERATION
// ═══════════════════════════════════════════
function generateRealityKeys() {
  // Generate X25519 key pair for Reality
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');

  // Export raw keys (last 32 bytes of DER)
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32);
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);

  const privateKeyB64 = privRaw.toString('base64');
  const publicKeyB64 = pubRaw.toString('base64');
  const shortId = crypto.randomBytes(4).toString('hex');

  return { privateKey: privateKeyB64, publicKey: publicKeyB64, shortId };
}

// ═══════════════════════════════════════════
// CREATE INBOUND
// ═══════════════════════════════════════════
async function createInbound(panelUrl, cookie, { tcpDomain, tcpPort, privateKey, shortId }) {
  const base = panelUrl.replace(/\/$/, '');

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
        host: panelUrl.replace('https://', '').replace('/managepanel/', '').replace('/managepanel', '') + '/managepanel/'
      }
    }
  };

  const settings = {
    clients: [],
    decryption: 'none',
    fallbacks: []
  };

  const sniffing = {
    enabled: true,
    destOverride: ['http', 'tls'],
    routeOnly: false
  };

  const body = new URLSearchParams();
  body.append('up', '0');
  body.append('down', '0');
  body.append('total', '0');
  body.append('remark', '@saweg78');
  body.append('enable', 'true');
  body.append('expiryTime', '0');
  body.append('listen', '');
  body.append('port', '8080');
  body.append('protocol', 'vless');
  body.append('settings', JSON.stringify(settings));
  body.append('streamSettings', JSON.stringify(streamSettings));
  body.append('sniffing', JSON.stringify(sniffing));
  body.append('tag', 'vless_xhttp_reality');

  const r = await fetch(`${base}/panel/api/inbounds/add`, {
    method: 'POST',
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  const data = await r.json();
  if (data.success === false) throw new Error(data.msg || 'Create inbound failed');

  // Get the inbound ID
  const listR = await fetch(`${base}/panel/api/inbounds`, {
    headers: { 'Cookie': cookie }
  });
  const listData = await listR.json();
  const inbounds = listData.obj || [];
  const inbound = inbounds.find(i => i.remark === '@saweg78');
  if (!inbound) throw new Error('Inbound not found after creation');

  return inbound.id;
}

// ═══════════════════════════════════════════
// CONFIGURE SUBSCRIPTION
// ═══════════════════════════════════════════
async function configureSubscription(panelUrl, cookie, panelDomain) {
  const base = panelUrl.replace(/\/$/, '');

  const settings = {
    sub: {
      subEnable: true,
      subPath: '/sub/',
      subDomain: '',
      subUri: `https://${panelDomain}/sub/`
    }
  };

  const body = new URLSearchParams();
  body.append('settings', JSON.stringify(settings));

  const r = await fetch(`${base}/panel/api/panel/updatePanelSettings`, {
    method: 'POST',
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  const data = await r.json();
  if (data.success === false) throw new Error(data.msg || 'Configure subscription failed');
}

// ═══════════════════════════════════════════
// RESTART PANEL
// ═══════════════════════════════════════════
async function restartPanel(panelUrl, cookie) {
  const base = panelUrl.replace(/\/$/, '');
  await fetch(`${base}/panel/api/restart`, {
    method: 'POST',
    headers: { 'Cookie': cookie }
  });
}

// ═══════════════════════════════════════════
// CREATE CLIENT
// ═══════════════════════════════════════════
async function createClient(panelUrl, cookie, inboundId) {
  const base = panelUrl.replace(/\/$/, '');

  // 30 days from now
  const expiryTime = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
  const uuid = crypto.randomUUID();
  const email = `user-${uuid.substring(0, 8)}`;

  const client = {
    email: email,
    enable: true,
    expiryTime: expiryTime,
    trafficLimit: 100,
    trafficLimitUnit: 'GB',
    uuid: uuid,
    subId: '',
    limitIp: 0,
    flow: 'xtls-rprx-vision'
  };

  const body = new URLSearchParams();
  body.append('id', String(inboundId));
  body.append('settings', JSON.stringify({ clients: [client] }));

  const r = await fetch(`${base}/panel/api/inbounds/update/${inboundId}`, {
    method: 'POST',
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  const data = await r.json();
  if (data.success === false) throw new Error(data.msg || 'Create client failed');

  // Build config URL
  const configUrl = buildVlessConfig({
    uuid,
    address: `${base.replace('https://', '').replace('http://', '')}`,
    port: 443,
    flow: 'xtls-rprx-vision',
    remark: email
  });

  // Build subscription URL
  const subscriptionUrl = `${base}/sub/${uuid}`;

  return { config: configUrl, subscription: subscriptionUrl, email };
}

// ═══════════════════════════════════════════
// BUILD VLESS CONFIG URL
// ═══════════════════════════════════════════
function buildVlessConfig({ uuid, address, port, flow, remark }) {
  const params = new URLSearchParams({
    encryption: 'none',
    flow: flow,
    security: 'reality',
    sni: 'www.samsung.com',
    fp: 'chrome',
    pbk: '',
    sid: '',
    type: 'xhttp',
    path: '/',
    mode: 'auto'
  });
  return `vless://${uuid}@${address}:${port}?${params.toString()}#${encodeURIComponent(remark)}`;
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
