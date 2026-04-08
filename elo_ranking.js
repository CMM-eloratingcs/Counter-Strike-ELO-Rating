"use strict";

/**
 * VRS Elo Ranking — Roster-Based + Snapshots históricos
 *
 * Exporta elo_standings.json com:
 *   - ranking final (roster e org)
 *   - snapshots semanais para o timeline do dashboard
 *
 * Uso:
 *   node elo_ranking.js matchdata.json elo_standings.json
 *   node elo_ranking.js matchdata.json elo_standings.json --days 730
 */

const fs = require('fs');

const CONFIG = {
    initialRating:  1400,
    kBase:          32,
    dataWindowDays: parseInt(process.argv[4]?.replace('--days=','')) || 10000,
    coreSize:       3,
    snapshotWeeks:  1,   // snapshot a cada N semanas
};

const WEEK  = 7  * 24 * 3600;
const MONTH = 30 * 24 * 3600;

// ─── Elo ──────────────────────────────────────────────────────────────────────

function expected(ra, rb) { return 1 / (1 + Math.pow(10, (rb - ra) / 400)); }

// ─── Roster Manager ───────────────────────────────────────────────────────────

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
            best.players = ps;
            best.name    = name;
            return best;
        }
        const r = { id: this.nextId++, players: ps, name, rating: CONFIG.initialRating, wins: 0, losses: 0, lastMatchTs: 0 };
        this.rosters.push(r);
        return r;
    }

    snapshot(cutoffTs) {
        // Snapshot compacto: só times que jogaram após cutoffTs
        // Formato: {id: [name, rating]} em vez de objeto para economizar espaço
        const obj = {};
        for (const r of this.rosters) {
            if (r.wins + r.losses > 0 && (r.lastMatchTs || 0) >= cutoffTs)
                obj[r.id] = [r.name, Math.round(r.rating * 10) / 10];
        }
        return obj;
    }

    ranking() {
        return this.rosters
            .filter(r => r.wins + r.losses > 0)
            .map(r => ({
                name:        r.name,
                rating:      Math.round(r.rating * 10) / 10,
                wins:        r.wins,
                losses:      r.losses,
                matches:     r.wins + r.losses,
                lastMatchTs: r.lastMatchTs,
                players:     [...r.players],
                rosterId:    r.id,
            }))
            .sort((a, b) => b.rating - a.rating)
            .map((t, i) => ({ rank: i + 1, ...t }));
    }
}

// ─── Carregamento ─────────────────────────────────────────────────────────────

