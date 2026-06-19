/* =========================================================
   Texas Hold'em Poker – app.js
   Solo (vs Bots) + P2P Multiplayer via PeerJS
   ========================================================= */
'use strict';

/* ── Constants ──────────────────────────────────────────── */
const SUITS     = ['♠','♥','♦','♣'];
const RANKS     = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL  = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
const BOT_NAMES = ['Nova','Rex','Jade','Blaze','Ace'];
const BLINDS_MAP = {
  low:  {sb:10,  bb:20 },
  med:  {sb:25,  bb:50 },
  high: {sb:50,  bb:100},
  turbo:{sb:100, bb:200},
};
const PHASE_LABELS = {
  preflop:'Pre-Flop', flop:'Flop', turn:'Turn',
  river:'River', showdown:'Showdown', done:'Hand beendet', idle:'',
};
const START_CHIPS = 1000;

/* ── State ───────────────────────────────────────────────── */
let G        = null;   // full game state; only host/solo modifies it
let botTimer = null;

/* ── Network ─────────────────────────────────────────────── */
let net = {
  mode:       'solo',   // 'solo' | 'host' | 'guest'
  peer:       null,
  myId:       null,
  roomCode:   null,
  conns:      {},       // peerId->conn  (host)
  hostConn:   null,     // conn to host  (guest)
  myName:     'Du',
  guestSeats: [],       // [{peerId,name,conn}]  (host)
};

/* ── Helpers ─────────────────────────────────────────────── */
const rand    = n => Math.floor(Math.random() * n);
const shuffle = arr => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
function genCode() {
  return Array.from({length:6}, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[rand(32)]).join('');
}

/* ══════════════════════════════════════════════════════════
   UI HELPERS
══════════════════════════════════════════════════════════ */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tabSolo').style.display  = tab === 'solo'  ? 'block' : 'none';
  document.getElementById('tabMulti').style.display = tab === 'multi' ? 'block' : 'none';
}

function showScreen(id) {
  document.getElementById('lobbyScreen').style.display = id === 'lobby' ? 'flex' : 'none';
  document.getElementById('gameScreen').style.display  = id === 'game'  ? 'flex' : 'none';
}

function setNetStatus(msg, cls = '') {
  const el = document.getElementById('netStatus');
  el.textContent = msg;
  el.className = 'net-status ' + cls;
}

function backToLobby() {
  clearTimeout(botTimer);
  if (net.peer) { try { net.peer.destroy(); } catch(e) {} net.peer = null; }
  net = {
    mode:'solo', peer:null, myId:null, roomCode:null,
    conns:{}, hostConn:null,
    myName: document.getElementById('playerName')?.value || 'Du',
    guestSeats:[],
  };
  G = null;
  document.getElementById('logArea').innerHTML = '';
  const ov = document.getElementById('messageOverlay');
  ov.style.display = 'none'; ov.innerHTML = '';
  showScreen('lobby');
}

/* ── Card HTML ───────────────────────────────────────────── */
const cardColor   = s => (s === '♥' || s === '♦') ? 'red' : '';
const smallCard   = (c, hidden = false) => hidden
  ? '<div class="card back"></div>'
  : `<div class="card ${cardColor(c.suit)}"><span>${c.rank}</span><span>${c.suit}</span></div>`;
const commCard    = c => c
  ? `<div class="community-card ${cardColor(c.suit)}"><span>${c.rank}</span><span>${c.suit}</span></div>`
  : '<div class="community-card empty"></div>';
const bigCard     = c =>
  `<div class="my-card ${cardColor(c.suit)}"><span style="font-size:14px">${c.rank}</span><span>${c.suit}</span></div>`;
const dealerBadge = () => '<span class="dealer-btn">D</span>';

/* ══════════════════════════════════════════════════════════
   SOLO MODE
══════════════════════════════════════════════════════════ */
function startSoloGame() {
  clearTimeout(botTimer);
  net.mode   = 'solo';
  net.myId   = 'local';
  net.myName = 'Du';
  document.getElementById('gameModeBadge').textContent = '🤖 Solo';
  setNetStatus('');
  showScreen('game');
  document.getElementById('logArea').innerHTML = '';

  const numBots  = parseInt(document.getElementById('numBots').value, 10);
  const strength = document.getElementById('botStrength').value;
  const {sb, bb} = BLINDS_MAP[document.getElementById('blindsLevel').value] || BLINDS_MAP.med;

  G = {
    players:[], deck:[], community:[], pot:0,
    phase:'idle', currentBet:0, dealerIdx:0, activeIdx:-1,
    sb, bb, roundNum:0, actionLock:false,
  };
  G.players.push(mkHuman('Du', 'local'));
  for (let i = 0; i < numBots; i++) G.players.push(mkBot(BOT_NAMES[i], strength));

  hideOverlay();
  // Show the "Deal" button
  render();
  showDealButton();
}

