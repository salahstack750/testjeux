// Godzilla Notifier Backend - DIAGNOSTIC v5.1
// Logue la structure des serveurs Roblox au demarrage pour voir les champs disponibles

const express = require('express');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'SALAH2026';

const POOL_CONFIG = {
    rebirth0: { placeId: 96342491571673, label: 'Rebirth 0' },
    rebirth1plus: { placeId: 109983668079237, label: 'Rebirth 1+' }
};

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 7;
const SCAN_INTERVAL = 15000;
const MAX_PAGES = 30;
const JOBID_LOCK_TTL = 90 * 1000;
const BOT_HISTORY_TTL = 6 * 60 * 60 * 1000;
const BRAINROT_TTL = 30 * 1000;
const MIN_BRAINROT_VALUE = 1000000;
const MAX_LOGS = 200;

const PROXIES = [
    'https://roblox-proxy.salahelarabi03.workers.dev',
    'https://games.roproxy.com',
    'https://games.roblox.com'
];

const pools = {
    rebirth0: [],
    rebirth1plus: []
};

const jobLocks = new Map();
const botHistory = new Map();
const reports = new Map();
const recentBrainrots = [];
const liveLogs = [];

const stats = {
    totalScans: 0,
    jobsServed: 0,
    reportsReceived: 0,
    logsReceived: 0,
    startedAt: Date.now()
};

const diagnosticFlags = {
    workerProxy: false,
    roproxy: false,
    rblxDirect: false
};

function checkAuth(req, res) {
    const key = req.query.key || req.headers['x-api-key'];
    if (key !== API_KEY) {
        res.status(401).json({ error: 'Invalid API key' });
        return false;
    }
    return true;
}

function cleanupExpired() {
    const now = Date.now();
    
    for (const [jobId, lock] of jobLocks.entries()) {
        if (lock.expiresAt < now) jobLocks.delete(jobId);
    }
    
    for (const [botName, hist] of botHistory.entries()) {
        if (now - hist.lastSeen > BOT_HISTORY_TTL) botHistory.delete(botName);
    }
    
    for (let i = recentBrainrots.length - 1; i >= 0; i--) {
        if (recentBrainrots[i].expiresAt < now) {
            recentBrainrots.splice(i, 1);
        }
    }
}

setInterval(cleanupExpired, 5000);