function loadMatches(filename) {
    process.stdout.write(`\n📂 Lendo ${filename}...`);
    const data   = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const events = {};
    (data.events || []).forEach(e => events[e.eventId] = e);

    let matches = data.matches || [];
    matches = matches.filter(m =>
        m.team1Players?.length === 5 &&
        m.team2Players?.length === 5 &&
        !m.forfeited &&
        m.matchStartTime > 0
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

    console.log(` ${matches.length} partidas válidas`);
    return matches;
}

// ─── Motor principal ──────────────────────────────────────────────────────────

function run(matches) {
    const rm          = new RosterManager();
    const orgRatings  = {};
    const orgWins     = {};
    const orgLoss     = {};
    const orgLastTs   = {};   // última partida por org
    const snapshots   = [];     // [{ts, rosters:{id→{name,rating,w,l}}, orgs:{name→{rating,w,l}}}]

    function getOrg(name) {
        if (!orgRatings[name]) { orgRatings[name] = CONFIG.initialRating; orgWins[name] = 0; orgLoss[name] = 0; }
        return orgRatings[name];
    }

    // Cutoff: só inclui nos snapshots times ativos nos últimos 2 anos
    const snapCutoff = Math.floor(Date.now() / 1000) - 2 * 365 * 86400;

    function orgSnapshot() {
        // Formato compacto: {name: rating} em vez de {name: {rating,wins,losses}}
        // Só times ativos nos últimos 2 anos
        const obj = {};
        for (const [name, rating] of Object.entries(orgRatings))
            if ((orgLastTs[name] || 0) >= snapCutoff)
                obj[name] = Math.round(rating * 10) / 10;
        return obj;
    }

    const minTs = matches[0]?.matchStartTime || 0;
    let   nextSnap = minTs;
    let   idx      = 0;
    const total    = matches.length;
    let   lastPct  = -1;

    // Snapshot inicial
    snapshots.push({ ts: minTs, rosters: {}, orgs: {} });

    while (idx < total) {
        // Processa partidas até nextSnap
        while (idx < total && matches[idx].matchStartTime <= nextSnap) {
            const m  = matches[idx++];
            const r1 = rm.get(m.team1Players, m.team1Name);
            const r2 = rm.get(m.team2Players, m.team2Name);

            // Roster Elo
            const e1 = expected(r1.rating, r2.rating);
            const s1 = m.team1Score > m.team2Score ? 1 : 0;
            r1.rating += CONFIG.kBase * (s1 - e1);
            r2.rating += CONFIG.kBase * ((1 - s1) - (1 - e1));
            if (s1) r1.wins++; else r1.losses++;
            if (!s1) r2.wins++; else r2.losses++;

            // Org Elo
            const or1 = getOrg(m.team1Name), or2 = getOrg(m.team2Name);
            const oe1 = expected(or1, or2);
            orgRatings[m.team1Name] = or1 + CONFIG.kBase * (s1 - oe1);
            orgRatings[m.team2Name] = or2 + CONFIG.kBase * ((1 - s1) - (1 - oe1));
            if (s1) orgWins[m.team1Name]++; else orgLoss[m.team1Name]++;
            if (!s1) orgWins[m.team2Name]++; else orgLoss[m.team2Name]++;
            // Atualiza última partida
            orgLastTs[m.team1Name] = Math.max(orgLastTs[m.team1Name]||0, m.matchStartTime);
            orgLastTs[m.team2Name] = Math.max(orgLastTs[m.team2Name]||0, m.matchStartTime);
            // Atualiza última partida dos rosters
            r1.lastMatchTs = Math.max(r1.lastMatchTs||0, m.matchStartTime);
            r2.lastMatchTs = Math.max(r2.lastMatchTs||0, m.matchStartTime);

            // Progresso
            const pct = Math.floor(idx / total * 100);
            if (pct !== lastPct) { process.stdout.write(`\r⚙️  Calculando Elo... ${pct}%  `); lastPct = pct; }
        }

        snapshots.push({ ts: nextSnap, rosters: rm.snapshot(snapCutoff), orgs: orgSnapshot() });
        nextSnap += WEEK * CONFIG.snapshotWeeks;
        if (nextSnap > Math.floor(Date.now() / 1000)) break;
    }

    // Processa o que sobrou após o último snapshot
    while (idx < total) {
        const m  = matches[idx++];
        const r1 = rm.get(m.team1Players, m.team1Name);
        const r2 = rm.get(m.team2Players, m.team2Name);
        const e1 = expected(r1.rating, r2.rating);
        const s1 = m.team1Score > m.team2Score ? 1 : 0;
        r1.rating += CONFIG.kBase * (s1 - e1);
        r2.rating += CONFIG.kBase * ((1 - s1) - (1 - e1));
        if (s1) r1.wins++; else r1.losses++;
        if (!s1) r2.wins++; else r2.losses++;
        const or1 = getOrg(m.team1Name), or2 = getOrg(m.team2Name);
        const oe1 = expected(or1, or2);
        orgRatings[m.team1Name] = or1 + CONFIG.kBase * (s1 - oe1);
        orgRatings[m.team2Name] = or2 + CONFIG.kBase * ((1 - s1) - (1 - oe1));
        if (s1) orgWins[m.team1Name]++; else orgLoss[m.team1Name]++;
        if (!s1) orgWins[m.team2Name]++; else orgLoss[m.team2Name]++;
    }

    // Snapshot final
    snapshots.push({ ts: Math.floor(Date.now() / 1000), rosters: rm.snapshot(), orgs: orgSnapshot() });
    console.log('\r⚙️  Calculando Elo... 100%  ');

    // Ranking org final
    const orgRanking = Object.entries(orgRatings)
        .map(([name, rating]) => ({
            name,
            rating:      Math.round(rating * 10) / 10,
            wins:        orgWins[name] || 0,
            losses:      orgLoss[name] || 0,
            matches:     (orgWins[name] || 0) + (orgLoss[name] || 0),
            lastMatchTs: orgLastTs[name] || 0,
        }))
        .filter(t => t.matches > 0)
        .sort((a, b) => b.rating - a.rating)
        .map((t, i) => ({ rank: i + 1, ...t }));

    return { rosterRanking: rm.ranking(), orgRanking, snapshots };
}

// ─── Picos históricos e última partida ───────────────────────────────────────

function calcPeaks(snapshots) {
    const rosterPeaks = {}; // id → {name, rating, ts}
    const orgPeaks    = {}; // name → {rating, ts}

    for (const snap of snapshots) {
        // Roster peaks
        for (const [id, d] of Object.entries(snap.rosters || {})) {
            const key = id;
            if (!rosterPeaks[key] || d.rating > rosterPeaks[key].rating) {
                rosterPeaks[key] = { rosterId: parseInt(id), name: d.name, rating: d.rating, ts: snap.ts };
            }
        }
        // Org peaks
        for (const [name, d] of Object.entries(snap.orgs || {})) {
            if (!orgPeaks[name] || d.rating > orgPeaks[name].rating) {
                orgPeaks[name] = { name, rating: d.rating, ts: snap.ts };
            }
        }
    }

    const rosterPeakList = Object.values(rosterPeaks)
        .sort((a, b) => b.rating - a.rating)
        .map((p, i) => ({ rank: i + 1, ...p }));

    const orgPeakList = Object.values(orgPeaks)
        .sort((a, b) => b.rating - a.rating)
        .map((p, i) => ({ rank: i + 1, ...p }));

    return { rosterPeaks: rosterPeakList, orgPeaks: orgPeakList };
}

function printTop(ranking, n = 30) {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║     VRS ELO — Roster-Based (core ≥ 3)                   ║');
    console.log('╠══════╦═══════════════════════════╦═══════╦═════╦════════╣');
    console.log('║ Rank ║ Time                      ║ Rating║  W  ║ Partid.║');
    console.log('╠══════╬═══════════════════════════╬═══════╬═════╬════════╣');
    ranking.slice(0, n).forEach(t => {
        const rk = String(t.rank).padStart(4);
        const nm = t.name.padEnd(25);
        const rt = String(t.rating).padStart(7);
        const w  = String(t.wins).padStart(5);
        const m  = String(t.matches).padStart(7);
        console.log(`║ ${rk} ║ ${nm} ║ ${rt} ║${w} ║${m} ║`);
    });
    console.log('╚══════╩═══════════════════════════╩═══════╩═════╩════════╝');
}

function main() {
    const dataFile = process.argv[2] || './matchdata.json';
    const outFile  = process.argv[3] || './elo_standings.json';

    const matches = loadMatches(dataFile);
    const { rosterRanking, orgRanking, snapshots } = run(matches);
    const { rosterPeaks, orgPeaks } = calcPeaks(snapshots);

    console.log(`\n📊 ${rosterRanking.length} rosters | ${orgRanking.length} orgs | ${snapshots.length} snapshots`);
    printTop(rosterRanking);

    const output = {
        meta: {
            generatedAt:    new Date().toISOString(),
            totalMatches:   matches.length,
            dataWindowDays: CONFIG.dataWindowDays,
            initialRating:  CONFIG.initialRating,
            kBase:          CONFIG.kBase,
        },
        rosterRanking,
        orgRanking,
        rosterPeaks,
        orgPeaks,
        snapshots,
    };

    process.stdout.write(`\n💾 Salvando ${outFile}...`);
    fs.writeFileSync(outFile, JSON.stringify(output));
    const kb = Math.round(fs.statSync(outFile).size / 1024);
    console.log(` ${kb}KB ✅`);
    console.log('\n🏁 Concluído!');
}

main();
