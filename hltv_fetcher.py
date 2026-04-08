"""
hltv_fetcher.py — HLTV → matchdata.json (paralelo + resumível)

Instalar: pip install curl_cffi beautifulsoup4

Uso:
    python hltv_fetcher.py --days 60 --stars 2   # tier 1+2 (recomendado)
    python hltv_fetcher.py --days 60              # todas as partidas
    python hltv_fetcher.py --update               # só novas
"""

import json, random, argparse, os, re, asyncio
from datetime import datetime, timedelta
from bs4 import BeautifulSoup
from curl_cffi.requests import AsyncSession

OUTPUT_FILE = "matchdata.json"
BASE_URL    = "https://www.hltv.org"
IMPERSONATE = "chrome124"
CONCURRENCY = 7    # conservador para evitar burst de 429
MIN_DELAY   = 2.0
MAX_DELAY   = 5.0
MATCH_DELAY = 1.2   # delay base entre requests

HEADERS = {
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Referer":         "https://www.google.com/",
}

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

def load_existing(path):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        log(f"📂 Carregado: {len(data['matches'])} partidas")
        return data
    return {"matches": [], "events": []}

def save(data, path):
    seen, unique = set(), []
    for m in data["matches"]:
        if m["matchId"] not in seen:
            seen.add(m["matchId"])
            unique.append(m)
    data["matches"] = sorted(unique, key=lambda m: m["matchStartTime"])
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    complete = sum(1 for m in data["matches"] if len(m["team1Players"]) == 5 and len(m["team2Players"]) == 5)
    log(f"💾 {len(data['matches'])} partidas ({complete} completas) → {path}")

