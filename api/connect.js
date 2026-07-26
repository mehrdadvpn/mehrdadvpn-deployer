// api/connect.js — Verify tokens + Fork + Check GitHub App

const SOURCE_REPO = 'mehrdadvpn/3x-ui-new';
const GITHUB_API = 'https://api.github.com';
const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const { action, githubToken, railwayToken } = req.body || {};

    try {
        if (action === 'verify_github') {
            if (!githubToken) return res.status(400).json({ error: 'Token required' });
            const user = await ghFetch('/user', githubToken);
            return res.json({ status: 'ok', user: user.login });
        }

        if (action === 'fork_and_connect') {
            if (!githubToken) return res.status(400).json({ error: 'Token required' });
            const user = await ghFetch('/user', githubToken);
            const username = user.login;
            try {
                await ghFetch(`/repos/${username}/3x-ui-Upgrade`, githubToken);
            } catch (e) {
                await ghFetch(`/repos/${SOURCE_REPO}/forks`, githubToken, 'POST', { name: '3x-ui-Upgrade', default_branch_only: true });
            }
            await sleep(3000);
            return res.json({ status: 'ok', forkName: `${username}/3x-ui-Upgrade`, username });
        }

        if (action === 'verify_railway') {
            if (!railwayToken) return res.status(400).json({ error: 'Token required' });
            const me = await rq(`query { me { id email } }`, railwayToken);
            return res.json({ status: 'ok', email: me.data.me.email });
        }

        if (action === 'check_github_app') {
            if (!railwayToken) return res.status(400).json({ error: 'Token required' });
            try {
                const repos = await rq(`query { githubRepos { id fullName } }`, railwayToken);
                const installed = repos.data?.githubRepos?.length > 0;
                return res.json({ status: 'ok', installed, installUrl: 'https://github.com/apps/railway-app/installations/new' });
            } catch (e) {
                return res.json({ status: 'ok', installed: false, installUrl: 'https://github.com/apps/railway-app/installations/new' });
            }
        }

        return res.status(400).json({ error: 'Unknown action' });
    } catch (err) {
        return res.status(200).json({ status: 'error', error: err.message });
    }
};

async function ghFetch(path, token, method = 'GET', body = null) {
    const opts = { method, headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(`${GITHUB_API}${path}`, opts);
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
    return r.json();
}

async function rq(query, token, variables = {}) {
    const r = await fetch(RAILWAY_GQL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ query, variables }) });
    const data = await r.json();
    if (data.errors) throw new Error(`Railway: ${data.errors[0].message}`);
    return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
