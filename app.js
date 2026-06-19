/* =========================================================
   Texas Hold'em Poker – app.js
   Solo (vs Bots) + P2P Multiplayer via PeerJS
   ========================================================= */
'use strict';

/* ── Constants ───────────────────────────────────────────── */
const SUITS     = ['♠','♥','♦','♣'];
const RANKS     = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL  = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
const BOT_NAMES = ['Nova','Rex','Jade','Blaze','Ace'];
const BLINDS_MAP = {
  low:{sb:10,bb:20}, med:{sb:25,bb:50}, high:{sb:50,bb:100}, turbo:{sb:100,bb:200}
};
const PHASE_LABELS = {
  preflop:'Pre-Flop', flop:'Flop', turn:'Turn',
  river:'River', showdown:'Showdown', done:'Hand beendet', idle:''
};
const START_CHIPS = 1000;

/* ── Global state ────────────────────────────────────────── */
let G        = null;   // game state; only host/solo writes to it
let botTimer = null;

/* ── Network state ───────────────────────────────────────── */
let net = {
  mode:'solo',          // 'solo' | 'host' | 'guest'
  peer:null,
  myId:null,            // 'local' in solo, PeerJS id in multi
  roomCode:null,
  conns:{},             // peerId→conn  (host)
  hostConn:null,        // conn→host    (guest)
  myName:'Du',
  guestSeats:[],        // [{peerId,name,conn}]  (host)
};

/* ── Utilities ───────────────────────────────────────────── */
const rand    = n => Math.floor(Math.random() * n);
const shuffle = arr => {
  const a = [...arr];
  for (let i = a.length-1; i>0; i--) {
    const j = rand(i+1); [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
};
const genCode = () =>
  Array.from({length:6}, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[rand(32)]).join('');

/* ══════════════════════════════════════════════════════════
   UI HELPERS
══════════════════════════════════════════════════════════ */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tabSolo').style.display  = tab==='solo'  ? 'block' : 'none';
  document.getElementById('tabMulti').style.display = tab==='multi' ? 'block' : 'none';
}

function showScreen(id) {
  document.getElementById('lobbyScreen').style.display = id==='lobby' ? 'flex' : 'none';
  document.getElementById('gameScreen').style.display  = id==='game'  ? 'flex'  : 'none';
}

function setNetStatus(msg, cls='') {
  const el = document.getElementById('netStatus');
  el.textContent = msg; el.className = 'net-status '+cls;
}

function backToLobby() {
  clearTimeout(botTimer);
  if (net.peer) { try { net.peer.destroy(); } catch(e){} net.peer = null; }
  net = {
    mode:'solo', peer:null, myId:null, roomCode:null,
    conns:{}, hostConn:null,
    myName: document.getElementById('playerName')?.value || 'Du',
    guestSeats:[]
  };
  G = null;
  document.getElementById('logArea').innerHTML = '';
  const ov = document.getElementById('messageOverlay');
  ov.style.display='none'; ov.innerHTML='';
  showScreen('lobby');
}

/* ── Card HTML helpers ───────────────────────────────────── */
const cardColor   = s => (s==='♥'||s==='♦') ? 'red' : '';
const smallCard   = (c, hidden=false) => hidden
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

  // Reset net to a clean solo state
  net.mode  = 'solo';
  net.myId  = 'local';
  net.myName = 'Du';

  document.getElementById('gameModeBadge').textContent = '🤖 Solo';
  setNetStatus('');
  showScreen('game');
  document.getElementById('logArea').innerHTML = '';

  const numBots  = parseInt(document.getElementById('numBots').value, 10);
  const strength = document.getElementById('botStrength').value;
  const {sb,bb}  = BLINDS_MAP[document.getElementById('blindsLevel').value] || BLINDS_MAP.med;

  // Build fresh game state
  G = {
    players:[], deck:[], community:[],
    pot:0, phase:'idle', currentBet:0,
    dealerIdx:0, activeIdx:-1,
    sb, bb, roundNum:0, actionLock:false
  };

  // Seat 0 = human player
  G.players.push(mkPlayer('Du', 'local', false));
  for (let i=0; i<numBots; i++)
    G.players.push(mkPlayer(BOT_NAMES[i], 'bot-'+BOT_NAMES[i], true, strength));

  hideOverlay();
  // Show deal button (don't call full render — just put the button in place)
  paintDealButton();
}