function showDealButton() {
  const pa = document.getElementById('playerArea');
  pa.className = 'player-area';
  pa.innerHTML = `<div style="text-align:center;width:100%">
    <button class="btn btn-deal" onclick="startRound()">🃏 Karten geben</button>
  </div>`;
}

/* ══════════════════════════════════════════════════════════
   MULTIPLAYER – PeerJS P2P
   Host drives all logic and broadcasts state.
   Guests only send actions back.
══════════════════════════════════════════════════════════ */
function createRoom() {
  const name = (document.getElementById('playerName').value || 'Host').trim();
  net.myName    = name;
  net.mode      = 'host';
  net.roomCode  = genCode();
  net.guestSeats = [];

  document.getElementById('roomCodeDisplay').style.display = 'flex';
  document.getElementById('roomCodeValue').textContent = net.roomCode;
  document.getElementById('waitingPlayers').textContent = 'Verbinde…';

  net.peer = new Peer('poker-' + net.roomCode, { debug: 0 });

  net.peer.on('open', id => {
    net.myId = id;
    document.getElementById('waitingPlayers').textContent = `${name} (Du) wartet…`;
    log(`Raum ${net.roomCode} erstellt.`, false, false, true);
  });

  net.peer.on('connection', conn => {
    conn.on('open', () => {
      const guestName = conn.metadata?.name || conn.peer;
      const seat = { peerId: conn.peer, name: guestName, conn };
      net.guestSeats.push(seat);
      net.conns[conn.peer] = conn;
      updateWaitingList();
      log(`${guestName} ist beigetreten.`, false, false, true);
      conn.on('data',  msg => hostReceive(msg, conn.peer));
      conn.on('close', ()  => {
        net.guestSeats = net.guestSeats.filter(s => s.peerId !== conn.peer);
        delete net.conns[conn.peer];
        updateWaitingList();
        log(`${guestName} hat die Verbindung getrennt.`, false, false, true);
        if (G) broadcastState();
      });
      document.getElementById('startMultiBtn').disabled = false;
    });
  });

  net.peer.on('error', e => {
    document.getElementById('waitingPlayers').textContent = 'Fehler: ' + e.type;
  });
}

function updateWaitingList() {
  const names = [net.myName + ' (Du)', ...net.guestSeats.map(s => s.name)];
  document.getElementById('waitingPlayers').textContent =
    `Spieler (${names.length}): ${names.join(', ')}`;
  document.getElementById('startMultiBtn').disabled = net.guestSeats.length < 1;
}

function startMultiGame() {
  const {sb, bb} = BLINDS_MAP[document.getElementById('mBlindLevel').value] || BLINDS_MAP.med;
  const numBots  = parseInt(document.getElementById('mBots').value, 10);

  G = {
    players:[], deck:[], community:[], pot:0,
    phase:'idle', currentBet:0, dealerIdx:0, activeIdx:-1,
    sb, bb, roundNum:0, actionLock:false,
  };
  G.players.push(mkHuman(net.myName, net.myId));
  net.guestSeats.forEach(s => G.players.push(mkHuman(s.name, s.peerId)));
  for (let i = 0; i < numBots; i++) G.players.push(mkBot(BOT_NAMES[i], 'medium'));

  document.getElementById('gameModeBadge').textContent = '🌐 Multiplayer';
  setNetStatus(`Host · ${net.roomCode}`, 'ok');
  showScreen('game');
  document.getElementById('logArea').innerHTML = '';
  hideOverlay();

  // Tell guests game started
  const startMsg = { type:'gameStart', players: G.players.map(p => ({name:p.name, peerId:p.peerId})) };
  for (const conn of Object.values(net.conns)) { try { conn.send(startMsg); } catch(e){} }

  startRound();
}

function joinRoom() {
  const code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
  if (code.length !== 6) { setJoinStatus('Bitte 6-stelligen Code eingeben.', 'error'); return; }
  const name = (document.getElementById('playerName').value || 'Gast').trim();
  net.myName   = name;
  net.mode     = 'guest';
  net.roomCode = code;
  setJoinStatus('Verbinde…');
  net.peer = new Peer(undefined, { debug: 0 });
  net.peer.on('open', id => {
    net.myId = id;
    const conn = net.peer.connect('poker-' + code, { metadata:{ name }, reliable:true });
    net.hostConn = conn;
    conn.on('open',  ()  => { setJoinStatus('Verbunden! Warte auf Spielstart…', 'ok'); });
    conn.on('data',  msg => guestReceive(msg));
    conn.on('close', ()  => { setJoinStatus('Verbindung getrennt.', 'error'); setNetStatus('Getrennt','error'); });
    conn.on('error', e   => setJoinStatus('Fehler: ' + e, 'error'));
  });
  net.peer.on('error', e => setJoinStatus('Fehler: ' + e.type, 'error'));
}

