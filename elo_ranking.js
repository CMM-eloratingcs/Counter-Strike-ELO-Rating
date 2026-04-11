"use strict";

/**
 * VRS ELO Ranking — Roster-Based
 *
 * Modos:
 *   node elo_ranking.js matchdata.json elo_standings_base.json --full
 *     → Gera historico completo desde 2009 (rodar uma vez)
 *
 *   node elo_ranking.js matchdata.json elo_standings_delta.json --delta
 *     → Carrega ratings finais do base, processa só partidas novas
 *     → Resultado identico ao --full mas muito mais rapido
 */

const fs = require('fs');

const CONFIG = {
    initialRating:  1400,
    kBase:          32,
    dataWindowDays: 10000,
    coreSize:       3,
};

const WEEK  = 7  * 24 * 3600;
const MONTH = 30 * 24 * 3600;

const MODE  = process.argv[4] || '--delta';
const FULL  = MODE === '--full';
const DELTA = MODE === '--delta';

function expected(ra, rb) { return 1 / (1 + Math.pow(10, (rb - ra) / 400)); }

// ── Roster Manager ────────────────────────────────────────────────────────────

class RosterManager {
    constructor() { this.rosters = []; this.nextId = 0; }

    common(a, b) { let c = 0; for (const p of a) if (b.has(p)) c++; return c; }

    get(players, name) {
        const ps = new Set(players);
        let best = null, bestC = 0;
        for (const r of this.rosters) {
            const c = this.common(ps, r.players);
            if (c > bestC) { bestC = c; best = r; }
        }
        if (best && bestC >= CONFIG.coreSize) {
            best.players = ps; best.name = name; return best;
        }
        const r = { id: this.nextId++, players: ps, name, rating: CONFIG.initialRating, wins: 0, losses: 0, lastMatchTs: 0 };
        this.rosters.push(r);
        return r;
    }

    // Carrega estado do base — restaura rosters com ratings ja calculados
    loadFromBase(baseRanking) {
        for (const t of baseRanking) {
            const ps = new Set(t.players || []);
            const r = {
                id:          this.nextId++,
                players:     ps,
                name:        t.name,
                rating:      t.rating,
                wins:        t.wins,
                losses:      t.losses,
                lastMatchTs: t.lastMatchTs || 0,
            };
            this.rosters.push(r);
        }
        process.stdout.write(`\n📥 ${this.rosters.length} rosters carregados do base`);
    }

    snapshot() {
        const obj = {};
        for (const r of this.rosters)
            if (r.wins + r.losses > 0)
                obj[r.id] = [r.name, Math.round(r.rating * 10) / 10];
        return obj;
    }

    ranking() {
        return this.rosters
            .filter(r => r.wins + r.losses > 0)
            .map(r => ({
                name: r.name, rating: Math.round(r.rating * 10) / 10,
                wins: r.wins, losses: r.losses, matches: r.wins + r.losses,
                players: [...r.players], rosterId: r.id, lastMatchTs: r.lastMatchTs || 0,
            }))
            .sort((a, b) => b.rating - a.rating)
            .map((t, i) => ({ rank: i + 1, ...t }));
    }
}

// ── Carrega base ──────────────────────────────────────────────────────────────

function loadBase() {
    const dataFile = process.argv[2] || './matchdata.json';
    const candidates = [
        dataFile.replace(/[^/\\]*$/, 'elo_standings_base.json'),
        './elo_standings_base.json'
    ];

    for (const f of candidates) {
        try {
            if (fs.existsSync(f)) {
                const base = JSON.parse(fs.readFileSync(f, 'utf8'));
                const snaps = base.snapshots || [];
                const lastSnap = snaps[snaps.length - 1];
                const lastTs = lastSnap?.ts || 0;
                console.log(`\n📌 Base: ${f}`);
                console.log(`   Ultimo snapshot: ${new Date(lastTs*1000).toISOString().substring(0,10)}`);
                console.log(`   Rosters: ${base.rosterRanking?.length || 0}`);
                console.log(`   Orgs: ${base.orgRanking?.length || 0}`);
                return { base, lastTs };
            }
        } catch(e) {
            console.log(`   Erro ao ler ${f}: ${e.message}`);
        }
    }
    return { base: null, lastTs: 0 };
}

// ── Load matches ──────────────────────────────────────────────────────────────