/* ══════════════════════════════════════════════════════════
   MULTIPLAYER – PeerJS P2P
══════════════════════════════════════════════════════════ */
function createRoom() {
  const name = (document.getElementById('playerName').value || 'Host').trim();
  net.myName = name; net.mode = 'host';
  net.roomCode = genCode(); net.guestSeats = [];

  document.getElementById('roomCodeDisplay').style.display = 'flex';
  document.getElementById('roomCodeValue').textContent = net.roomCode;
  document.getElementById('waitingPlayers').textContent = 'Verbinde…';

  net.peer = new Peer('poker-'+net.roomCode, {debug:0});
  net.peer.on('open', id => {
    net.myId = id;
    document.getElementById('waitingPlayers').textContent = `${name} (Du) wartet…`;
    addLog(`Raum ${net.roomCode} erstellt.`, false, false, true);
  });
  net.peer.on('connection', conn => {
    conn.on('open', () => {
      const guestName = conn.metadata?.name || conn.peer;
      net.guestSeats.push({peerId:conn.peer, name:guestName, conn});
      net.conns[conn.peer] = conn;
      refreshWaitingList();
      addLog(`${guestName} ist beigetreten.`, false, false, true);
      conn.on('data',  msg => hostReceive(msg, conn.peer));
      conn.on('close', () => {
        net.guestSeats = net.guestSeats.filter(s => s.peerId !== conn.peer);
        delete net.conns[conn.peer];
        refreshWaitingList();
        addLog(`${guestName} hat getrennt.`, false, false, true);
        if (G) pushState();
      });
      document.getElementById('startMultiBtn').disabled = false;
    });
  });
  net.peer.on('error', e => {
    document.getElementById('waitingPlayers').textContent = 'Fehler: '+e.type;
  });
}

function refreshWaitingList() {
  const names = [net.myName+' (Du)', ...net.guestSeats.map(s=>s.name)];
  document.getElementById('waitingPlayers').textContent =
    `Spieler (${names.length}): ${names.join(', ')}`;
  document.getElementById('startMultiBtn').disabled = net.guestSeats.length < 1;
}

function startMultiGame() {
  const {sb,bb} = BLINDS_MAP[document.getElementById('mBlindLevel').value] || BLINDS_MAP.med;
  const numBots = parseInt(document.getElementById('mBots').value, 10);

  G = {
    players:[], deck:[], community:[],
    pot:0, phase:'idle', currentBet:0,
    dealerIdx:0, activeIdx:-1,
    sb, bb, roundNum:0, actionLock:false
  };
  G.players.push(mkPlayer(net.myName, net.myId, false));
  net.guestSeats.forEach(s => G.players.push(mkPlayer(s.name, s.peerId, false)));
  for (let i=0; i<numBots; i++)
    G.players.push(mkPlayer(BOT_NAMES[i], 'bot-'+BOT_NAMES[i], true, 'medium'));

  document.getElementById('gameModeBadge').textContent = '🌐 Multiplayer';
  setNetStatus(`Host · ${net.roomCode}`, 'ok');
  showScreen('game');
  document.getElementById('logArea').innerHTML = '';
  hideOverlay();

  // Notify guests
  const startMsg = {type:'gameStart', players:G.players.map(p=>({name:p.name,peerId:p.peerId}))};
  Object.values(net.conns).forEach(c => { try{c.send(startMsg);}catch(e){} });

  startRound();
}

function joinRoom() {
  const code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
  if (code.length!==6) { setJoinStatus('6-stelligen Code eingeben.','error'); return; }
  const name = (document.getElementById('playerName').value||'Gast').trim();
  net.myName=name; net.mode='guest'; net.roomCode=code;
  setJoinStatus('Verbinde…');
  net.peer = new Peer(undefined, {debug:0});
  net.peer.on('open', id => {
    net.myId = id;
    const conn = net.peer.connect('poker-'+code, {metadata:{name}, reliable:true});
    net.hostConn = conn;
    conn.on('open',  ()  => setJoinStatus('Verbunden! Warte auf Spielstart…','ok'));
    conn.on('data',  msg => guestReceive(msg));
    conn.on('close', ()  => { setJoinStatus('Verbindung getrennt.','error'); setNetStatus('Getrennt','error'); });
    conn.on('error', e   => setJoinStatus('Fehler: '+e,'error'));
  });
  net.peer.on('error', e => setJoinStatus('Fehler: '+e.type,'error'));
}

function setJoinStatus(msg, cls='') {
  const el = document.getElementById('joinStatus');
  el.textContent=msg; el.className='join-status '+cls;
}

/* ── Host receives action from a guest ───────────────────── */
function hostReceive(msg, fromPeer) {
  if (!G || net.mode!=='host') return;
  if (msg.type==='action') {
    const seat = G.players.findIndex(p => p.peerId===fromPeer);
    if (seat<0 || G.activeIdx!==seat) return;
    applyAction(msg.action, msg.raiseAmount||0);
  }
}