function setJoinStatus(msg, cls = '') {
  const el = document.getElementById('joinStatus');
  el.textContent = msg; el.className = 'join-status ' + cls;
}

/* ── Host: receive action from guest ────────────────────── */
function hostReceive(msg, fromPeer) {
  if (!G || net.mode !== 'host') return;
  if (msg.type === 'action') {
    const seat = G.players.findIndex(p => p.peerId === fromPeer);
    if (seat < 0 || G.activeIdx !== seat) return;
    applyAction(msg.action, msg.raiseAmount || 0);
  }
}

/* ── Guest: receive state from host ─────────────────────── */
function guestReceive(msg) {
  if (msg.type === 'gameStart') {
    document.getElementById('gameModeBadge').textContent = '🌐 Multiplayer';
    setNetStatus(`Gast · ${net.roomCode}`, 'ok');
    showScreen('game');
    document.getElementById('logArea').innerHTML = '';
    hideOverlay();
    log(`Spiel gestartet! Spieler: ${msg.players.map(p => p.name).join(', ')}`, false, false, true);
  }
  if (msg.type === 'state') {
    G = msg.state;
    render();
  }
  if (msg.type === 'log') {
    log(msg.msg, msg.important, msg.win);
  }
}

/* ── Broadcast ───────────────────────────────────────────── */
function broadcastState() {
  // Always render locally first
  render();
  if (net.mode !== 'host') return;
  const msg = { type:'state', state: G };
  for (const conn of Object.values(net.conns)) { try { conn.send(msg); } catch(e){} }
}

function broadcastLog(msg, important = false, win = false) {
  log(msg, important, win);
  if (net.mode !== 'host') return;
  const packet = { type:'log', msg, important, win };
  for (const conn of Object.values(net.conns)) { try { conn.send(packet); } catch(e){} }
}

/* ── Guest sends action ──────────────────────────────────── */
function guestSendAction(action, raiseAmount = 0) {
  if (net.hostConn) net.hostConn.send({ type:'action', action, raiseAmount });
}

/* ══════════════════════════════════════════════════════════
   PLAYER FACTORIES
══════════════════════════════════════════════════════════ */
function mkHuman(name, peerId = 'local') {
  return { name, chips:START_CHIPS, bet:0, folded:false, allIn:false,
    eliminated:false, isHuman:true, isBot:false, cards:[], acted:false,
    peerId, handScore:0, handName:'' };
}
function mkBot(name, strength) {
  return { name, chips:START_CHIPS, bet:0, folded:false, allIn:false,
    eliminated:false, isHuman:false, isBot:true, cards:[], acted:false,
    peerId:'bot-' + name, strength, handScore:0, handName:'' };
}

/* ══════════════════════════════════════════════════════════
   GAME LOGIC  (runs on host / solo only)
══════════════════════════════════════════════════════════ */
function startRound() {
  clearTimeout(botTimer);
  if (!G) return;
  const s = G;
  s.roundNum = (s.roundNum || 0) + 1;

  const alive = s.players.filter(p => !p.eliminated);
  if (alive.length < 2) { showGameOver(alive[0]); return; }

  s.deck      = createDeck();
  s.community = [];
  s.pot = 0; s.currentBet = 0;
  s.phase = 'preflop'; s.actionLock = false;

  for (const p of s.players) {
    p.bet = 0; p.folded = p.eliminated; p.allIn = false;
    p.cards = []; p.acted = false; p.handScore = 0; p.handName = '';
  }

  // Deal 2 cards per active player
  for (let i = 0; i < 2; i++)
    for (const p of s.players.filter(p => !p.eliminated))
      p.cards.push(s.deck.pop());

  // Advance dealer button
  const aliveIdxs = s.players.reduce((acc, p, i) => { if (!p.eliminated) acc.push(i); return acc; }, []);
  let di = aliveIdxs.indexOf(s.dealerIdx);
  di = (di + 1) % aliveIdxs.length;
  s.dealerIdx = aliveIdxs[di];

  // Blinds
  const sbIdx = nextAlive(s.dealerIdx);
  const bbIdx = nextAlive(sbIdx);
  postBlind(sbIdx, s.sb);
  postBlind(bbIdx, s.bb);
  s.currentBet = s.bb;

  // UTG acts first pre-flop
  s.activeIdx = nextAlive(bbIdx);
  for (const p of s.players) p.acted = false;

  broadcastLog(`--- Runde ${s.roundNum} --- Dealer: ${s.players[s.dealerIdx].name} ---`);
  broadcastLog(`${s.players[sbIdx].name} postet SB ${s.sb}. ${s.players[bbIdx].name} postet BB ${s.bb}.`, true);

  broadcastState();
  scheduleAction();
}