// ============================================================
// FETCH SERVERS - avec diagnostic au premier appel
// ============================================================
async function fetchServers(placeId, cursor) {
    const path = '/v1/games/' + placeId + '/servers/Public?limit=100&excludeFullGames=true' + (cursor ? '&cursor=' + cursor : '');
    
    for (const proxy of PROXIES) {
        const url = proxy + path;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json'
                }
            });
            clearTimeout(timeout);
            
            if (response.ok) {
                const data = await response.json();
                
                // DIAGNOSTIC : log la structure du premier serveur recu
                if (data && data.data && data.data.length > 0) {
                    let proxyName = 'unknown';
                    if (proxy.includes('workers.dev')) proxyName = 'workerProxy';
                    else if (proxy.includes('roproxy')) proxyName = 'roproxy';
                    else if (proxy.includes('roblox.com')) proxyName = 'rblxDirect';
                    
                    if (!diagnosticFlags[proxyName]) {
                        diagnosticFlags[proxyName] = true;
                        
                        console.log('================================================');
                        console.log('[DIAGNOSTIC] PROXY UTILISE : ' + proxy);
                        console.log('[DIAGNOSTIC] PLACE ID : ' + placeId);
                        console.log('[DIAGNOSTIC] TOTAL SERVEURS RECUS : ' + data.data.length);
                        console.log('================================================');
                        console.log('[DIAGNOSTIC] CHAMPS DISPONIBLES (cles du premier serveur):');
                        console.log(Object.keys(data.data[0]).join(', '));
                        console.log('================================================');
                        console.log('[DIAGNOSTIC] EXEMPLE 1 - Premier serveur complet:');
                        console.log(JSON.stringify(data.data[0], null, 2));
                        console.log('================================================');
                        
                        if (data.data.length >= 2) {
                            console.log('[DIAGNOSTIC] EXEMPLE 2 - Deuxieme serveur:');
                            console.log(JSON.stringify(data.data[1], null, 2));
                            console.log('================================================');
                        }
                        if (data.data.length >= 3) {
                            console.log('[DIAGNOSTIC] EXEMPLE 3 - Troisieme serveur:');
                            console.log(JSON.stringify(data.data[2], null, 2));
                            console.log('================================================');
                        }
                        
                        const firstServer = data.data[0];
                        console.log('[DIAGNOSTIC] VERIFICATION CHAMPS CLES :');
                        console.log('  -> fps : ' + (firstServer.fps !== undefined ? 'PRESENT (' + firstServer.fps + ')' : 'ABSENT'));
                        console.log('  -> ping : ' + (firstServer.ping !== undefined ? 'PRESENT (' + firstServer.ping + ')' : 'ABSENT'));
                        console.log('  -> playing : ' + (firstServer.playing !== undefined ? 'PRESENT (' + firstServer.playing + ')' : 'ABSENT'));
                        console.log('  -> maxPlayers : ' + (firstServer.maxPlayers !== undefined ? 'PRESENT (' + firstServer.maxPlayers + ')' : 'ABSENT'));
                        console.log('  -> id : ' + (firstServer.id !== undefined ? 'PRESENT' : 'ABSENT'));
                        console.log('  -> playerTokens : ' + (firstServer.playerTokens !== undefined ? 'PRESENT (taille: ' + firstServer.playerTokens.length + ')' : 'ABSENT'));
                        console.log('================================================');
                    }
                }
                
                if (data && data.data) return data;
            }
        } catch (error) {
            // Try next proxy
        }
    }
    
    console.error('[SCAN] All proxies failed for ' + placeId);
    return null;
}

async function scanPool(poolKey) {
    const config = POOL_CONFIG[poolKey];
    if (!config) return;
    
    const newPool = [];
    let cursor = '';
    
    for (let page = 0; page < MAX_PAGES; page++) {
        const data = await fetchServers(config.placeId, cursor);
        if (!data || !data.data) break;
        
        for (const server of data.data) {
            if (server.playing >= MIN_PLAYERS && server.playing <= MAX_PLAYERS) {
                newPool.push({
                    jobId: server.id,
                    players: server.playing,
                    maxPlayers: server.maxPlayers,
                    fps: server.fps,
                    ping: server.ping
                });
            }
        }
        
        if (!data.nextPageCursor) break;
        cursor = data.nextPageCursor;
        await new Promise(r => setTimeout(r, 200));
    }
    
    pools[poolKey] = newPool;
    stats.totalScans++;
    console.log('[SCAN] ' + config.label + ': ' + newPool.length + ' serveurs');
}

async function scanLoop() {
    while (true) {
        try {
            await Promise.all([
                scanPool('rebirth0'),
                scanPool('rebirth1plus')
            ]);
        } catch (e) {
            console.error('[SCAN] Erreur:', e.message);
        }
        await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/', (req, res) => {
    res.json({
        name: 'Godzilla Notifier Backend',
        version: '5.1 DIAGNOSTIC',
        diagnosticStatus: diagnosticFlags,
        config: {
            players: MIN_PLAYERS + '-' + MAX_PLAYERS,
            maxPages: MAX_PAGES,
            brainrotTTL: BRAINROT_TTL / 1000 + 's',
            minBrainrotValue: (MIN_BRAINROT_VALUE / 1000000) + 'M'
        },
        endpoints: ['/health', '/jobs', '/report-data', '/log', '/stats', '/bots', '/dashboard', '/api/brainrots', '/diagnostic']
    });
});