/* ── Guest receives state + logs from host ───────────────── */
function guestReceive(msg) {
  if (msg.type==='gameStart') {
    document.getElementById('gameModeBadge').textContent = '🌐 Multiplayer';
    setNetStatus(`Gast · ${net.roomCode}`, 'ok');
    showScreen('game');
    document.getElementById('logArea').innerHTML = '';
    hideOverlay();
    addLog(`Spiel gestartet! Spieler: ${msg.players.map(p=>p.name).join(', ')}`,false,false,true);
  }
  if (msg.type==='state') { G = msg.state; render(); }
  if (msg.type==='log')   { addLog(msg.msg, msg.important, msg.win); }
}

/* ── Push state to all guests + render locally ───────────── */
function pushState() {
  render();
  if (net.mode!=='host') return;
  const msg = {type:'state', state:G};
  Object.values(net.conns).forEach(c => { try{c.send(msg);}catch(e){} });
}

function pushLog(msg, important=false, win=false) {
  addLog(msg, important, win);
  if (net.mode!=='host') return;
  const pkt = {type:'log', msg, important, win};
  Object.values(net.conns).forEach(c => { try{c.send(pkt);}catch(e){} });
}

/* ── Guest sends action to host ──────────────────────────── */
function guestSendAction(action, raiseAmount=0) {
  if (net.hostConn) net.hostConn.send({type:'action', action, raiseAmount});
}

/* ══════════════════════════════════════════════════════════
   PLAYER FACTORY
══════════════════════════════════════════════════════════ */
function mkPlayer(name, peerId, isBot, strength='medium') {
  return {
    name, peerId, isBot,
    chips:START_CHIPS, bet:0,
    folded:false, allIn:false, eliminated:false, acted:false,
    cards:[], handScore:0, handName:'', strength
  };
}

/* ══════════════════════════════════════════════════════════
   GAME LOGIC  (solo + host only)
══════════════════════════════════════════════════════════ */
function startRound() {
  clearTimeout(botTimer);
  if (!G) return;

  const alive = G.players.filter(p => !p.eliminated);
  if (alive.length < 2) { showGameOver(alive[0]); return; }

  G.roundNum   = (G.roundNum||0)+1;
  G.deck       = createDeck();
  G.community  = [];
  G.pot        = 0;
  G.currentBet = 0;
  G.phase      = 'preflop';
  G.actionLock = false;

  // Reset all players for new hand
  for (const p of G.players) {
    p.bet=0; p.folded=p.eliminated; p.allIn=false;
    p.cards=[]; p.acted=false; p.handScore=0; p.handName='';
  }

  // Deal 2 cards to each non-eliminated player
  const inGame = G.players.filter(p => !p.eliminated);
  for (let i=0; i<2; i++) for (const p of inGame) p.cards.push(G.deck.pop());

  // Advance dealer button (wraps through alive players only)
  const aliveIdxs = G.players.reduce((a,p,i) => { if(!p.eliminated) a.push(i); return a; }, []);
  let di = aliveIdxs.indexOf(G.dealerIdx);
  if (di<0) di=0; // safety
  di = (di+1) % aliveIdxs.length;
  G.dealerIdx = aliveIdxs[di];

  // Post blinds
  const sbIdx = nextAlive(G.dealerIdx);
  const bbIdx = nextAlive(sbIdx);
  postBlind(sbIdx, G.sb);
  postBlind(bbIdx, G.bb);
  G.currentBet = G.bb;

  // First to act pre-flop: UTG (player after BB)
  // Reset acted BEFORE setting activeIdx, so advanceAction works cleanly
  for (const p of G.players) p.acted = false;
  G.activeIdx = nextAlive(bbIdx);

  pushLog(`--- Runde ${G.roundNum} --- Dealer: ${G.players[G.dealerIdx].name} ---`);
  pushLog(`${G.players[sbIdx].name} postet SB ${G.sb}. ${G.players[bbIdx].name} postet BB ${G.bb}.`, true);

  // Render the current state, then hand off to action loop
  pushState();
  scheduleNext();
}

function postBlind(idx, amount) {
  const p = G.players[idx];
  const a = Math.min(amount, p.chips);
  p.chips-=a; p.bet+=a; G.pot+=a;
  if (p.chips===0) p.allIn=true;
}

// Returns the index of the next non-folded, non-eliminated player after `from`
function nextAlive(from) {
  let idx = (from+1) % G.players.length;
  for (let t=0; t<G.players.length; t++) {
    if (!G.players[idx].folded && !G.players[idx].eliminated) return idx;
    idx = (idx+1) % G.players.length;
  }
  return from; // fallback (shouldn't happen in a real game)
}

const activePlayers = () => G.players.filter(p => !p.folded && !p.eliminated);

/* ── scheduleNext: decide who acts next ──────────────────── */
function scheduleNext() {
  if (!G || G.actionLock) return;
  const p = G.players[G.activeIdx];

  // Skip players who can't act
  if (!p || p.folded || p.eliminated || p.allIn || p.chips===0) {
    advanceTurn(); return;
  }

  if (p.isBot) {
    // Schedule bot move with a small delay for realism
    botTimer = setTimeout(doBotMove, 700 + rand(600));
  }
  // If human: render() already shows the action buttons — nothing else needed
}