function postBlind(idx, amount) {
  const p = G.players[idx];
  const a = Math.min(amount, p.chips);
  p.chips -= a; p.bet += a; G.pot += a;
  if (p.chips === 0) p.allIn = true;
}

function nextAlive(from) {
  const s = G;
  let idx = (from + 1) % s.players.length;
  for (let t = 0; t < s.players.length; t++) {
    if (!s.players[idx].folded && !s.players[idx].eliminated) return idx;
    idx = (idx + 1) % s.players.length;
  }
  return from;
}

function activePlayers() {
  return G.players.filter(p => !p.folded && !p.eliminated);
}

/* ── Action Loop ─────────────────────────────────────────── */
function scheduleAction() {
  if (!G || G.actionLock) return;
  const p = G.players[G.activeIdx];
  if (!p || p.folded || p.eliminated || p.allIn) { advanceAction(); return; }
  if (p.isBot) {
    botTimer = setTimeout(() => doBotAction(), 700 + rand(600));
    return;
  }
  // Human player — just render (buttons are shown in renderMyArea)
  broadcastState();
}

function advanceAction() {
  const s = G;
  const active = activePlayers();
  if (active.length === 1) { awardPot(active); return; }

  const canAct = active.filter(p => !p.allIn && p.chips > 0);
  const allDone = canAct.length === 0 || canAct.every(p => p.acted && p.bet >= s.currentBet);
  if (allDone) { nextPhase(); return; }

  // Find next player who needs to act
  let idx = (s.activeIdx + 1) % s.players.length;
  for (let t = 0; t < s.players.length; t++) {
    const p = s.players[idx];
    if (!p.folded && !p.eliminated && !p.allIn && p.chips > 0 && (!p.acted || p.bet < s.currentBet)) {
      s.activeIdx = idx;
      broadcastState();
      scheduleAction();
      return;
    }
    idx = (idx + 1) % s.players.length;
  }
  nextPhase();
}

function nextPhase() {
  const s = G;
  for (const p of s.players) { p.bet = 0; p.acted = false; }
  s.currentBet = 0;

  if      (s.phase === 'preflop') { s.phase = 'flop';  s.community.push(s.deck.pop(), s.deck.pop(), s.deck.pop()); broadcastLog('--- Flop ---', true); }
  else if (s.phase === 'flop')    { s.phase = 'turn';  s.community.push(s.deck.pop()); broadcastLog('--- Turn ---', true); }
  else if (s.phase === 'turn')    { s.phase = 'river'; s.community.push(s.deck.pop()); broadcastLog('--- River ---', true); }
  else if (s.phase === 'river')   { showdown(); return; }

  s.activeIdx = nextAlive(s.dealerIdx);
  broadcastState();
  scheduleAction();
}

/* ── Apply Action (central handler) ─────────────────────── */
function applyAction(type, raiseAmount = 0) {
  const s = G;
  const p = s.players[s.activeIdx];
  if (!p || p.folded || p.eliminated) return;
  const toCall = s.currentBet - p.bet;

  switch (type) {
    case 'fold':
      p.folded = true; p.acted = true;
      broadcastLog(`${p.name} foldet.`);
      break;

    case 'check':
      if (toCall > 0) return; // not allowed
      p.acted = true;
      broadcastLog(`${p.name} checkt.`);
      break;

    case 'call': {
      const a = Math.min(toCall, p.chips);
      p.chips -= a; p.bet += a; s.pot += a; p.acted = true;
      if (p.chips === 0) p.allIn = true;
      broadcastLog(`${p.name} callt ${a}.`);
      break;
    }

    case 'raise': {
      const total = Math.min(raiseAmount, p.chips + p.bet);
      const added = total - p.bet;
      if (added <= 0) return;
      p.chips -= added; p.bet = total; s.pot += added;
      s.currentBet = total; p.acted = true;
      if (p.chips === 0) p.allIn = true;
      for (const op of s.players)
        if (op !== p && !op.folded && !op.eliminated && !op.allIn) op.acted = false;
      broadcastLog(`${p.name} raised auf ${total}.`, true);
      break;
    }

    case 'allin': {
      const all = p.chips;
      p.bet += all; s.pot += all; p.chips = 0; p.allIn = true; p.acted = true;
      if (p.bet > s.currentBet) {
        s.currentBet = p.bet;
        for (const op of s.players)
          if (op !== p && !op.folded && !op.eliminated && !op.allIn) op.acted = false;
      }
      broadcastLog(`${p.name} geht ALL IN mit ${p.bet}!`, true);
      break;
    }
  }
  advanceAction();
}

/* ── Showdown ────────────────────────────────────────────── */
function showdown() {
  const s = G;
  s.phase = 'showdown';
  const active = activePlayers();
  broadcastLog('--- Showdown ---', true);

  let best = -1, winners = [];
  for (const p of active) {
    p.handScore = fullHandEval(p.cards, s.community);
    p.handName  = getHandName(p.cards, s.community);
    broadcastLog(`${p.name}: ${p.handName}`);
    if (p.handScore > best)         { best = p.handScore; winners = [p]; }
    else if (p.handScore === best)    winners.push(p);
  }
  awardPot(winners);
}