app.get('/diagnostic', (req, res) => {
    res.json({
        status: 'Diagnostic actif',
        instructions: 'Va voir Railway puis View Logs et cherche [DIAGNOSTIC]',
        proxiesAlreadyDiagnosed: diagnosticFlags
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
        pools: {
            rebirth0: pools.rebirth0.length,
            rebirth1plus: pools.rebirth1plus.length
        }
    });
});

app.get('/jobs', (req, res) => {
    if (!checkAuth(req, res)) return;
    
    const placeId = parseInt(req.query.placeId);
    const username = req.headers.username || 'anonymous';
    
    let poolKey;
    if (placeId === POOL_CONFIG.rebirth0.placeId) poolKey = 'rebirth0';
    else if (placeId === POOL_CONFIG.rebirth1plus.placeId) poolKey = 'rebirth1plus';
    else return res.status(400).send('Invalid placeId');
    
    const pool = pools[poolKey];
    if (!pool || pool.length === 0) {
        return res.status(503).send('Pool empty');
    }
    
    if (!botHistory.has(username)) {
        botHistory.set(username, {
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            jobsReceived: 0,
            currentJobId: null,
            visitedJobs: new Set()
        });
    }
    
    const botData = botHistory.get(username);
    botData.lastSeen = Date.now();
    botData.jobsReceived++;
    
    const now = Date.now();
    const candidates = pool.filter(s => {
        const lock = jobLocks.get(s.jobId);
        if (lock && lock.expiresAt > now && lock.botName !== username) return false;
        if (botData.visitedJobs.has(s.jobId)) return false;
        return true;
    });
    
    if (candidates.length === 0) {
        botData.visitedJobs = new Set();
        return res.status(503).send('All visited');
    }
    
    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    
    const poolArray = pools[poolKey];
    const poolIndex = poolArray.findIndex(s => s.jobId === selected.jobId);
    if (poolIndex !== -1) {
        poolArray.splice(poolIndex, 1);
        console.log('[JOBS] JobID retire du pool. Reste:', poolArray.length);
    }
    
    jobLocks.set(selected.jobId, {
        botName: username,
        expiresAt: now + JOBID_LOCK_TTL
    });
    
    botData.currentJobId = selected.jobId;
    botData.visitedJobs.add(selected.jobId);
    stats.jobsServed++;
    
    res.send(selected.jobId);
});

app.post('/report-data', (req, res) => {
    if (!checkAuth(req, res)) return;
    
    const body = req.body || {};
    const botName = body.botName;
    const jobId = body.jobId;
    const name = body.name;
    const money = body.money;
    const numeric = body.numeric || 0;
    const mutation = body.mutation;
    const brainrots = body.brainrots;
    const source = body.source;
    const players = body.players;
    
    if (!botName || !jobId) {
        return res.status(400).json({ error: 'Missing botName or jobId' });
    }
    
    stats.reportsReceived++;
    
    const report = {
        botName: botName,
        jobId: jobId,
        name: name,
        money: money,
        numeric: numeric,
        mutation: mutation,
        brainrots: brainrots,
        source: source,
        players: players,
        timestamp: Date.now()
    };
    
    reports.set(botName + ':' + jobId, report);
    
    if (Array.isArray(brainrots) && brainrots.length > 0) {
        const now = Date.now();
        
        for (const item of brainrots) {
            if (item.numeric >= MIN_BRAINROT_VALUE && item.name) {
                
                const isDuplicate = recentBrainrots.some(existing => 
                    existing.name === item.name && 
                    existing.numeric === item.numeric &&
                    existing.jobId === jobId &&
                    existing.expiresAt > now
                );
                
                if (!isDuplicate) {
                    recentBrainrots.unshift({
                        botName: botName,
                        jobId: jobId,
                        name: item.name,
                        money: item.money,
                        numeric: item.numeric,
                        mutation: item.mutation || null,
                        source: item.source || 'unknown',
                        players: players || 0,
                        receivedAt: now,
                        expiresAt: now + BRAINROT_TTL
                    });
                }
            }
        }
    }
    
    res.json({ success: true });
});