/* ── advanceTurn: find next player or move to next phase ─── */
function advanceTurn() {
  const active  = activePlayers();
  if (active.length===1) { awardPot(active); return; }

  const canAct  = active.filter(p => !p.allIn && p.chips>0);
  const allDone = canAct.length===0 || canAct.every(p => p.acted && p.bet>=G.currentBet);
  if (allDone) { nextPhase(); return; }

  // Walk forward from current seat to find who still needs to act
  let idx = (G.activeIdx+1) % G.players.length;
  for (let t=0; t<G.players.length; t++) {
    const p = G.players[idx];
    if (!p.folded && !p.eliminated && !p.allIn && p.chips>0 && (!p.acted || p.bet<G.currentBet)) {
      G.activeIdx = idx;
      pushState();
      scheduleNext();
      return;
    }
    idx = (idx+1) % G.players.length;
  }
  nextPhase();
}

function nextPhase() {
  // Reset bets and acted flags for new street
  for (const p of G.players) { p.bet=0; p.acted=false; }
  G.currentBet = 0;

  if      (G.phase==='preflop') { G.phase='flop';  G.community.push(G.deck.pop(),G.deck.pop(),G.deck.pop()); pushLog('--- Flop ---',true); }
  else if (G.phase==='flop')    { G.phase='turn';  G.community.push(G.deck.pop()); pushLog('--- Turn ---',true); }
  else if (G.phase==='turn')    { G.phase='river'; G.community.push(G.deck.pop()); pushLog('--- River ---',true); }
  else if (G.phase==='river')   { showdown(); return; }

  G.activeIdx = nextAlive(G.dealerIdx);
  pushState();
  scheduleNext();
}

/* ── Central action handler (called by both human + bot) ─── */
function applyAction(type, raiseAmount=0) {
  if (!G) return;
  const p      = G.players[G.activeIdx];
  if (!p || p.folded || p.eliminated) return;
  const toCall = G.currentBet - p.bet;

  switch (type) {
    case 'fold':
      p.folded=true; p.acted=true;
      pushLog(`${p.name} foldet.`);
      break;

    case 'check':
      if (toCall>0) return; // illegal — ignore
      p.acted=true;
      pushLog(`${p.name} checkt.`);
      break;

    case 'call': {
      const a = Math.min(toCall, p.chips);
      p.chips-=a; p.bet+=a; G.pot+=a; p.acted=true;
      if (p.chips===0) p.allIn=true;
      pushLog(`${p.name} callt ${a}.`);
      break;
    }

    case 'raise': {
      // raiseAmount = total amount player puts in (not just the added chips)
      const total = Math.min(raiseAmount, p.chips+p.bet);
      const added = total - p.bet;
      if (added<=0) return;
      p.chips-=added; p.bet=total; G.pot+=added;
      G.currentBet=total; p.acted=true;
      if (p.chips===0) p.allIn=true;
      // Reopen action for everyone else who can still act
      for (const op of G.players)
        if (op!==p && !op.folded && !op.eliminated && !op.allIn) op.acted=false;
      pushLog(`${p.name} raised auf ${total}.`, true);
      break;
    }

    case 'allin': {
      const all = p.chips;
      p.bet+=all; G.pot+=all; p.chips=0; p.allIn=true; p.acted=true;
      if (p.bet>G.currentBet) {
        G.currentBet=p.bet;
        for (const op of G.players)
          if (op!==p && !op.folded && !op.eliminated && !op.allIn) op.acted=false;
      }
      pushLog(`${p.name} geht ALL IN mit ${p.bet}!`, true);
      break;
    }

    default: return;
  }
  advanceTurn();
}

/* ── Showdown ────────────────────────────────────────────── */
function showdown() {
  G.phase = 'showdown';
  const active = activePlayers();
  pushLog('--- Showdown ---', true);

  let best=-1, winners=[];
  for (const p of active) {
    p.handScore = fullHandEval(p.cards, G.community);
    p.handName  = getHandName(p.cards, G.community);
    pushLog(`${p.name}: ${p.handName}`);
    if      (p.handScore>best)  { best=p.handScore; winners=[p]; }
    else if (p.handScore===best)  winners.push(p);
  }
  awardPot(winners);
}

function awardPot(winners) {
  const share = Math.floor(G.pot/winners.length);
  for (const w of winners) { w.chips+=share; pushLog(`${w.name} gewinnt ${share} Chips!`,false,true); }
  G.pot=0; G.phase='done';

  for (const p of G.players)
    if (p.chips<=0 && !p.eliminated) {
      p.eliminated=true; p.folded=true;
      pushLog(`${p.name} ist eliminiert!`);
    }

  pushState();
  const alive = G.players.filter(p=>!p.eliminated);
  if (alive.length<2) { setTimeout(()=>showGameOver(alive[0]),600); return; }
  botTimer = setTimeout(startRound, 2200);
}