function awardPot(winners) {
  const s = G;
  const share = Math.floor(s.pot / winners.length);
  for (const w of winners) {
    w.chips += share;
    broadcastLog(`${w.name} gewinnt ${share} Chips!`, false, true);
  }
  s.pot = 0; s.phase = 'done';

  for (const p of s.players)
    if (p.chips <= 0 && !p.eliminated) {
      p.eliminated = true; p.folded = true;
      broadcastLog(`${p.name} ist eliminiert!`);
    }

  broadcastState();
  const alive = s.players.filter(p => !p.eliminated);
  if (alive.length < 2) { setTimeout(() => showGameOver(alive[0]), 600); return; }
  botTimer = setTimeout(() => startRound(), 2200);
}

/* ══════════════════════════════════════════════════════════
   BOT AI
══════════════════════════════════════════════════════════ */
function doBotAction() {
  if (!G || G.actionLock) return;
  const s = G, p = s.players[s.activeIdx];
  if (!p || p.folded || p.eliminated || !p.isBot) return;

  const hs       = evalBotHand(p.cards, s.community);
  const toCall   = s.currentBet - p.bet;
  const canCheck = toCall <= 0;
  const potOdds  = s.pot > 0 ? toCall / (s.pot + toCall) : 0;
  const action   = decideBotAction(p.strength, hs, toCall, canCheck, potOdds);

  let raiseAmt = 0;
  if (action === 'raise') {
    const mult = {weak:1.5, medium:2, strong:2.5, expert:3}[p.strength || 'medium'];
    raiseAmt = Math.min(
      p.chips + p.bet,
      Math.max(s.currentBet + s.bb, Math.round(s.currentBet * mult + rand(Math.max(1, Math.floor(s.pot / 4)))))
    );
  }
  applyAction(action, raiseAmt);
}

function evalBotHand(cards, community) {
  if (!cards || cards.length < 2) return 0;
  let score = (cards[0].val + cards[1].val) / 28;
  if (cards[0].val === cards[1].val)      score += 0.3;
  if (cards[0].suit === cards[1].suit)    score += 0.1;
  if (Math.abs(cards[0].val - cards[1].val) <= 2) score += 0.1;

  if (community.length >= 3) {
    const all  = [...cards, ...community];
    const vals = all.map(c => c.val);
    const smap = {};
    for (const c of all) smap[c.suit] = (smap[c.suit] || 0) + 1;
    const cnt = {};
    for (const v of vals) cnt[v] = (cnt[v] || 0) + 1;
    const g = Object.values(cnt).sort((a, b) => b - a);

    if      (g[0] >= 4)              score = 0.95;
    else if (g[0] >= 3 && g[1] >= 2) score = 0.88;
    else if (Math.max(...Object.values(smap)) >= 5) score = Math.max(score, 0.82);
    else if (g[0] >= 3)              score = Math.max(score, 0.75);
    else if (g[0] >= 2 && g[1] >= 2) score = Math.max(score, 0.55);
    else if (g[0] >= 2)              score = Math.max(score, 0.40);
  }
  return Math.min(1, score);
}

function decideBotAction(strength, hs, toCall, canCheck, potOdds) {
  const bluff = {weak:0.05, medium:0.12, strong:0.20, expert:0.28}[strength];
  const agg   = {weak:0.30, medium:0.50, strong:0.70, expert:0.85}[strength];
  const isB   = Math.random() < bluff;
  const eff   = isB ? Math.min(1, hs + 0.4) : hs;

  switch (strength) {
    case 'weak':
      if (canCheck) return Math.random() < 0.7 ? 'check' : (eff > 0.5 ? 'raise' : 'check');
      if (eff > 0.6) return 'call';
      if (eff > 0.3 && potOdds < 0.3) return 'call';
      return Math.random() < 0.4 ? 'call' : 'fold';
    case 'medium':
      if (canCheck) return (eff > 0.65 && Math.random() < agg) ? 'raise' : 'check';
      if (eff > 0.7 && Math.random() < agg) return 'raise';
      return (eff > 0.45 || potOdds < 0.25) ? 'call' : 'fold';
    case 'strong':
      if (canCheck) return (eff > 0.55 && Math.random() < agg) ? 'raise' : 'check';
      if (eff > 0.75 && Math.random() < agg) return 'raise';
      return (eff > 0.38 || potOdds < 0.22) ? 'call' : 'fold';
    default: // expert
      if (canCheck) {
        if (eff > 0.5 && Math.random() < agg) return 'raise';
        if (isB && Math.random() < 0.35) return 'raise';
        return 'check';
      }
      if (eff > 0.8 && Math.random() < agg) return 'raise';
      if (eff > 0.35 || potOdds < 0.2) return 'call';
      if (isB && Math.random() < 0.4) return 'raise';
      return 'fold';
  }
}

