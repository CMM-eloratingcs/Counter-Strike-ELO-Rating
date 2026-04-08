"use strict";

/**
 * VRS ELO — Map-Based Ranking
 *
 * Em vez de contar o resultado do match como 1 partida,
 * cada mapa jogado é tratado como uma partida independente no Elo.
 *
 * Lógica de expansão de mapas:
 *   BO1: 1-0 → 1 mapa (vencedor ganhou)
 *   BO3: 2-0 → 2 mapas (vencedor ganhou ambos)
 *   BO3: 2-1 → 3 mapas (vencedor ganhou 2, perdedor ganhou 1)
 *   BO5: 3-0 → 3 mapas
 *   BO5: 3-1 → 4 mapas
 *   BO5: 3-2 → 5 mapas
 *
 * Uso:
 *   node elo_ranking_maps.js matchdata.json elo_standings_maps.json
 */

const fs = require('fs');

const CONFIG = {
    initialRating:  1400,
    kBase:          32,
    dataWindowDays: 10000,
    coreSize:       3,
};

const WEEK = 7 * 24 * 3600;

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

    snapshot(cutoffTs) {
        const obj = {};
        for (const r of this.rosters)
            if (r.wins + r.losses > 0 && r.lastMatchTs >= cutoffTs)
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

// ── Expande match em mapas individuais ────────────────────────────────────────

/**
 * Dado um match com team1Score e team2Score,
 * retorna uma lista de resultados de mapas individuais.
 * Cada item: { s1: 1|0 } — 1 = time1 venceu, 0 = time2 venceu
 *
 * Exemplos:
 *   2-0 → [win, win]             (2 mapas, time1 venceu ambos)
 *   2-1 → [win, loss, win]       (3 mapas, time1 venceu 2, time2 venceu 1)
 *   1-2 → [loss, win, loss]      (3 mapas, time2 venceu 2, time1 venceu 1)
 */
function expandMaps(t1Score, t2Score) {
    const maps = [];
    const total = t1Score + t2Score;

    // Distribui: vencedor ganha seus mapas, perdedor ganha os seus
    // Alternamos para simular distribuição mais realista
    let t1Left = t1Score;
    let t2Left = t2Score;

    for (let i = 0; i < total; i++) {
        // Alterna entre dar mapa ao time1 e time2
        // Coloca mapas do perdedor no meio, vencedor nos extremos
        if (t1Left > 0 && (t2Left === 0 || i % 2 === 0)) {
            maps.push(1); // time1 venceu este mapa
            t1Left--;
        } else if (t2Left > 0) {
            maps.push(0); // time2 venceu este mapa
            t2Left--;
        }
    }

    return maps;
}

// ── Carregar partidas ─────────────────────────────────────────────────────────

function loadMatches(filename) {
    process.stdout.write(`\n📂 Lendo ${filename}...`);
    const data   = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const events = {};
    (data.events || []).forEach(e => events[e.eventId] = e);

    let matches = data.matches || [];
    matches = matches.filter(m =>
        m.team1Players?.length === 5 && m.team2Players?.length === 5 &&
        !m.forfeited && m.matchStartTime > 0 &&
        m.team1Score >= 0 && m.team2Score >= 0 &&
        m.team1Score + m.team2Score > 0  // pelo menos 1 mapa jogado
    );
    matches = matches.filter(m => {
        const ev = events[m.eventId];
        if (!ev) return true;
        return ev.finished !== false && !ev.eventName?.toLowerCase().includes('showmatch');
    });

    const now   = Math.floor(Date.now() / 1000);
    const start = now - CONFIG.dataWindowDays * 86400;
    matches = matches.filter(m => m.matchStartTime >= start && m.matchStartTime <= now);
    matches.sort((a, b) => a.matchStartTime - b.matchStartTime);

    // Conta total de mapas
    const totalMaps = matches.reduce((s, m) => s + m.team1Score + m.team2Score, 0);
    const first = matches.length ? new Date(matches[0].matchStartTime * 1000).toISOString().substring(0,10) : 'n/a';
    const last  = matches.length ? new Date(matches[matches.length-1].matchStartTime * 1000).toISOString().substring(0,10) : 'n/a';
    console.log(` ${matches.length} partidas | ${totalMaps.toLocaleString()} mapas (${first} → ${last})`);
    return matches;
}

// ── Motor Elo por mapa ────────────────────────────────────────────────────────

function run(matches) {
    const rm         = new RosterManager();
    const orgRatings = {}, orgWins = {}, orgLoss = {}, orgLastTs = {};
    const snapshots  = [];
    const snapCutoff = 0; // sem filtro — histórico completo

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

    const minTs  = matches[0]?.matchStartTime || 0;
    let nextSnap = minTs;
    let idx = 0, lastPct = -1;
    const total = matches.length;

    snapshots.push({ ts: minTs, rosters: {}, orgs: {} });

    while (idx < total) {
        while (idx < total && matches[idx].matchStartTime <= nextSnap) {
            const m  = matches[idx++];
            const r1 = rm.get(m.team1Players, m.team1Name);
            const r2 = rm.get(m.team2Players, m.team2Name);

            // Expande o match em mapas individuais
            const mapResults = expandMaps(m.team1Score, m.team2Score);

            for (const s1 of mapResults) {
                // Roster Elo — 1 atualização por mapa
                const e1 = expected(r1.rating, r2.rating);
                r1.rating += CONFIG.kBase * (s1 - e1);
                r2.rating += CONFIG.kBase * ((1-s1) - (1-e1));
                if (s1) r1.wins++; else r1.losses++;
                if (!s1) r2.wins++; else r2.losses++;

                // Org Elo — 1 atualização por mapa
                const or1 = getOrg(m.team1Name), or2 = getOrg(m.team2Name);
                const oe1 = expected(or1, or2);
                orgRatings[m.team1Name] = or1 + CONFIG.kBase * (s1 - oe1);
                orgRatings[m.team2Name] = or2 + CONFIG.kBase * ((1-s1) - (1-oe1));
                if (s1) orgWins[m.team1Name]++; else orgLoss[m.team1Name]++;
                if (!s1) orgWins[m.team2Name]++; else orgLoss[m.team2Name]++;
            }

            r1.lastMatchTs = Math.max(r1.lastMatchTs, m.matchStartTime);
            r2.lastMatchTs = Math.max(r2.lastMatchTs, m.matchStartTime);
            orgLastTs[m.team1Name] = Math.max(orgLastTs[m.team1Name]||0, m.matchStartTime);
            orgLastTs[m.team2Name] = Math.max(orgLastTs[m.team2Name]||0, m.matchStartTime);

            const pct = Math.floor(idx / total * 100);
            if (pct !== lastPct) { process.stdout.write(`\r⚙️  Calculando Elo por mapa... ${pct}%  `); lastPct = pct; }
        }

        snapshots.push({ ts: nextSnap, rosters: rm.snapshot(snapCutoff), orgs: orgSnap() });
        nextSnap += WEEK;
        if (nextSnap > Math.floor(Date.now() / 1000)) break;
    }

    // Processa restante
    while (idx < total) {
        const m  = matches[idx++];
        const r1 = rm.get(m.team1Players, m.team1Name);
        const r2 = rm.get(m.team2Players, m.team2Name);
        const mapResults = expandMaps(m.team1Score, m.team2Score);
        for (const s1 of mapResults) {
            const e1 = expected(r1.rating, r2.rating);
            r1.rating += CONFIG.kBase * (s1 - e1);
            r2.rating += CONFIG.kBase * ((1-s1) - (1-e1));
            if (s1) r1.wins++; else r1.losses++;
            if (!s1) r2.wins++; else r2.losses++;
            const or1 = getOrg(m.team1Name), or2 = getOrg(m.team2Name);
            const oe1 = expected(or1, or2);
            orgRatings[m.team1Name] = or1 + CONFIG.kBase * (s1 - oe1);
            orgRatings[m.team2Name] = or2 + CONFIG.kBase * ((1-s1) - (1-oe1));
            if (s1) orgWins[m.team1Name]++; else orgLoss[m.team1Name]++;
            if (!s1) orgWins[m.team2Name]++; else orgLoss[m.team2Name]++;
        }
        r1.lastMatchTs = Math.max(r1.lastMatchTs, m.matchStartTime);
        r2.lastMatchTs = Math.max(r2.lastMatchTs, m.matchStartTime);
        orgLastTs[m.team1Name] = Math.max(orgLastTs[m.team1Name]||0, m.matchStartTime);
        orgLastTs[m.team2Name] = Math.max(orgLastTs[m.team2Name]||0, m.matchStartTime);
    }

    snapshots.push({ ts: Math.floor(Date.now()/1000), rosters: rm.snapshot(snapCutoff), orgs: orgSnap() });
    console.log('\r⚙️  Calculando Elo por mapa... 100%  ');

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

// ── Picos históricos ──────────────────────────────────────────────────────────

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

// ── Escrita em stream ─────────────────────────────────────────────────────────

function writeStream(outFile, meta, rosterRanking, orgRanking, rosterPeaks, orgPeaks, snapshots) {
    const fd = fs.openSync(outFile, 'w');
    const w  = (s) => fs.writeSync(fd, s);

    w('{"meta":' + JSON.stringify(meta));
    w(',"rosterRanking":[');
    rosterRanking.forEach((t, i) => { w((i?',':'') + JSON.stringify(t)); });
    w('],"orgRanking":[');
    orgRanking.forEach((t, i) => { w((i?',':'') + JSON.stringify(t)); });
    w('],"rosterPeaks":[');
    rosterPeaks.forEach((p, i) => { w((i?',':'') + JSON.stringify(p)); });
    w('],"orgPeaks":[');
    orgPeaks.forEach((p, i) => { w((i?',':'') + JSON.stringify(p)); });
    w('],"snapshots":[');
    snapshots.forEach((snap, i) => { w((i?',':'') + JSON.stringify(snap)); });
    w(']}');
    fs.closeSync(fd);
}

// ── Print ─────────────────────────────────────────────────────────────────────

function printTop(ranking, n=30) {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║     VRS ELO MAPS — Roster-Based (core ≥ 3) — por MAPA       ║');
    console.log('╠══════╦═══════════════════════════╦═══════╦══════╦════════════╣');
    console.log('║ Rank ║ Time                      ║ Rating║  W   ║ Mapas      ║');
    console.log('╠══════╬═══════════════════════════╬═══════╬══════╬════════════╣');
    ranking.slice(0,n).forEach(t => {
        const rk=String(t.rank).padStart(4), nm=t.name.padEnd(25);
        const rt=String(t.rating).padStart(7), w=String(t.wins).padStart(6), m=String(t.matches).padStart(10);
        console.log(`║ ${rk} ║ ${nm} ║ ${rt} ║${w} ║${m} ║`);
    });
    console.log('╚══════╩═══════════════════════════╩═══════╩══════╩════════════╝');
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
    const dataFile = process.argv[2] || './matchdata.json';
    const outFile  = process.argv[3] || './elo_standings_maps.json';

    const matches = loadMatches(dataFile);
    const totalMaps = matches.reduce((s, m) => s + m.team1Score + m.team2Score, 0);

    const { rosterRanking, orgRanking, snapshots } = run(matches);
    const { rosterPeaks, orgPeaks } = calcPeaks(snapshots);

    console.log(`\n📊 ${rosterRanking.length} rosters | ${orgRanking.length} orgs | ${snapshots.length} snapshots`);
    console.log(`🗺️  ${totalMaps.toLocaleString()} mapas processados (média ${(totalMaps/matches.length).toFixed(1)} por partida)`);
    printTop(rosterRanking);

    const meta = {
        generatedAt:    new Date().toISOString(),
        totalMatches:   matches.length,
        totalMaps,
        dataWindowDays: CONFIG.dataWindowDays,
        initialRating:  CONFIG.initialRating,
        kBase:          CONFIG.kBase,
        mode:           'map-based',
    };

    process.stdout.write(`\n💾 Salvando ${outFile} em stream...`);
    writeStream(outFile, meta, rosterRanking, orgRanking, rosterPeaks, orgPeaks, snapshots);
    const kb = Math.round(fs.statSync(outFile).size / 1024);
    console.log(` ${kb}KB ✅`);
    console.log('\n🏁 Concluído!');
}

main();