/* ══════════════════════════════════════════════════════════
   BOT AI
══════════════════════════════════════════════════════════ */
function doBotMove() {
  if (!G) return;
  const p = G.players[G.activeIdx];
  if (!p || p.folded || p.eliminated || !p.isBot) return;

  const hs      = evalBotHand(p.cards, G.community);
  const toCall  = G.currentBet - p.bet;
  const canChk  = toCall<=0;
  const potOdds = G.pot>0 ? toCall/(G.pot+toCall) : 0;
  const action  = decideBotAction(p.strength, hs, toCall, canChk, potOdds);

  let raiseAmt = 0;
  if (action==='raise') {
    const mult = {weak:1.5,medium:2,strong:2.5,expert:3}[p.strength||'medium'];
    raiseAmt = Math.min(
      p.chips+p.bet,
      Math.max(G.currentBet+G.bb,
        Math.round(G.currentBet*mult + rand(Math.max(1,Math.floor(G.pot/4)))))
    );
  }
  applyAction(action, raiseAmt);
}

function evalBotHand(cards, community) {
  if (!cards||cards.length<2) return 0;
  let s = (cards[0].val+cards[1].val)/28;
  if (cards[0].val===cards[1].val)              s+=0.3;
  if (cards[0].suit===cards[1].suit)            s+=0.1;
  if (Math.abs(cards[0].val-cards[1].val)<=2)   s+=0.1;
  if (community.length>=3) {
    const all=[...cards,...community];
    const cnt={}; for(const c of all) cnt[c.val]=(cnt[c.val]||0)+1;
    const sm={};  for(const c of all) sm[c.suit]=(sm[c.suit]||0)+1;
    const g=Object.values(cnt).sort((a,b)=>b-a);
    if      (g[0]>=4)              s=0.95;
    else if (g[0]>=3&&g[1]>=2)    s=0.88;
    else if (Math.max(...Object.values(sm))>=5) s=Math.max(s,0.82);
    else if (g[0]>=3)              s=Math.max(s,0.75);
    else if (g[0]>=2&&g[1]>=2)    s=Math.max(s,0.55);
    else if (g[0]>=2)              s=Math.max(s,0.40);
  }
  return Math.min(1,s);
}

function decideBotAction(strength, hs, toCall, canCheck, potOdds) {
  const bluff = {weak:0.05,medium:0.12,strong:0.20,expert:0.28}[strength]||0.1;
  const agg   = {weak:0.30,medium:0.50,strong:0.70,expert:0.85}[strength]||0.5;
  const isB   = Math.random()<bluff;
  const eff   = isB ? Math.min(1,hs+0.4) : hs;
  switch (strength) {
    case 'weak':
      if (canCheck) return Math.random()<0.7 ? 'check' : (eff>0.5?'raise':'check');
      if (eff>0.6)  return 'call';
      if (eff>0.3 && potOdds<0.3) return 'call';
      return Math.random()<0.4 ? 'call' : 'fold';
    case 'medium':
      if (canCheck) return (eff>0.65&&Math.random()<agg) ? 'raise' : 'check';
      if (eff>0.7&&Math.random()<agg) return 'raise';
      return (eff>0.45||potOdds<0.25) ? 'call' : 'fold';
    case 'strong':
      if (canCheck) return (eff>0.55&&Math.random()<agg) ? 'raise' : 'check';
      if (eff>0.75&&Math.random()<agg) return 'raise';
      return (eff>0.38||potOdds<0.22) ? 'call' : 'fold';
    default: // expert
      if (canCheck) {
        if (eff>0.5&&Math.random()<agg) return 'raise';
        if (isB&&Math.random()<0.35)    return 'raise';
        return 'check';
      }
      if (eff>0.8&&Math.random()<agg)  return 'raise';
      if (eff>0.35||potOdds<0.2)       return 'call';
      if (isB&&Math.random()<0.4)       return 'raise';
      return 'fold';
  }
}

/* ══════════════════════════════════════════════════════════
   HUMAN ACTION ENTRY POINT
   Called by onclick buttons in renderMyArea HTML.
══════════════════════════════════════════════════════════ */
function humanAction(type) {
  if (!G) return;
  const myIdx = myPlayerIndex();
  if (G.activeIdx !== myIdx) return;           // not our turn
  const p = G.players[myIdx];
  if (!p || p.folded || p.eliminated || p.allIn) return;

  let raiseAmt = 0;
  if (type==='raise') {
    raiseAmt = parseInt(document.getElementById('raiseInput')?.value||'0', 10);
    const minRaise = G.currentBet + G.bb;
    if (isNaN(raiseAmt)||raiseAmt<minRaise) { alert(`Minimum Raise: ${minRaise}`); return; }
  }

  if (net.mode==='guest') {
    guestSendAction(type, raiseAmt);
  } else {
    applyAction(type, raiseAmt);
  }
}