/* ══════════════════════════════════════════════════════════
   HUMAN ACTION ENTRY POINT
══════════════════════════════════════════════════════════ */
function humanAction(type) {
  if (!G) return;
  const myIdx = myPlayerIndex();
  if (G.activeIdx !== myIdx) return;
  const p = G.players[myIdx];
  if (!p || p.folded || p.eliminated || p.allIn) return;

  let raiseAmt = 0;
  if (type === 'raise') {
    raiseAmt = parseInt(document.getElementById('raiseInput')?.value || 0, 10);
    const minRaise = G.currentBet + G.bb;
    if (isNaN(raiseAmt) || raiseAmt < minRaise) {
      alert(`Minimum Raise: ${minRaise}`); return;
    }
  }

  if (net.mode === 'guest') {
    guestSendAction(type, raiseAmt);
  } else {
    applyAction(type, raiseAmt);
  }
}

function myPlayerIndex() {
  if (!G) return -1;
  if (net.mode === 'solo') return 0;
  // host and guest: match by peerId
  const idx = G.players.findIndex(p => p.peerId === net.myId);
  return idx >= 0 ? idx : -1;
}

/* ══════════════════════════════════════════════════════════
   HAND EVALUATOR

   Each tier occupies exactly one million:
     9M       = Royal Flush
     8M+hi    = Straight Flush   (hi ≤ 14)
     7M+b15   = Four of a Kind   (b15 ≤ 224)
     6M+b15   = Full House       (b15 ≤ 224)
     5M+b15   = Flush            (b15 ≤ 755 500)
     4M+hi    = Straight         (hi ≤ 14)
     3M+b15   = Three of a Kind  (b15 ≤ 3 357)
     2M+b15   = Two Pair         (b15 ≤ 3 357)
     1M+b15   = One Pair         (b15 ≤ 50 459)
     0+b15    = High Card        (b15 ≤ 755 500 < 1M)  ✓ no overlap
══════════════════════════════════════════════════════════ */
function createDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank:r, suit:s, val:RANK_VAL[r] });
  return shuffle(d);
}

// base-15 encoder — converts an ordered array of card values into a
// single integer tiebreaker.  Max for 5 cards = 755 500 < 1 000 000.
function b15(vals) {
  let r = 0;
  for (const v of vals) r = r * 15 + v;
  return r;
}

// All k-combinations of arr (non-recursive generator style)
function kCombos(arr, k) {
  const result = [];
  function pick(start, chosen) {
    if (chosen.length === k) { result.push([...chosen]); return; }
    for (let i = start; i < arr.length; i++) {
      chosen.push(arr[i]); pick(i + 1, chosen); chosen.pop();
    }
  }
  pick(0, []);
  return result;
}

// Score exactly 5 cards.  Returns an integer where higher = better hand.
function scoreHand5(cards) {
  const s = [...cards].sort((a, b) => b.val - a.val);
  const vals  = s.map(c => c.val);
  const suits = s.map(c => c.suit);

  const isFlush = suits.every(x => x === suits[0]);
  const strHi   = straightHigh(vals);   // high-card value or false

  // ── Straight flush / Royal flush ──────────────────────
  if (isFlush && strHi !== false) {
    if (strHi === 14 && vals[4] === 10) return 9_000_000;   // Royal
    return 8_000_000 + strHi;
  }

  // ── Rank-count groups ─────────────────────────────────
  const cnt = {};
  for (const v of vals) cnt[v] = (cnt[v] || 0) + 1;
  const grp = Object.entries(cnt)
    .map(([v, c]) => ({ v: +v, c }))
    .sort((a, b) => b.c - a.c || b.v - a.v);
  const g = grp.map(x => x.c);

  if (g[0] === 4)              return 7_000_000 + b15([grp[0].v, grp[1].v]);
  if (g[0] === 3 && g[1] === 2) return 6_000_000 + b15([grp[0].v, grp[1].v]);
  if (isFlush)                 return 5_000_000 + b15(vals);
  if (strHi !== false)         return 4_000_000 + strHi;

  if (g[0] === 3) {
    const k = grp.filter(x => x.c === 1).map(x => x.v);
    return 3_000_000 + b15([grp[0].v, k[0], k[1]]);
  }
  if (g[0] === 2 && g[1] === 2) {
    const pairs = grp.filter(x => x.c === 2).map(x => x.v).sort((a, b) => b - a);
    const kick  = grp.filter(x => x.c === 1).map(x => x.v);
    return 2_000_000 + b15([pairs[0], pairs[1], kick[0]]);
  }
  if (g[0] === 2) {
    const k = grp.filter(x => x.c === 1).map(x => x.v).sort((a, b) => b - a);
    return 1_000_000 + b15([grp[0].v, k[0], k[1], k[2]]);
  }
  return b15(vals);   // High card (max 755 500 < 1 000 000 — no tier bleed)
}