function loadMatches(filename, fromTs = 0) {
    process.stdout.write(`\n📂 Lendo ${filename}...`);
    const data   = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const events = {};
    (data.events || []).forEach(e => events[e.eventId] = e);

    const now = Math.floor(Date.now() / 1000);

    let matches = data.matches || [];
    matches = matches.filter(m =>
        m.team1Players?.length === 5 && m.team2Players?.length === 5 && !m.forfeited
    );
    matches = matches.filter(m => {
        const ev = events[m.eventId];
        if (!ev) return true;
        return ev.finished !== false && !ev.eventName?.toLowerCase().includes('showmatch');
    });

    // Partidas com ts=0: trata como recentes
    matches = matches.map(m => ({
        ...m,
        matchStartTime: m.matchStartTime > 0 ? m.matchStartTime : now - 3600
    }));

    const start = fromTs > 0 ? fromTs : now - CONFIG.dataWindowDays * 86400;
    if (fromTs > 0) {
        // Modo delta: filtra só partidas novas
        const all = matches.filter(m => m.matchStartTime >= (now - CONFIG.dataWindowDays * 86400));
        const novo = all.filter(m => m.matchStartTime > fromTs);
        all.sort((a, b) => a.matchStartTime - b.matchStartTime);
        novo.sort((a, b) => a.matchStartTime - b.matchStartTime);
        const firstNew = novo.length ? new Date(novo[0].matchStartTime * 1000).toISOString().substring(0,10) : 'n/a';
        const lastNew  = novo.length ? new Date(novo[novo.length-1].matchStartTime * 1000).toISOString().substring(0,10) : 'n/a';
        console.log(` ${novo.length} novas (${firstNew} -> ${lastNew}) de ${all.length} total`);
        return { all, novo };
    }

    matches = matches.filter(m => m.matchStartTime >= start && m.matchStartTime <= now);
    matches.sort((a, b) => a.matchStartTime - b.matchStartTime);
    const first = matches.length ? new Date(matches[0].matchStartTime * 1000).toISOString().substring(0,10) : 'n/a';
    const last  = matches.length ? new Date(matches[matches.length-1].matchStartTime * 1000).toISOString().substring(0,10) : 'n/a';
    console.log(` ${matches.length} partidas (${first} -> ${last})`);
    return { all: matches, novo: matches };
}

// ── Motor Elo ─────────────────────────────────────────────────────────────────