// Which index in G.players is "me"?
function myPlayerIndex() {
  if (!G) return -1;
  if (net.mode==='solo') return 0;            // always seat 0 in solo
  return G.players.findIndex(p => p.peerId===net.myId);
}

/* ══════════════════════════════════════════════════════════
   HAND EVALUATOR
   Tier layout (no overlap):
     9 000 000        Royal Flush
     8 000 000 + hi   Straight Flush  (hi ≤ 14)
     7 000 000 + b15  Four of a Kind  (max b15 = 224)
     6 000 000 + b15  Full House      (max b15 = 224)
     5 000 000 + b15  Flush           (max b15 = 755 500)
     4 000 000 + hi   Straight        (hi ≤ 14)
     3 000 000 + b15  Trips           (max b15 = 3 357)
     2 000 000 + b15  Two Pair        (max b15 = 3 357)
     1 000 000 + b15  One Pair        (max b15 = 50 459)
                b15   High Card       (max b15 = 755 500 < 1 000 000) ✓
══════════════════════════════════════════════════════════ */
function createDeck() {
  const d=[];
  for(const s of SUITS) for(const r of RANKS) d.push({rank:r,suit:s,val:RANK_VAL[r]});
  return shuffle(d);
}

// Base-15 encoder for tiebreaker; max 5 vals = 755 500 < 1 000 000
function b15(vals) { let r=0; for(const v of vals) r=r*15+v; return r; }

// All k-combinations
function kCombos(arr,k) {
  const res=[];
  function go(start,cur){
    if(cur.length===k){res.push([...cur]);return;}
    for(let i=start;i<arr.length;i++){cur.push(arr[i]);go(i+1,cur);cur.pop();}
  }
  go(0,[]); return res;
}

// Returns high-card value of straight in descending sorted 5-val array, else false
function straightHigh(sv) {
  if(sv[0]-sv[4]===4 && new Set(sv).size===5) return sv[0];
  if(sv[0]===14&&sv[1]===5&&sv[2]===4&&sv[3]===3&&sv[4]===2) return 5;
  return false;
}

// Score exactly 5 cards
function scoreHand5(cards) {
  const srt = [...cards].sort((a,b)=>b.val-a.val);
  const v   = srt.map(c=>c.val);
  const su  = srt.map(c=>c.suit);
  const fl  = su.every(x=>x===su[0]);
  const shi = straightHigh(v);

  if(fl&&shi!==false) {
    if(shi===14&&v[4]===10) return 9_000_000;
    return 8_000_000+shi;
  }
  const cnt={}; for(const x of v) cnt[x]=(cnt[x]||0)+1;
  const grp=Object.entries(cnt).map(([x,c])=>({v:+x,c})).sort((a,b)=>b.c-a.c||b.v-a.v);
  const g=grp.map(x=>x.c);

  if(g[0]===4)           return 7_000_000+b15([grp[0].v,grp[1].v]);
  if(g[0]===3&&g[1]===2) return 6_000_000+b15([grp[0].v,grp[1].v]);
  if(fl)                 return 5_000_000+b15(v);
  if(shi!==false)        return 4_000_000+shi;
  if(g[0]===3){
    const k=grp.filter(x=>x.c===1).map(x=>x.v);
    return 3_000_000+b15([grp[0].v,k[0],k[1]]);
  }
  if(g[0]===2&&g[1]===2){
    const p=grp.filter(x=>x.c===2).map(x=>x.v).sort((a,b)=>b-a);
    const k=grp.filter(x=>x.c===1).map(x=>x.v);
    return 2_000_000+b15([p[0],p[1],k[0]]);
  }
  if(g[0]===2){
    const k=grp.filter(x=>x.c===1).map(x=>x.v).sort((a,b)=>b-a);
    return 1_000_000+b15([grp[0].v,k[0],k[1],k[2]]);
  }
  return b15(v);
}

function fullHandEval(hole, community) {
  const all=[...hole,...community];
  if(all.length<5) return simpleScore(hole);
  return kCombos(all,5).reduce((best,c)=>Math.max(best,scoreHand5(c)),-1);
}

function simpleScore(cards) {
  if(!cards||cards.length<2) return 0;
  return (cards[0].val+cards[1].val)*100+(cards[0].val===cards[1].val?10000:0);
}