// Returns the high-card rank of a straight in a 5-card descending sorted
// value array, or false if no straight.
function straightHigh(sv) {
  // Normal: five consecutive ranks, all distinct
  if (sv[0] - sv[4] === 4 && new Set(sv).size === 5) return sv[0];
  // Wheel: A-2-3-4-5  (sv[0]=14, lowest four are 5-4-3-2)
  if (sv[0] === 14 && sv[1] === 5 && sv[2] === 4 && sv[3] === 3 && sv[4] === 2) return 5;
  return false;
}

function fullHandEval(hole, community) {
  const all = [...hole, ...community];
  if (all.length < 5) return simpleScore(hole);
  return kCombos(all, 5).reduce((best, combo) => Math.max(best, scoreHand5(combo)), -1);
}

function simpleScore(cards) {
  if (!cards || cards.length < 2) return 0;
  return (cards[0].val + cards[1].val) * 100 + (cards[0].val === cards[1].val ? 10000 : 0);
}

function getHandName(hole, community) {
  const all = [...hole, ...community];
  if (all.length < 5) {
    if (hole[0] && hole[1] && hole[0].val === hole[1].val) return `Paar ${hole[0].rank}`;
    return hole[0] ? `${hole[0].rank} High` : '?';
  }
  const sc = fullHandEval(hole, community);
  if (sc >= 9_000_000) return 'Royal Flush';
  if (sc >= 8_000_000) return 'Straight Flush';
  if (sc >= 7_000_000) return 'Vierling';
  if (sc >= 6_000_000) return 'Full House';
  if (sc >= 5_000_000) return 'Flush';
  if (sc >= 4_000_000) return 'Straße';
  if (sc >= 3_000_000) return 'Drilling';
  if (sc >= 2_000_000) return 'Zwei Paare';
  if (sc >= 1_000_000) return 'Ein Paar';
  return 'High Card';
}

function quickHint(cards, community) {
  if (!cards || cards.length < 2) return '';
  if (!community || community.length === 0) {
    if (cards[0].val === cards[1].val) return `Paar ${cards[0].rank}`;
    const suited = cards[0].suit === cards[1].suit ? ' suited' : '';
    return `${cards[0].rank}${cards[1].rank}${suited}`;
  }
  return getHandName(cards, community);
}

/* ══════════════════════════════════════════════════════════
   RENDER
══════════════════════════════════════════════════════════ */
function render() {
  if (!G) return;
  renderOpponents();
  renderCommunity();
  document.getElementById('potDisplay').textContent  = `Pot: ${G.pot}`;
  document.getElementById('phaseLabel').textContent  = PHASE_LABELS[G.phase] || '';
  renderMyArea();
}

function renderOpponents() {
  const s = G;
  const myIdx = myPlayerIndex();
  const isShowdown = s.phase === 'showdown' || s.phase === 'done';

  document.getElementById('botRow').innerHTML = s.players
    .map((p, pi) => ({ p, pi }))
    .filter(({ pi }) => pi !== myIdx)
    .map(({ p, pi }) => {
      const isActive  = s.activeIdx === pi && s.phase !== 'done' && s.phase !== 'idle';
      const showCards = isShowdown && !p.folded;
      const isDealer  = pi === s.dealerIdx;
      const isPeer    = p.isHuman && !p.isBot;

      let cls = 'player-info';
      if      (p.eliminated) cls += ' eliminated';
      else if (p.folded)     cls += ' folded';
      else if (isActive)     cls += ' active';
      if (isPeer)            cls += ' human-peer';

      const cardsHtml = p.cards.length
        ? (showCards ? p.cards.map(c => smallCard(c)).join('') : smallCard(null, true) + smallCard(null, true))
        : '';
      const betTxt    = p.bet > 0 ? `<div class="player-bet">Bet: ${p.bet}</div>` : '';
      const statusTxt = p.allIn
        ? '<div class="player-status">ALL IN</div>'
        : (p.folded && !p.eliminated ? '<div class="player-status">Fold</div>' : '');
      const handTxt   = showCards && p.handName ? `<div class="player-status">${p.handName}</div>` : '';
      const tag       = isPeer ? '<div class="peer-tag">👤 Online</div>' : (p.isBot ? '<div class="peer-tag">🤖 Bot</div>' : '');

      return `<div class="player-slot">
        <div class="bot-cards">${cardsHtml}</div>
        <div class="${cls}">
          <div class="player-name">${p.name}${isDealer ? dealerBadge() : ''}</div>
          <div class="player-chips">💰 ${p.chips}</div>
          ${betTxt}${statusTxt}${handTxt}${tag}
        </div>
      </div>`;
    }).join('');
}