app.post('/log', (req, res) => {
    if (!checkAuth(req, res)) return;
    
    const body = req.body || {};
    const botName = body.botName || 'unknown';
    const message = body.message || '';
    
    if (!message) {
        return res.status(400).json({ error: 'Missing message' });
    }
    
    stats.logsReceived++;
    
    liveLogs.unshift({
        botName: botName,
        message: message,
        timestamp: Date.now()
    });
    
    if (liveLogs.length > MAX_LOGS) liveLogs.length = MAX_LOGS;
    
    res.json({ success: true });
});

app.get('/stats', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startedAt) / 1000);
    
    res.json({
        uptime: uptime,
        totalScans: stats.totalScans,
        jobsServed: stats.jobsServed,
        reportsReceived: stats.reportsReceived,
        logsReceived: stats.logsReceived,
        activeBots: botHistory.size,
        activeJobs: jobLocks.size,
        recentBrainrots: recentBrainrots.length,
        diagnosticFlags: diagnosticFlags,
        pools: {
            rebirth0: pools.rebirth0.length,
            rebirth1plus: pools.rebirth1plus.length
        }
    });
});

app.get('/bots', (req, res) => {
    const bots = [];
    const now = Date.now();
    
    for (const [name, data] of botHistory.entries()) {
        const secondsSinceLastSeen = Math.floor((now - data.lastSeen) / 1000);
        bots.push({
            name: name,
            firstSeen: new Date(data.firstSeen).toISOString(),
            lastSeen: new Date(data.lastSeen).toISOString(),
            secondsSinceLastSeen: secondsSinceLastSeen,
            jobsReceived: data.jobsReceived,
            currentJobId: data.currentJobId,
            visitedJobsCount: data.visitedJobs.size
        });
    }
    
    bots.sort((a, b) => a.secondsSinceLastSeen - b.secondsSinceLastSeen);
    
    res.json(bots);
});

app.get('/pool', (req, res) => {
    const placeId = parseInt(req.query.placeId);
    
    let poolKey;
    if (placeId === POOL_CONFIG.rebirth0.placeId) poolKey = 'rebirth0';
    else if (placeId === POOL_CONFIG.rebirth1plus.placeId) poolKey = 'rebirth1plus';
    else {
        return res.json({
            rebirth0: {
                placeId: POOL_CONFIG.rebirth0.placeId,
                count: pools.rebirth0.length
            },
            rebirth1plus: {
                placeId: POOL_CONFIG.rebirth1plus.placeId,
                count: pools.rebirth1plus.length
            }
        });
    }
    
    const pool = pools[poolKey] || [];
    res.json({
        placeId: POOL_CONFIG[poolKey].placeId,
        count: pool.length,
        servers: pool
    });
});

app.get('/api/brainrots', (req, res) => {
    const now = Date.now();
    const active = [];
    
    for (const b of recentBrainrots) {
        if (b.expiresAt > now) {
            active.push({
                botName: b.botName,
                jobId: b.jobId,
                name: b.name,
                money: b.money,
                numeric: b.numeric,
                mutation: b.mutation,
                source: b.source || 'unknown',
                players: b.players || 0,
                remainingSeconds: Math.ceil((b.expiresAt - now) / 1000)
            });
        }
    }
    
    res.json(active);
});

app.get('/dashboard', (req, res) => {
    res.send('Version DIAGNOSTIC active. Va sur Railway puis View Logs et cherche [DIAGNOSTIC]');
});

app.listen(PORT, () => {
    console.log('================================================');
    console.log('Godzilla Notifier Backend v5.1 DIAGNOSTIC');
    console.log('================================================');
    console.log('Port: ' + PORT);
    console.log('MODE DIAGNOSTIC ACTIF');
    console.log('La prochaine requete API Roblox va logger sa structure.');
    console.log('Va voir les logs Railway dans 30s.');
    console.log('================================================');
    
    scanLoop();
});