function getHandName(hole, community) {
  const all=[...hole,...community];
  if(all.length<5){
    if(hole[0]&&hole[1]&&hole[0].val===hole[1].val) return `Paar ${hole[0].rank}`;
    return hole[0]?`${hole[0].rank} High`:'?';
  }
  const sc=fullHandEval(hole,community);
  if(sc>=9_000_000) return 'Royal Flush';
  if(sc>=8_000_000) return 'Straight Flush';
  if(sc>=7_000_000) return 'Vierling';
  if(sc>=6_000_000) return 'Full House';
  if(sc>=5_000_000) return 'Flush';
  if(sc>=4_000_000) return 'Straße';
  if(sc>=3_000_000) return 'Drilling';
  if(sc>=2_000_000) return 'Zwei Paare';
  if(sc>=1_000_000) return 'Ein Paar';
  return 'High Card';
}

function quickHint(cards, community) {
  if(!cards||cards.length<2) return '';
  if(!community||community.length===0){
    if(cards[0].val===cards[1].val) return `Paar ${cards[0].rank}`;
    return cards[0].suit===cards[1].suit
      ? `${cards[0].rank}${cards[1].rank} suited`
      : `${cards[0].rank}${cards[1].rank}`;
  }
  return getHandName(cards, community);
}

/* ══════════════════════════════════════════════════════════
   RENDER
══════════════════════════════════════════════════════════ */
function render() {
  if(!G) return;
  renderOpponents();
  renderCommunity();
  document.getElementById('potDisplay').textContent = `Pot: ${G.pot}`;
  document.getElementById('phaseLabel').textContent = PHASE_LABELS[G.phase]||'';
  renderMyArea();
}

function renderOpponents() {
  const myIdx = myPlayerIndex();
  const isSD  = G.phase==='showdown'||G.phase==='done';

  document.getElementById('botRow').innerHTML = G.players
    .map((p,pi) => ({p,pi}))
    .filter(({pi}) => pi!==myIdx)
    .map(({p,pi}) => {
      const active  = G.activeIdx===pi && G.phase!=='done' && G.phase!=='idle';
      const showCrd = isSD && !p.folded;
      const dealer  = pi===G.dealerIdx;
      const isPeer  = !p.isBot;

      let cls='player-info';
      if(p.eliminated)       cls+=' eliminated';
      else if(p.folded)      cls+=' folded';
      else if(active)        cls+=' active';
      if(isPeer && pi!==myIdx) cls+=' human-peer';

      const crds = p.cards.length
        ? (showCrd ? p.cards.map(c=>smallCard(c)).join('') : smallCard(null,true)+smallCard(null,true))
        : '';
      const bet  = p.bet>0 ? `<div class="player-bet">Bet: ${p.bet}</div>` : '';
      const stat = p.allIn  ? '<div class="player-status">ALL IN</div>'
                 : (p.folded&&!p.eliminated ? '<div class="player-status">Fold</div>' : '');
      const hand = showCrd&&p.handName ? `<div class="player-status">${p.handName}</div>` : '';
      const tag  = isPeer ? '<div class="peer-tag">👤 Online</div>' : '<div class="peer-tag">🤖 Bot</div>';

      return `<div class="player-slot">
        <div class="bot-cards">${crds}</div>
        <div class="${cls}">
          <div class="player-name">${p.name}${dealer?dealerBadge():''}</div>
          <div class="player-chips">💰 ${p.chips}</div>
          ${bet}${stat}${hand}${tag}
        </div>
      </div>`;
    }).join('');
}

function renderCommunity() {
  const cards=[...G.community]; while(cards.length<5) cards.push(null);
  document.getElementById('communityCards').innerHTML=cards.map(commCard).join('');
}