function renderCommunity() {
  const cards = [...G.community];
  while (cards.length < 5) cards.push(null);
  document.getElementById('communityCards').innerHTML = cards.map(commCard).join('');
}

function renderMyArea() {
  const s = G;
  const myIdx = myPlayerIndex();
  const pa = document.getElementById('playerArea');

  if (myIdx < 0) {
    pa.className = 'player-area';
    pa.innerHTML = '<div class="idle-msg">Verbunden – warte auf Platz…</div>';
    return;
  }

  const human      = s.players[myIdx];
  const isShowdown = s.phase === 'showdown' || s.phase === 'done';
  const isDealer   = s.dealerIdx === myIdx;

  if (human.eliminated) {
    pa.className = 'player-area';
    pa.innerHTML = '<div class="idle-msg">Du bist ausgeschieden.</div>';
    return;
  }

  const isMyTurn = s.activeIdx === myIdx && !human.folded && !human.allIn
    && s.phase !== 'done' && s.phase !== 'showdown' && s.phase !== 'idle';
  const toCall   = s.currentBet - human.bet;
  const canCheck = toCall <= 0;

  const hint     = isShowdown ? getHandName(human.cards, s.community) : quickHint(human.cards, s.community);
  const handHtml = hint ? `<div class="hand-rank">${hint}</div>` : '';
  const betHtml  = human.bet > 0 ? `<div class="my-bet">Dein Bet: ${human.bet}</div>` : '';
  const allInBadge = human.allIn ? '<span class="status-allin">ALL IN</span>' : '';

  const minRaiseTo = Math.min(human.chips + human.bet, s.currentBet + s.bb * 2);
  const maxRaiseTo = human.chips + human.bet;

  let actionsHtml = '';
  if (isMyTurn) {
    actionsHtml = `<div class="actions">
      <button class="btn btn-fold"  onclick="humanAction('fold')">Fold</button>
      ${canCheck
        ? `<button class="btn btn-check" onclick="humanAction('check')">Check</button>`
        : `<button class="btn btn-call"  onclick="humanAction('call')">Call ${toCall}</button>`}
      <input class="raise-input" id="raiseInput" type="number"
        value="${minRaiseTo}" min="${minRaiseTo}" max="${maxRaiseTo}" step="${s.bb}" />
      <button class="btn btn-raise" onclick="humanAction('raise')">Raise</button>
      <button class="btn btn-allin" onclick="humanAction('allin')">All In</button>
    </div>`;
  } else {
    const waitMsg = human.folded ? 'Gefoldet'
      : (human.allIn ? 'All In – warte…' : 'Warte auf andere…');
    actionsHtml = `<div class="action-wait">${waitMsg}</div>`;
  }

  pa.className = 'player-area' + (isMyTurn ? ' active-turn' : '');
  pa.innerHTML = `
    <div class="my-cards">${human.cards.map(bigCard).join('')}</div>
    <div class="player-stats">
      <div class="player-label">${human.name}${isDealer ? dealerBadge() : ''}</div>
      <div class="my-chips">💰 ${human.chips} Chips</div>
      ${betHtml}${allInBadge}${handHtml}
      ${actionsHtml}
    </div>`;
}

/* ── Overlay & Log ───────────────────────────────────────── */
function showGameOver(winner) {
  const isMe = winner && (winner.peerId === net.myId || winner.peerId === 'local');
  const o = document.getElementById('messageOverlay');
  o.style.display = 'flex';
  o.innerHTML = `
    <div class="message-text">🏆 ${winner ? winner.name : '?'} gewinnt alles!</div>
    <div class="message-sub">${isMe ? 'Herzlichen Glückwunsch!' : 'Besser beim nächsten Mal!'}</div>
    <button class="btn btn-deal" style="margin-top:12px" onclick="backToLobby()">Zur Lobby</button>`;
  if (G) G.phase = 'idle';
  if (net.mode === 'host') broadcastState();
}

function hideOverlay() {
  const o = document.getElementById('messageOverlay');
  o.style.display = 'none'; o.innerHTML = '';
}

function log(msg, important = false, win = false, net_ = false) {
  const la = document.getElementById('logArea');
  if (!la) return;
  const div = document.createElement('div');
  div.className = 'log-entry'
    + (important ? ' important' : '')
    + (win       ? ' win'       : '')
    + (net_      ? ' net'       : '');
  div.textContent = msg;
  la.appendChild(div);
  la.scrollTop = la.scrollHeight;
  if (la.children.length > 60) la.removeChild(la.firstChild);
}

/* ── Boot ────────────────────────────────────────────────── */
(function boot() {
  showScreen('lobby');
  switchTab('solo');
}());