function run(allMatches, newMatches, baseData) {
    const rm         = new RosterManager();
    const orgRatings = {}, orgWins = {}, orgLoss = {}, orgLastTs = {};
    const snapshots  = [];
    const now        = Math.floor(Date.now() / 1000);
    const twoYearsAgo = now - 2 * 365 * 86400;

    function getOrg(name) {
        if (!orgRatings[name]) { orgRatings[name] = CONFIG.initialRating; orgWins[name] = 0; orgLoss[name] = 0; }
        return orgRatings[name];
    }

    function orgSnap() {
        const obj = {};
        for (const [name, rating] of Object.entries(orgRatings))
            obj[name] = Math.round(rating * 10) / 10;
        return obj;
    }

    function processMatch(m) {
        const r1 = rm.get(m.team1Players, m.team1Name);
        const r2 = rm.get(m.team2Players, m.team2Name);
        const e1 = expected(r1.rating, r2.rating);
        const s1 = m.team1Score > m.team2Score ? 1 : 0;
        r1.rating += CONFIG.kBase * (s1 - e1);
        r2.rating += CONFIG.kBase * ((1-s1) - (1-e1));
        if (s1) r1.wins++; else r1.losses++;
        if (!s1) r2.wins++; else r2.losses++;
        r1.lastMatchTs = Math.max(r1.lastMatchTs, m.matchStartTime);
        r2.lastMatchTs = Math.max(r2.lastMatchTs, m.matchStartTime);
        const or1 = getOrg(m.team1Name), or2 = getOrg(m.team2Name);
        const oe1 = expected(or1, or2);
        orgRatings[m.team1Name] = or1 + CONFIG.kBase * (s1 - oe1);
        orgRatings[m.team2Name] = or2 + CONFIG.kBase * ((1-s1) - (1-oe1));
        if (s1) orgWins[m.team1Name]++; else orgLoss[m.team1Name]++;
        if (!s1) orgWins[m.team2Name]++; else orgLoss[m.team2Name]++;
        orgLastTs[m.team1Name] = Math.max(orgLastTs[m.team1Name]||0, m.matchStartTime);
        orgLastTs[m.team2Name] = Math.max(orgLastTs[m.team2Name]||0, m.matchStartTime);
    }

    if (DELTA && baseData) {
        // ── Modo delta: carrega ratings do base e processa só partidas novas ──

        // 1. Inicializa rosters com ratings do base
        rm.loadFromBase(baseData.rosterRanking || []);

        // 2. Inicializa orgs com ratings do base
        for (const t of (baseData.orgRanking || [])) {
            orgRatings[t.name] = t.rating;
            orgWins[t.name]    = t.wins;
            orgLoss[t.name]    = t.losses;
            orgLastTs[t.name]  = t.lastMatchTs || 0;
        }

        // 3. NAO copia snapshots do base — o dashboard ja tem o base no R2
        // Delta contem apenas os snapshots novos desde o base

        // 4. Processa so partidas novas gerando snapshots semanais
        let idx = 0, lastPct = -1;
        const total = newMatches.length;

        if (total === 0) {
            console.log('\n✅ Nenhuma partida nova para processar');
        } else {
            let nextSnap = newMatches[0].matchStartTime;
            // Alinha ao inicio da semana
            nextSnap = Math.floor(nextSnap / WEEK) * WEEK;

            while (idx < total) {
                while (idx < total && newMatches[idx].matchStartTime <= nextSnap) {
                    processMatch(newMatches[idx++]);
                    const pct = Math.floor(idx / total * 100);
                    if (pct !== lastPct) { process.stdout.write(`\r⚙️  Calculando Elo... ${pct}%  `); lastPct = pct; }
                }
                snapshots.push({ ts: nextSnap, rosters: rm.snapshot(), orgs: orgSnap() });
                nextSnap += WEEK;
                if (nextSnap > now) break;
            }

            // Processa restante
            while (idx < total) {
                processMatch(newMatches[idx++]);
                const pct = Math.floor(idx / total * 100);
                if (pct !== lastPct) { process.stdout.write(`\r⚙️  Calculando Elo... ${pct}%  `); lastPct = pct; }
            }
        }

    } else {
        // ── Modo full: processa todo o historico ──────────────────────────────
        const matches = allMatches;
        const minTs = matches[0]?.matchStartTime || 0;
        let nextSnap = minTs;
        let idx = 0, lastPct = -1;
        const total = matches.length;

        snapshots.push({ ts: minTs, rosters: {}, orgs: {} });

        while (idx < total) {
            while (idx < total && matches[idx].matchStartTime <= nextSnap) {
                processMatch(matches[idx++]);
                const pct = Math.floor(idx / total * 100);
                if (pct !== lastPct) { process.stdout.write(`\r⚙️  Calculando Elo... ${pct}%  `); lastPct = pct; }
            }
            snapshots.push({ ts: nextSnap, rosters: rm.snapshot(), orgs: orgSnap() });
            nextSnap += nextSnap < twoYearsAgo ? MONTH : WEEK;
            if (nextSnap > now) break;
        }
    }

    // Snapshot final
    snapshots.push({ ts: now, rosters: rm.snapshot(), orgs: orgSnap() });
    console.log('\r⚙️  Calculando Elo... 100%  ');

    const orgRanking = Object.entries(orgRatings)
        .map(([name, rating]) => ({
            name, rating: Math.round(rating * 10) / 10,
            wins: orgWins[name]||0, losses: orgLoss[name]||0,
            matches: (orgWins[name]||0) + (orgLoss[name]||0),
            lastMatchTs: orgLastTs[name]||0,
        }))
        .filter(t => t.matches > 0)
        .sort((a, b) => b.rating - a.rating)
        .map((t, i) => ({ rank: i+1, ...t }));

    return { rosterRanking: rm.ranking(), orgRanking, snapshots };
}

// ── Picos ─────────────────────────────────────────────────────────────────────