function renderMyArea() {
  const myIdx = myPlayerIndex();
  const pa    = document.getElementById('playerArea');

  // Waiting for seat assignment (guest before game starts)
  if(myIdx<0){
    pa.className='player-area';
    pa.innerHTML='<div class="idle-msg">Verbunden – warte auf Spielstart…</div>';
    return;
  }

  const me = G.players[myIdx];

  // Eliminated
  if(me.eliminated){
    pa.className='player-area';
    pa.innerHTML='<div class="idle-msg">Du bist ausgeschieden.</div>';
    return;
  }

  // Phase: idle → show the deal button
  if(G.phase==='idle'){
    pa.className='player-area';
    pa.innerHTML=`<div style="text-align:center;width:100%">
      <button class="btn btn-deal" onclick="startRound()">🃏 Karten geben</button>
    </div>`;
    return;
  }

  // Phase: done → show "Nächste Runde startet…" (auto-advances via botTimer)
  if(G.phase==='done'){
    pa.className='player-area';
    const myCards = me.cards.map(bigCard).join('');
    pa.innerHTML=`
      <div class="my-cards">${myCards}</div>
      <div class="player-stats">
        <div class="player-label">${me.name}${G.dealerIdx===myIdx?dealerBadge():''}</div>
        <div class="my-chips">💰 ${me.chips} Chips</div>
        ${me.handName?`<div class="hand-rank">${me.handName}</div>`:''}
        <div class="action-wait">Nächste Runde startet…</div>
      </div>`;
    return;
  }

  // Active play
  const isSD      = G.phase==='showdown';
  const isMyTurn  = G.activeIdx===myIdx && !me.folded && !me.allIn && !isSD;
  const toCall    = G.currentBet - me.bet;
  const canCheck  = toCall<=0;
  const hint      = isSD ? getHandName(me.cards,G.community) : quickHint(me.cards,G.community);
  const betHtml   = me.bet>0 ? `<div class="my-bet">Dein Bet: ${me.bet}</div>` : '';
  const allInBadge = me.allIn ? '<span class="status-allin">ALL IN</span>' : '';
  const minRaise  = Math.min(me.chips+me.bet, G.currentBet+G.bb*2);
  const maxRaise  = me.chips+me.bet;

  let actions='';
  if(isMyTurn){
    actions=`<div class="actions">
      <button class="btn btn-fold"  onclick="humanAction('fold')">Fold</button>
      ${canCheck
        ?`<button class="btn btn-check" onclick="humanAction('check')">Check</button>`
        :`<button class="btn btn-call"  onclick="humanAction('call')">Call ${toCall}</button>`}
      <input class="raise-input" id="raiseInput" type="number"
        value="${minRaise}" min="${minRaise}" max="${maxRaise}" step="${G.bb}"/>
      <button class="btn btn-raise" onclick="humanAction('raise')">Raise</button>
      <button class="btn btn-allin" onclick="humanAction('allin')">All In</button>
    </div>`;
  } else {
    const wait = me.folded    ? 'Gefoldet'
               : me.allIn     ? 'All In – warte…'
               : isSD         ? ''
               :                'Warte auf andere…';
    actions = `<div class="action-wait">${wait}</div>`;
  }

  pa.className = 'player-area'+(isMyTurn?' active-turn':'');
  pa.innerHTML = `
    <div class="my-cards">${me.cards.map(bigCard).join('')}</div>
    <div class="player-stats">
      <div class="player-label">${me.name}${G.dealerIdx===myIdx?dealerBadge():''}</div>
      <div class="my-chips">💰 ${me.chips} Chips</div>
      ${betHtml}${allInBadge}
      ${hint?`<div class="hand-rank">${hint}</div>`:''}
      ${actions}
    </div>`;
}

// Standalone function just to paint the deal button without a full render
function paintDealButton() {
  const pa = document.getElementById('playerArea');
  pa.className = 'player-area';
  pa.innerHTML = `<div style="text-align:center;width:100%">
    <button class="btn btn-deal" onclick="startRound()">🃏 Karten geben</button>
  </div>`;
  // Also clear opponents and community for a clean slate
  document.getElementById('botRow').innerHTML = G.players
    .filter((_,i)=>i!==0)
    .map(p=>`<div class="player-slot">
      <div class="bot-cards"></div>
      <div class="player-info">
        <div class="player-name">${p.name}</div>
        <div class="player-chips">💰 ${p.chips}</div>
      </div>
    </div>`).join('');
  document.getElementById('communityCards').innerHTML =
    Array(5).fill('<div class="community-card empty"></div>').join('');
  document.getElementById('potDisplay').textContent = 'Pot: 0';
  document.getElementById('phaseLabel').textContent = '';
}

/* ── Overlay ─────────────────────────────────────────────── */
function showGameOver(winner) {
  const isMe = winner && (winner.peerId===net.myId || winner.peerId==='local');
  const o = document.getElementById('messageOverlay');
  o.style.display='flex';
  o.innerHTML=`
    <div class="message-text">🏆 ${winner?winner.name:'?'} gewinnt alles!</div>
    <div class="message-sub">${isMe?'Herzlichen Glückwunsch!':'Besser beim nächsten Mal!'}</div>
    <button class="btn btn-deal" style="margin-top:12px" onclick="backToLobby()">Zur Lobby</button>`;
  if(G) G.phase='idle';
  if(net.mode==='host') pushState();
}

function hideOverlay(){
  const o=document.getElementById('messageOverlay');
  o.style.display='none'; o.innerHTML='';
}

/* ── Log ─────────────────────────────────────────────────── */
function addLog(msg, important=false, win=false, netMsg=false) {
  const la=document.getElementById('logArea');
  if(!la) return;
  const d=document.createElement('div');
  d.className='log-entry'+(important?' important':'')+(win?' win':'')+(netMsg?' net':'');
  d.textContent=msg;
  la.appendChild(d);
  la.scrollTop=la.scrollHeight;
  if(la.children.length>60) la.removeChild(la.firstChild);
}

/* ── Boot ────────────────────────────────────────────────── */
(function boot(){
  showScreen('lobby');
  switchTab('solo');
}());