def save_stubs(stubs, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(stubs, f)

def load_stubs(path):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None

def parse_results_page(html, min_stars=0):
    """
    Estrutura real confirmada do HLTV /results:
    - Timestamp: data-zonedgrouping-entry-unix no div.result-con (em ms)
    - Estrelas: i.fa-star dentro de td.star-cell > div.stars
    - Score: span.score-won e span.score-lost dentro de td.result-score
    - Evento: span.event-name dentro de td.event
    """
    soup, matches = BeautifulSoup(html, "html.parser"), []

    for row in soup.select("div.result-con"):
        try:
            # Timestamp direto do atributo da linha (ms → s)
            unix_ms = row.get("data-zonedgrouping-entry-unix", "0")
            ts = int(unix_ms) // 1000 if unix_ms and unix_ms != "0" else 0

            # Estrelas reais: i.fa-star dentro de div.stars
            stars = len(row.select("td.star-cell div.stars i.fa-star"))

            # Filtro por estrelas
            if min_stars > 0 and stars < min_stars:
                continue

            a = row.select_one("a.a-reset")
            if not a: continue
            href = a.get("href", "")
            m = re.search(r"/matches/(\d+)/", href)
            if not m: continue
            match_id = int(m.group(1))

            teams = row.select("div.team")
            if len(teams) < 2: continue
            t1_name = teams[0].get_text(strip=True)
            t2_name = teams[1].get_text(strip=True)

            t1_score = t2_score = 0
            score_el = row.select_one("td.result-score")
            if score_el:
                spans = score_el.select("span")
                if len(spans) >= 2:
                    try:
                        t1_score = int(spans[0].get_text(strip=True))
                        t2_score = int(spans[1].get_text(strip=True))
                    except ValueError: pass

            ev_el   = row.select_one("td.event span.event-name, td.event span")
            ev_name = ev_el.get_text(strip=True) if ev_el else ""
            ev_link = row.select_one("td.event a")
            ev_id   = 0
            if ev_link:
                em = re.search(r"/events/(\d+)/", ev_link.get("href", ""))
                if em: ev_id = int(em.group(1))

            matches.append({
                "id": match_id, "team1_name": t1_name, "team2_name": t2_name,
                "t1_score": t1_score, "t2_score": t2_score,
                "event_id": ev_id, "event_name": ev_name,
                "ts": ts, "stars": stars,
                "href": href.strip("/")
            })
        except Exception: continue

    return matches

def parse_match_page(html):
    """
    Na página individual da partida:
    - Timestamp: div.timeAndEvent > div.date[data-unix]
    - Jogadores: div.lineup > td.player > div.text-ellipsis
    """
    soup = BeautifulSoup(html, "html.parser")
    t1p, t2p, lan, ts = [], [], False, 0
    try:
        # Timestamp correto — div.date dentro de div.timeAndEvent
        date_el = soup.select_one("div.timeAndEvent .date, div.date[data-unix]")
        if date_el and date_el.get("data-unix"):
            ts = int(date_el["data-unix"]) // 1000

        # Fallback: qualquer [data-unix] no passado recente
        if not ts:
            now_ts = int(datetime.now().timestamp())
            for el in soup.select("[data-unix]"):
                val = el.get("data-unix", "0")
                if val:
                    candidate = int(val) // 1000
                    if now_ts - 400*24*3600 < candidate <= now_ts:
                        ts = candidate
                        break

        # LAN
        if soup.select_one("img[src*='lan'], .lan-badge"): lan = True

        # Jogadores via lineup
        lineups = soup.select("div.lineup")
        if len(lineups) >= 2:
            t1p = [el.get_text(strip=True) for el in lineups[0].select("td.player div.text-ellipsis")]
            t2p = [el.get_text(strip=True) for el in lineups[1].select("td.player div.text-ellipsis")]

        if not t1p:
            sides = soup.select("div.players")
            if len(sides) >= 2:
                t1p = [p.get_text(strip=True) for p in sides[0].select("div.player-nick, span.player-nick")]
                t2p = [p.get_text(strip=True) for p in sides[1].select("div.player-nick, span.player-nick")]

        if not t1p:
            tables = soup.select("table.stats-table")
            if len(tables) >= 2:
                for row in tables[0].select("tr")[1:6]:
                    n = row.select_one("td.player-col a")
                    if n: t1p.append(n.get_text(strip=True))
                for row in tables[1].select("tr")[1:6]:
                    n = row.select_one("td.player-col a")
                    if n: t2p.append(n.get_text(strip=True))

    except Exception: pass
    return t1p[:5], t2p[:5], lan, ts

semaphore = None

async def fetch_url(session, url, retries=4):
    async with semaphore:
        await asyncio.sleep(random.uniform(MATCH_DELAY, MATCH_DELAY * 2))
        for attempt in range(1, retries + 1):
            try:
                r = await session.get(url, headers=HEADERS, timeout=15)
                if r.status_code == 200: return r.text
                if r.status_code == 429:
                    wait = 20 + random.uniform(0, 10)
                    log(f"  ⚠️  Rate limit — aguardando {wait:.0f}s...")
                    await asyncio.sleep(wait)
                    continue
                if r.status_code in (403, 503):
                    await asyncio.sleep(8 * attempt)
                    continue
            except Exception:
                await asyncio.sleep(4 * attempt)
        return None

async def fetch_match(session, stub, event_map, slot=0):
    """
    slot: índice 0..CONCURRENCY-1 — escalona os delays para evitar burst de 429.
    Cada worker tem um delay base diferente, espalhando os requests no tempo.
    """
    match_id = stub["id"]
    slug = stub["href"].split("/")[-1] if "/" in stub["href"] else stub["href"]
    url  = f"{BASE_URL}/matches/{match_id}/{slug}"
    ts   = stub["ts"]
    t1p, t2p, lan = [], [], False

    async with semaphore:
        # Jitter escalonado: slot 0 → ~1.2s, slot 1 → ~2.4s, slot 2 → ~3.6s, slot 3 → ~4.8s
        jitter = MATCH_DELAY * (1 + slot) + random.uniform(0, MATCH_DELAY * 0.5)
        await asyncio.sleep(jitter)

        for attempt in range(1, 7):
            try:
                headers_partial = {**HEADERS, "Range": "bytes=0-81920"}
                r = await session.get(url, headers=headers_partial, timeout=20)

                if r.status_code in (200, 206):
                    html = r.text
                    t1p, t2p, lan, _ = parse_match_page(html)
                    if stub["event_id"] and stub["event_id"] in event_map:
                        event_map[stub["event_id"]]["lan"] = lan
                    break

                if r.status_code == 429:
                    # Backoff exponencial — cresce com tentativas
                    wait = 25 + (attempt * 15) + random.uniform(0, 15)
                    log(f"  ⚠️  Rate limit slot={slot} tentativa={attempt} — aguardando {wait:.0f}s...")
                    await asyncio.sleep(wait)
                    continue

                if r.status_code in (403, 503):
                    await asyncio.sleep(10 * attempt)
                    continue

            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(5 * attempt)

    return {
        "matchId": match_id, "matchStartTime": ts, "eventId": stub["event_id"],
        "team1Name": stub["team1_name"], "team1Id": 0, "team1Players": t1p,
        "team2Name": stub["team2_name"], "team2Id": 0, "team2Players": t2p,
        "team1Score": stub["t1_score"], "team2Score": stub["t2_score"],
        "forfeited": False, "valveRanked": True, "lan": lan,
    }

async def run(days, output, update_mode, min_stars, max_stubs):
    global semaphore
    semaphore   = asyncio.Semaphore(CONCURRENCY)
    stubs_file  = output.replace(".json", "_stubs.json")

    log("=" * 55)
    log(f"  HLTV Fetcher  →  {output}  ({CONCURRENCY}x paralelo)")
    log("=" * 55)

    data        = load_existing(output) if (update_mode or os.path.exists(output)) else {"matches": [], "events": []}
    seen_ids    = {m["matchId"] for m in data["matches"]}
    done_ev_ids = {e["eventId"] for e in data["events"]}
    event_map   = {e["eventId"]: e for e in data["events"]}
    cutoff_ts   = int((datetime.now() - timedelta(days=days)).timestamp())

    # Tenta retomar fase 2 se stubs existirem
    saved_stubs = load_stubs(stubs_file)
    if saved_stubs:
        all_stubs   = [s for s in saved_stubs if s["id"] not in seen_ids]
        skip_phase1 = True
        log(f"🔄 Retomando fase 2: {len(all_stubs)} partidas pendentes de lineup")
    else:
        all_stubs   = []
        skip_phase1 = False
        log(f"Modo: {'atualização' if update_mode else 'inicial'}  |  {days} dias  |  stars≥{min_stars}")

    log(f"Existentes: {len(seen_ids)} partidas")

    async with AsyncSession(impersonate=IMPERSONATE) as session:

        # ── Fase 1: coleta páginas de resultados ──────────────────────────────
        if not skip_phase1:
            offset, page_num, stop = 0, 1, False
            while not stop:
                url  = f"{BASE_URL}/results?offset={offset}"
                log(f"📡 Página {page_num} (offset={offset})...")
                html = await fetch_url(session, url)
                if not html:
                    offset += 100; page_num += 1
                    await asyncio.sleep(5)
                    continue

                # Fase 1 sempre coleta TUDO (sem filtro de estrelas)
                # O filtro de estrelas é aplicado na fase 2
                all_results = parse_results_page(html, min_stars=0)
                if not all_results:
                    log("  ℹ️  Sem resultados — fim da paginação")
                    break

                # Para quando a última partida da página é mais antiga que o cutoff
                last_ts = max((r["ts"] for r in all_results if r["ts"] > 0), default=0)
                if last_ts > 0 and last_ts < cutoff_ts:
                    log(f"  🛑 Passou de {days} dias — parando fase 1")
                    all_results = [r for r in all_results if r["ts"] == 0 or r["ts"] >= cutoff_ts]
                    stop = True

                new_in_page = 0
                for r in all_results:
                    if r["id"] in seen_ids: continue
                    if r["event_id"] and r["event_id"] not in event_map:
                        event_map[r["event_id"]] = {
                            "eventId": r["event_id"], "eventName": r["event_name"],
                            "prizePool": "0", "lan": False, "finished": True,
                            "prizeDistribution": []
                        }
                    all_stubs.append(r)
                    seen_ids.add(r["id"])
                    new_in_page += 1

                log(f"  → {new_in_page} novas | total acumulado: {len(all_stubs)}")

                # Salva stubs após cada página — permite retomar se interrompido
                save_stubs(all_stubs, stubs_file)

                if not stop:
                    offset += 100; page_num += 1
                    await asyncio.sleep(random.uniform(MIN_DELAY, MAX_DELAY))

        # Aplica filtro de estrelas nos stubs antes da fase 2
        if min_stars > 0:
            before = len(all_stubs)
            all_stubs = [s for s in all_stubs if s.get("stars", 0) >= min_stars]
            log(f"⭐ Filtro stars≥{min_stars}: {before} → {len(all_stubs)} partidas")

        # Limita número de stubs a processar na fase 2
        if max_stubs > 0 and len(all_stubs) > max_stubs:
            log(f"✂️  Limitando fase 2 a {max_stubs} stubs (de {len(all_stubs)} disponíveis)")
            all_stubs = all_stubs[:max_stubs]

        log(f"\n📋 {len(all_stubs)} partidas para buscar lineup ({CONCURRENCY}x paralelo)...")

        # ── Fase 2: lineups em paralelo com slots escalonados ────────────────
        batch_size = CONCURRENCY * 4
        for i in range(0, len(all_stubs), batch_size):
            batch   = all_stubs[i:i + batch_size]
            pct     = int((i + len(batch)) / max(len(all_stubs), 1) * 100)
            log(f"⚡ Lineup {i+1}–{min(i+len(batch), len(all_stubs))} de {len(all_stubs)} ({pct}%)...")
            # slot escalonado: distribui os delays entre os workers do batch
            tasks   = [fetch_match(session, stub, event_map, slot=j % CONCURRENCY) for j, stub in enumerate(batch)]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            # Filtra exceções — não deixa crash derrubar o batch inteiro
            valid   = [r for r in results if isinstance(r, dict)]
            if len(valid) < len(results):
                log(f"  ⚠️  {len(results)-len(valid)} erros no batch — continuando...")
            data["matches"] = data["matches"] + valid
            data["events"]  = list(event_map.values())
            save(data, output)
            remaining = all_stubs[i + len(batch):]
            save_stubs(remaining, stubs_file)

        # Apaga stubs ao terminar com sucesso
        if os.path.exists(stubs_file):
            os.remove(stubs_file)
            log("🗑️  Arquivo de stubs removido")

    data["events"] = list(event_map.values())
    save(data, output)
    log("🏁 Concluído!")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="HLTV → matchdata.json")
    parser.add_argument("--days",   type=int, default=60,         help="Dias (default: 60)")
    parser.add_argument("--out",    type=str, default=OUTPUT_FILE, help="Arquivo de saída")
    parser.add_argument("--update", action="store_true",           help="Só partidas novas")
    parser.add_argument("--stars",      type=int, default=0,  help="Mínimo de estrelas/tier (0=todos, 1=tier2+, 2=tier1)")
    parser.add_argument("--max-stubs",  type=int, default=0,  help="Limita fase 2 a N stubs (0=sem limite). Ex: 105000")
    args = parser.parse_args()
    asyncio.run(run(days=args.days, output=args.out, update_mode=args.update, min_stars=args.stars, max_stubs=args.max_stubs))
