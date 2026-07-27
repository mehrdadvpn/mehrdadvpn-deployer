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

    // ═══ Step 3: Delete old inbound on port 8080 ═══
    step('🗑️ بررسی Inbound قبلی...');
    const existing = await apiGet(base, '/panel/api/inbounds/list/slim', cookie, csrf);
    const oldInbounds = (existing || []).filter(i => String(i.port) === '8080');
    for (const old of oldInbounds) {
      await apiPost(base, `/panel/api/inbounds/del/${old.id}`, cookie, csrf, '');
      step(`🗑️ Inbound قبلی "${old.remark}" (ID: ${old.id}) حذف شد`);
    }

    // ═══ Step 4: Create inbound ═══
    step('🌐 ساخت Inbound (VLESS + Xhttp + Reality)...');
    const hostDomain = base.replace('https://', '').replace('http://', '');
    const streamSettings = {
      network: 'xhttp',
      security: 'reality',
      realitySettings: {
        show: false, dest: 'www.samsung.com:443',
        serverNames: ['www.samsung.com'],
        privateKey: keys.privateKey, shortIds: [keys.shortId],
        source: '', xver: 0
      },
      xhttpSettings: {
        path: '/', mode: 'auto',
        extra: { header: { type: 'none' }, download: 14, host: hostDomain + '/managepanel/' }
      }
    };
    const addBody = new URLSearchParams({
      up: '0', down: '0', total: '0',
      remark: '@saweg78', enable: 'true', expiryTime: '0',
      listen: '', port: '8080', protocol: 'vless',
      settings: JSON.stringify({ clients: [], decryption: 'none', fallbacks: [] }),
      streamSettings: JSON.stringify(streamSettings),
      sniffing: JSON.stringify({ enabled: true, destOverride: ['http', 'tls'], routeOnly: false }),
      tag: 'vless_xhttp_reality'
    });
    const addResult = await apiPostForm(base, '/panel/api/inbounds/add', cookie, csrf, addBody.toString());
    if (!addResult || !addResult.success) throw new Error(addResult?.msg || 'Create inbound failed');
    const inboundId = addResult.obj?.id;
    step(`✅ Inbound ساخته شد (ID: ${inboundId})`);

    // ═══ Step 5: Configure subscription ═══
    step('📋 تنظیم Subscription...');
    const allSettings = await apiPostForm(base, '/panel/api/setting/all', cookie, csrf, '');
    if (allSettings?.obj) {
      const updated = allSettings.obj;
      updated.sub = updated.sub || {};
      updated.sub.subEnable = true;
      updated.sub.subPath = '/sub/';
      updated.sub.subUri = `https://${panelDomain}/sub/`;
      // Ensure required fields have valid values
      if (!updated.webPort || updated.webPort < 1) updated.webPort = 2053;
      if (!updated.sessionMaxAge || updated.sessionMaxAge < 1) updated.sessionMaxAge = 360;
      if (!updated.smtpPort) updated.smtpPort = 0;
      if (!updated.subPort) updated.subPort = 0;
      const settingsBody = new URLSearchParams({ settings: JSON.stringify(updated) });
      const updateResult = await apiPostForm(base, '/panel/api/setting/update', cookie, csrf, settingsBody.toString());
      if (!updateResult?.success) throw new Error(updateResult?.msg || 'Settings update failed');
    }
    step('✅ Subscription تنظیم شد');

    // ═══ Step 6: Restart Xray ═══
    step('🔄 ری‌استارت پنل...');
    await apiPost(base, '/panel/api/xray/restart', cookie, csrf, '');
    step('⏳ ۱۰ ثانیه صبر...');
    await sleep(10000);

    // ═══ Step 7: Create client ═══
    step('👤 ساخت Client...');
    const expiryTime = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
    const uuid = crypto.randomUUID();
    const email = `user-${uuid.substring(0, 8)}`;
    const client = {
      email, enable: true, expiryTime,
      trafficLimit: 100, trafficLimitUnit: 'GB',
      uuid, subId: '', limitIp: 0,
      flow: 'xtls-rprx-vision'
    };
    const clientBody = new URLSearchParams({
      id: String(inboundId),
      settings: JSON.stringify({ clients: [client] })
    });
    const clientResult = await apiPostForm(base, `/panel/api/inbounds/add`, cookie, csrf, clientBody.toString());
    // If that doesn't work, try the update approach - get inbound, modify, save back
    if (!clientResult?.success) {
      // Get current inbound
      const inbData = await apiGet(base, `/panel/api/inbounds/get/${inboundId}`, cookie, csrf);
      if (inbData?.obj) {
        const inb = inbData.obj;
        inb.settings = inb.settings || {};
        inb.settings.clients = inb.settings.clients || [];
        inb.settings.clients.push(client);
        const updateBody = new URLSearchParams({
          id: String(inboundId),
          remark: inb.remark, enable: String(inb.enable), port: String(inb.port),
          protocol: inb.protocol, listen: inb.listen || '',
          settings: JSON.stringify(inb.settings),
          streamSettings: JSON.stringify(inb.streamSettings),
          sniffing: JSON.stringify(inb.sniffing || {}),
          tag: inb.tag || ''
        });
        const updateResult = await apiPostForm(base, `/panel/api/inbounds/add`, cookie, csrf, updateBody.toString());
        if (!updateResult?.success) throw new Error(updateResult?.msg || 'Create client failed');
      }
    }
    step('✅ Client ساخته شد');

    const configUrl = `vless://${uuid}@${hostDomain}:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.samsung.com&fp=chrome&type=xhttp&path=%2F&mode=auto#${encodeURIComponent(email)}`;
    const subscriptionUrl = `${base}/sub/${uuid}`;

    return res.status(200).json({
      status: 'ok', config: configUrl, subscription: subscriptionUrl, email, log
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
  const setCookie = pageRes.headers.get('set-cookie');
  if (!setCookie) throw new Error('No session cookie');
  const sessionCookie = setCookie.split(';')[0];

  const csrfRes = await fetch(`${base}/csrf-token`, {
    headers: { 'Cookie': sessionCookie, 'X-Requested-With': 'XMLHttpRequest' }
  });
  const csrfData = await csrfRes.json();
  if (!csrfData.success || !csrfData.obj) throw new Error('CSRF token fetch failed');
  const csrfToken = csrfData.obj;

  const loginRes = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie,
      'X-CSRF-Token': csrfToken,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
    redirect: 'manual'
  });
  const loginData = await loginRes.json();
  if (!loginData.success) throw new Error(loginData.msg || 'Login failed');

  let cookie = sessionCookie;
  const loginSetCookie = loginRes.headers.get('set-cookie');
  if (loginSetCookie) {
    const name = sessionCookie.split('=')[0];
    const val = loginSetCookie.split(';')[0].split('=').slice(1).join('=');
    cookie = name + '=' + val;
  }

  // Refresh CSRF after login
  const csrfRes2 = await fetch(`${base}/csrf-token`, {
    headers: { 'Cookie': cookie, 'X-Requested-With': 'XMLHttpRequest' }
  });
  const csrfData2 = await csrfRes2.json();
  return { cookie, csrf: csrfData2?.obj || csrfToken };
}

// ═══════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════
async function apiGet(base, path, cookie, csrf) {
  const r = await fetch(`${base}${path}`, {
    headers: { 'Cookie': cookie, 'X-CSRF-Token': csrf, 'X-Requested-With': 'XMLHttpRequest' }
  });
  const text = await r.text();
  try { const d = JSON.parse(text); return d.obj; } catch(e) { return null; }
}

async function apiPost(base, path, cookie, csrf, body) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Cookie': cookie, 'X-CSRF-Token': csrf, 'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch(e) { return { success: false, msg: 'Empty response' }; }
}

async function apiPostForm(base, path, cookie, csrf, body) {
  return apiPost(base, path, cookie, csrf, body);
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