function calcPeaks(snapshots) {
    const rPeaks = {}, oPeaks = {};
    for (const snap of snapshots) {
        for (const [id, d] of Object.entries(snap.rosters || {})) {
            const name   = Array.isArray(d) ? d[0] : d.name;
            const rating = Array.isArray(d) ? d[1] : d.rating;
            if (!rPeaks[id] || rating > rPeaks[id].rating)
                rPeaks[id] = { rosterId: parseInt(id), name, rating, ts: snap.ts };
        }
        for (const [name, d] of Object.entries(snap.orgs || {})) {
            const rating = typeof d === 'number' ? d : d.rating;
            if (!oPeaks[name] || rating > oPeaks[name].rating)
                oPeaks[name] = { name, rating, ts: snap.ts };
        }
    }
    return {
        rosterPeaks: Object.values(rPeaks).sort((a,b)=>b.rating-a.rating).map((p,i)=>({rank:i+1,...p})),
        orgPeaks:    Object.values(oPeaks).sort((a,b)=>b.rating-a.rating).map((p,i)=>({rank:i+1,...p})),
    };
}

// ── Stream write ──────────────────────────────────────────────────────────────

function writeStream(outFile, meta, rosterRanking, orgRanking, rosterPeaks, orgPeaks, snapshots) {
    const fd = fs.openSync(outFile, 'w');
    const w  = (s) => fs.writeSync(fd, s);
    w('{"meta":' + JSON.stringify(meta));
    w(',"rosterRanking":[');
    rosterRanking.forEach((t,i) => { w((i?',':'') + JSON.stringify(t)); });
    w('],"orgRanking":[');
    orgRanking.forEach((t,i) => { w((i?',':'') + JSON.stringify(t)); });
    w('],"rosterPeaks":[');
    rosterPeaks.forEach((p,i) => { w((i?',':'') + JSON.stringify(p)); });
    w('],"orgPeaks":[');
    orgPeaks.forEach((p,i) => { w((i?',':'') + JSON.stringify(p)); });
    w('],"snapshots":[');
    snapshots.forEach((s,i) => { w((i?',':'') + JSON.stringify(s)); });
    w(']}');
    fs.closeSync(fd);
}

// ── Print ─────────────────────────────────────────────────────────────────────

function printTop(ranking, n=20) {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║     VRS ELO — Roster-Based (core >= 3)                  ║');
    console.log('╠══════╦═══════════════════════════╦═══════╦═════╦════════╣');
    ranking.slice(0,n).forEach(t => {
        const rk=String(t.rank).padStart(4), nm=t.name.padEnd(25);
        const rt=String(t.rating).padStart(7), w=String(t.wins).padStart(5), m=String(t.matches).padStart(7);
        console.log(`║ ${rk} ║ ${nm} ║ ${rt} ║${w} ║${m} ║`);
    });
    console.log('╚══════╩═══════════════════════════╩═══════╩═════╩════════╝');
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
    const dataFile = process.argv[2] || './matchdata.json';
    const outFile  = process.argv[3] || './elo_standings_delta.json';

    console.log(`\n🎯 Modo: ${FULL ? 'FULL (historico completo)' : 'DELTA (a partir do base)'}`);

    let baseData = null;
    let lastTs = 0;

    if (DELTA) {
        const result = loadBase();
        baseData = result.base;
        lastTs   = result.lastTs;
        if (!baseData) {
            console.log('\n❌ Base nao encontrado — necessario para modo --delta');
            process.exit(1);
        }
    }

    const { all, novo } = loadMatches(dataFile, DELTA ? lastTs : 0);
    const { rosterRanking, orgRanking, snapshots } = run(all, novo, baseData);
    const { rosterPeaks, orgPeaks } = calcPeaks(snapshots);

    console.log(`\n📊 ${rosterRanking.length} rosters | ${orgRanking.length} orgs | ${snapshots.length} snapshots`);
    printTop(rosterRanking);

    const meta = {
        generatedAt:    new Date().toISOString(),
        totalMatches:   all.length,
        newMatches:     novo.length,
        dataWindowDays: CONFIG.dataWindowDays,
        initialRating:  CONFIG.initialRating,
        kBase:          CONFIG.kBase,
        mode:           FULL ? 'full' : 'delta',
        baseLastTs:     lastTs || null,
    };

    process.stdout.write(`\n💾 Salvando ${outFile}...`);
    writeStream(outFile, meta, rosterRanking, orgRanking, rosterPeaks, orgPeaks, snapshots);
    const kb = Math.round(fs.statSync(outFile).size / 1024);
    console.log(` ${kb}KB ✅`);
    console.log('\n🏁 Concluido!');
}

main();
