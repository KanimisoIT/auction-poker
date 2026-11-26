/* THE AUCTION POKER 運営アプリ — 画面と同期
   共有: Firebase(Firestore と匿名ログイン)。設定は config.js。
   GMは Google アカウントでログインし、配札表と全部の状態を持つ。会場画面とプレイヤーは公開の写しだけを読む。 */
(function () {
  'use strict';
  const E = window.APE;
  const C = E.CONFIG;
  const SEATS = E.SEATS;
  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const app = document.getElementById('app');
  /* 時刻はサーバーの時計にそろえる(共有のとき、起動時と5分ごとに差を測る) */
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const mkStore = (s) => ({
    get(k) { try { return s().getItem(k); } catch (e) { return null; } },
    set(k, v) { try { s().setItem(k, v); } catch (e) { /* 使えない環境では覚えない */ } },
    del(k) { try { s().removeItem(k); } catch (e) { /* 同上 */ } }
  });
  const ls = mkStore(() => window.localStorage);
  const ss = mkStore(() => window.sessionStorage);

  /* ================= 保存と同期 ================= */
  const blankData = () => ({ full: null, pub: null, entries: {}, bids: {}, joins: {}, progress: null, myMember: null });
  const Store = { kind: 'pending', isGM: false, uid: null, email: null, anon: true, data: blankData(), subs: [], readOnly: false };
  Store.onChange = (fn) => Store.subs.push(fn);
  Store.emit = () => Store.subs.forEach((f) => f());
  function errText(e) { return (e && (e.code || e.message)) || '不明なエラー'; }
  function writeErr(e) {
    if (e && e.code === 'permission-denied') toast('書き込めませんでした。締め切られたか、権限がありません。');
    else toast('保存できませんでした: ' + errText(e));
    throw e;
  }
  /* 新しい版だけを採る(書くたびに rev が1増える。古い写しが後から届いても戻さない) */
  function newer(d, c) { return !(d && c && (d.id === c.id ? (d.rev || 0) < (c.rev || 0) : (d.createdAt || 0) < (c.createdAt || 0))); }

  /* --- この端末だけ(稽古) --- */
  const LKEY = 'ap2.local.v1';
  function localInit() {
    Store.kind = 'local';
    Store.isGM = true;
    const load = () => { try { return JSON.parse(window.localStorage.getItem(LKEY)); } catch (e) { return null; } };
    function apply(x) {
      if (!x) return;
      Store.data.full = x.game || null;
      Store.data.entries = x.entries || {};
      Store.data.bids = x.bids || {};
      Store.data.joins = x.joins || {};
      Store.deals = x.deals || null;
      E.setDeals(Store.deals);
    }
    apply(load());
    let bc = null;
    try { bc = new BroadcastChannel('ap2-local'); bc.onmessage = () => reload(); } catch (e) { bc = null; }
    window.addEventListener('storage', (ev) => { if (ev.key === LKEY) reload(); });
    function reload() { apply(load()); Store.emit(); }
    function save() {
      const d = Store.data;
      try { window.localStorage.setItem(LKEY, JSON.stringify({ game: d.full, entries: d.entries, bids: d.bids, joins: d.joins, deals: Store.deals })); } catch (e) { /* 覚えられなくても続ける */ }
      try { if (bc) bc.postMessage(1); } catch (e) { /* 同上 */ }
      Store.emit();
    }
    Store.setGame = async (g) => { const b = clone(g); b.rev = (b.rev || 0) + 1; Store.data.full = b; save(); };
    Store.putDoc = async (coll, id, doc) => { Store.data[coll] = Object.assign({}, Store.data[coll], { [id]: clone(doc) }); save(); };
    Store.lookupCode = async (code) => { const g = Store.data.full; const s = g && SEATS.find((x) => g.seats[x].code === code); return s ? { seat: s, gameId: g.id } : null; };
    Store.setMember = async (m) => { Store.data.joins = Object.assign({}, Store.data.joins, { [m.gameId + '_' + m.seat]: m }); save(); };
    Store.setDeals = async (d) => { Store.deals = d; E.setDeals(d); save(); };
    Store.writeCodes = async () => {};
    Store.publishProgress = async () => {};
  }

  /* --- 共有(Firebase) --- */
  async function sharedInit(cfg) {
    const [FA, A, F] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')]);
    const fbApp = FA.initializeApp(cfg);
    /* 試験用: ?anon=1 のタブは、ほかのタブのログインを使わず、そのタブだけの匿名の参加者になる */
    const auth = /[?&]anon=1/.test(location.search) ? A.initializeAuth(fbApp, { persistence: A.inMemoryPersistence }) : A.getAuth(fbApp);
    const db = F.getFirestore(fbApp);
    Store.fb = { A, F, auth, db };
    Store.kind = 'shared';
    const ref = (p) => F.doc(db, ...p.split('/'));
    let unsubs = [];
    const onErr = (e) => { Store.syncErr = '同期が止まりました。ページを開き直してください(' + errText(e) + ')'; toast(Store.syncErr); Store.emit(); };
    function attach() {
      unsubs.forEach((u) => { try { u(); } catch (e) { /* 外すだけ */ } });
      unsubs = [];
      const d = Store.data;
      d.entries = {}; d.bids = {}; d.joins = {}; d.full = null; d.myMember = null;
      const mapOf = (q) => { const m = {}; q.docs.forEach((x) => { m[x.id] = x.data(); }); return m; };
      unsubs.push(F.onSnapshot(ref('ap/game'), (s) => { const v = s.exists() ? s.data() : null; if (newer(v, d.pub)) { d.pub = v; Store.emit(); } }, onErr));
      unsubs.push(F.onSnapshot(ref('ap/progress'), (s) => { d.progress = s.exists() ? s.data() : null; Store.emit(); }, onErr));
      if (Store.isGM) {
        unsubs.push(F.onSnapshot(ref('ap/gm'), (s) => { const v = s.exists() ? s.data() : null; if (newer(v, d.full)) { d.full = v; Store.emit(); } }, onErr));
        unsubs.push(F.onSnapshot(ref('ap/deals'), (s) => { Store.deals = s.exists() ? s.data().deals : null; E.setDeals(Store.deals); Store.emit(); }, onErr));
        unsubs.push(F.onSnapshot(F.collection(db, 'entries'), (q) => { d.entries = mapOf(q); Store.emit(); }, onErr));
        unsubs.push(F.onSnapshot(F.collection(db, 'bids'), (q) => { d.bids = mapOf(q); Store.emit(); }, onErr));
        unsubs.push(F.onSnapshot(F.collection(db, 'members'), (q) => { const m = {}; q.docs.forEach((x) => { const v = x.data(); m[v.gameId + '_' + v.seat] = v; }); d.joins = m; Store.emit(); }, onErr));
      } else {
        const mine = (c) => F.query(F.collection(db, c), F.where('uid', '==', Store.uid));
        unsubs.push(F.onSnapshot(mine('entries'), (q) => { d.entries = mapOf(q); Store.emit(); }, onErr));
        unsubs.push(F.onSnapshot(mine('bids'), (q) => { d.bids = mapOf(q); Store.emit(); }, onErr));
        unsubs.push(F.onSnapshot(ref('members/' + Store.uid), (s) => { d.myMember = s.exists() ? s.data() : null; Store.emit(); }, onErr));
      }
    }
    async function checkGM() {
      Store.isGM = false;
      Store.gmErr = null;
      if (Store.anon) return;
      try { await F.getDoc(ref('ap/deals')); Store.isGM = true; } catch (e) { Store.gmErr = errText(e); }
    }
    await new Promise((resolve, reject) => {
      let first = true;
      A.onAuthStateChanged(auth, async (u) => {
        if (!u) {
          try { await A.signInAnonymously(auth); } catch (e) { if (first) { first = false; reject(e); } else toast('ログインできません: ' + errText(e)); }
          return;
        }
        Store.uid = u.uid; Store.email = u.email || null; Store.anon = !!u.isAnonymous;
        await checkGM();
        attach();
        syncClock();
        if (first) { first = false; resolve(); }
        render(true);
      });
    });
    let chain = Promise.resolve();
    Store.setGame = (g) => {
      const body = clone(g);
      body.rev = (body.rev || 0) + 1;
      Store.data.full = body;
      Store.emit();
      const b = F.writeBatch(db);
      b.set(ref('ap/gm'), body);
      b.set(ref('ap/game'), publicView(body));
      Store.pendingN = (Store.pendingN || 0) + 1;
      if (!Store.pendingSince) Store.pendingSince = Date.now();
      chain = chain.then(() => b.commit()).catch((e) => { try { writeErr(e); } catch (x) { /* 知らせた */ } })
        .then(() => { Store.pendingN--; if (!Store.pendingN) { Store.pendingSince = 0; Store.emit(); } });
      return chain;
    };
    Store.putDoc = (coll, id, doc) => {
      const body = clone(doc);
      body.uid = Store.uid;
      Store.data[coll] = Object.assign({}, Store.data[coll], { [id]: body });
      Store.emit();
      return F.setDoc(F.doc(db, coll, id), body).catch((e) => {
        const m = Object.assign({}, Store.data[coll]); delete m[id]; Store.data[coll] = m; Store.emit();
        writeErr(e);
      });
    };
    Store.lookupCode = async (code) => {
      if (!/^[A-Z0-9]{4,10}$/.test(code)) return null;
      try { const s = await F.getDoc(ref('codes/' + code)); return s.exists() ? s.data() : null; } catch (e) { return null; }
    };
    Store.setMember = (m) => F.setDoc(ref('members/' + Store.uid), Object.assign({}, m, { at: Date.now() }));
    Store.setDeals = (deals) => F.setDoc(ref('ap/deals'), { deals, at: Date.now() }).catch(writeErr);
    Store.writeCodes = (g) => {
      const b = F.writeBatch(db);
      SEATS.forEach((s) => b.set(ref('codes/' + g.seats[s].code), { seat: s, gameId: g.id }));
      return b.commit().catch(writeErr);
    };
    let lastProgress = '';
    Store.publishProgress = (p) => {
      const k = JSON.stringify(p);
      if (k === lastProgress) return Promise.resolve();
      lastProgress = k;
      return F.setDoc(ref('ap/progress'), p).catch(() => { lastProgress = ''; });
    };
    Store.login = () => A.signInWithPopup(auth, new A.GoogleAuthProvider()).catch((e) => toast('ログインできませんでした: ' + errText(e)));
    Store.logout = () => A.signOut(auth);
    async function syncClock() {
      if (!Store.uid) return;
      const r = ref('pings/' + Store.uid);
      let best = null;
      for (let i = 0; i < 3; i++) {
        try {
          const t0 = Date.now();
          await F.setDoc(r, { t: F.serverTimestamp() });
          const t1 = Date.now();
          const s = await F.getDocFromServer(r);
          const st = s.data().t.toMillis();
          const rtt = t1 - t0;
          if (!best || rtt < best.rtt) best = { rtt, off: st - (t0 + t1) / 2 };
        } catch (e) { break; }
      }
      if (best) { clockOffset = best.off; Store.clockRtt = best.rtt; }
    }
    setInterval(syncClock, 5 * 60 * 1000);
  }
  /* config.js の設定を読む。Firebase のコンソールの断片を丸ごと貼った(import の行がある)ときも、文字から設定を拾う */
  async function loadConfig() {
    if (typeof firebaseConfig !== 'undefined' && firebaseConfig) return firebaseConfig;   // config.js が置く
    try {
      const t = await (await fetch('config.js?t=' + Date.now(), { cache: 'no-store' })).text();
      const m = t.match(/firebaseConfig\s*=\s*(\{[\s\S]*?\})/);
      if (!m) return null;
      const v = new Function('return (' + m[1] + ');')();
      return v && v.apiKey && v.projectId ? v : null;
    } catch (e) { return null; }
  }
  async function initStore() {
    const cfg = await loadConfig();
    const pref = ls.get('ap.mode');
    Store.hasConfig = !!cfg;
    if (cfg && pref !== 'local') {
      try {
        await Promise.race([sharedInit(cfg), new Promise((_, rej) => setTimeout(() => rej(new Error('つながるまでに時間がかかりすぎました')), 15000))]);
      } catch (e) { Store.kind = 'error'; Store.initErr = errText(e); }
    } else localInit();
    render(true);
  }

  /* ================= 共通の道具 ================= */
  /* GMの画面は全部の状態、ほかの画面は公開の写し(この端末だけのときはどちらも全部) */
  /* 試験用: ?pubtest=1 のとき、この端末だけでもGM以外の画面は公開の写しで描く */
  const PUBTEST = /[?&]pubtest=1/.test(location.search);
  const G = () => {
    if (route() === 'gm') return Store.data.full;
    if (Store.kind === 'local') return PUBTEST && Store.data.full ? publicView(Store.data.full) : Store.data.full;
    return Store.data.pub;
  };
  const speed = (g) => (g && g.fast ? 0.1 : 1);
  const entryId = (g, r, s) => g.id + '_R' + r + '_' + s;
  const entryOf = (g, r, s) => Store.data.entries[entryId(g, r, s)] || null;
  const bidOf = (g, r, s) => Store.data.bids[entryId(g, r, s)] || null;
  const joinedOf = (g, s) => Store.data.joins[g.id + '_' + s] || null;
  const seatName = (g, s) => (g && g.seats[s] && g.seats[s].name) || ('プレイヤー' + s);
  const fmt = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
  /* 時計の要素の属性。開始前(猶予の間)は全体の長さのまま止まって見える */
  const clockAttr = (g) => 'data-end="' + g.timerEndsAt + '" data-start="' + ((g.phase === 'FREE' ? g.freeStartedAt : g.phase === 'AUCTION' ? g.auctionStartedAt : 0) || 0) + '"';
  const signed = (n) => (n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '±0');
  const playerUrl = () => location.href.split('#')[0] + '#play';
  /* 卓で次の共通カードをめくる時刻(GMの画面にだけ出す) */
  function nextRevealAt(g) {
    const r = g.round;
    if (g.phase !== 'FREE' || !r || !C.revealAt[r]) return null;
    const offs = C.revealAt[r].filter((o) => o > 0).map((o) => g.freeStartedAt + o * speed(g)).filter((x) => x > now());   // 開始時にめくる札(R1)は時計と同じなので出さない
    return offs.length ? offs[0] : null;
  }
  function cardFace(id, cls) {
    cls = cls || '';
    if (id === E.JOKER) return '<span class="card joker ' + cls + '" aria-label="ジョーカー"><span class="c-r">J</span><span class="c-s">★</span></span>';
    const r = E.RANK_LABEL[E.rankOf(id)], s = E.SUIT_SYM[E.suitOf(id)] + '︎';
    return '<span class="card ' + (E.isRed(id) ? 'red' : 'blk') + ' ' + cls + '" aria-label="' + s + r + '"><span class="c-r">' + r + '</span><span class="c-s">' + s + '</span></span>';
  }
  const ct = (id) => (id === E.JOKER ? '<span class="ct">JOKER</span>' : '<span class="ct ' + (E.isRed(id) ? 'red' : '') + '">' + E.cardText(id) + '</span>');
  const miniCards = (ids) => '<span class="cards mini">' + ids.map((c) => cardFace(c)).join('') + '</span>';
  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
  }
  function newCode(used) {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c;
    do { c = ''; for (let i = 0; i < 6; i++) c += A[Math.floor(Math.random() * A.length)]; } while (used.has(c));
    used.add(c);
    return c;
  }
  function log(g, msg) { g.log = (g.log || []).concat([{ t: now(), msg }]).slice(-40); }

  /* ================= 進行表(段・司会・係) ================= */
  const ORDER = ['READY', 'FREE', 'ENTRY', 'JUDGED', 'SHOWDOWN', 'AUCTION', 'TALLIED', 'RESULT'];
  const LABEL = { SETUP: '受付', READY: '準備', FREE: '自由時間', ENTRY: 'カード提出', JUDGED: '判定済み', SHOWDOWN: 'SHOWDOWN', AUCTION: 'オークション', TALLIED: '集計済み', RESULT: '落札結果', FINAL: '最終結果' };
  const PRESS = { SETUP: 'ゲームを始める', READY: '自由時間を始める', JUDGED: 'SHOWDOWNを公開', SHOWDOWN: 'オークションを始める', TALLIED: '落札結果を公開' };
  function pressLabel(g) {
    if (g.phase === 'RESULT') return g.round < 4 ? 'ラウンド' + (g.round + 1) + 'へ進む' : '最終結果を公開';
    return PRESS[g.phase] || null;
  }
  function cue(g) {
    const r = g.round;
    const min = (ms) => Math.round(ms * speed(g) / 60000 * 10) / 10;
    const rv = C.revealAt[r];
    switch (g.phase) {
      case 'SETUP': return { mc: '参加コードを配ってください。全員がそろったら始めます。', staff: '座席札と参加コードを配る。席の一覧で参加の印(●)を確かめる。' };
      case 'READY': return { mc: 'ラウンド' + r + 'を始めます。封筒を開けて、カードが5枚あることを確かめてください。', staff: r === 1 ? '座席ごとの封筒を配る。' : '座席ごとの封筒を配る。共通カードを裏向きで卓に置く。' };
      case 'FREE':
        if (r === 1) return { mc: '交渉開始です。時間は' + min(C.freeMs) + '分。共通カードはこの2枚です。ラウンド1で交換できるのはカードだけです。', staff: '共通カード2枚を卓で表にする(画面には出ない)。交換が1枚⇄1枚になっているか見る。' };
        if (!rv) return { mc: '交渉開始です。時間は' + min(C.freeMs) + '分。チップの受け渡しもできます。', staff: '共通カードは公開しない。交換が1枚⇄1枚になっているか見る。' };
        return { mc: '交渉開始です。時間は' + min(C.freeMs) + '分。共通カードは' + min(rv[0]) + '分後と' + min(rv[1]) + '分後に1枚ずつ公開します。チップの受け渡しもできます。', staff: '共通カードは卓でめくる(画面には出ない)。1枚目は' + min(rv[0]) + '分後、2枚目は' + min(rv[1]) + '分後。めくるまでの残りはGMの画面に出る。' + (E.hasDeals() && E.community(r).length > rv.length ? '3枚目は伏せたまま、めくらずに判定に入る(ジャッジには入っている)。' : '') };
      case 'ENTRY': return { mc: '交渉終了です。手元の画面で、カード5枚と所持チップを入力してください。入力が済んだらカードを係に渡してください。', staff: '実物のカードを回収する。未提出の席に声をかける。' };
      case 'JUDGED': return { mc: 'ジャッジの結果が出ました。', staff: 'GM: 下の「ジャッジ」で1〜10位を確かめてから公開する。' };
      case 'SHOWDOWN': return { mc: 'SHOWDOWN。上位5名はこちらです。順位ボーナスは精算でまとめてお渡しします。', staff: '順位ボーナスはまだ配らない。' };
      case 'AUCTION': return { mc: 'オークションタイムです。' + min(C.auctionMs) + '分間。入札は1回だけ、合計は所持チップまでです。この間のチップの受け渡しは禁止です。', staff: 'チップの受け渡しがないか見る。' };
      case 'TALLIED': return { mc: '集計が終わりました。落札結果を発表します。', staff: 'GM: 「入札」と「払い出し」を確かめてから、一覧をワンペアから順に読み上げる。読み終えたら「落札結果を公開」を押す。' };
      case 'RESULT': return { mc: '落札結果の一覧です。', staff: '払い出し表どおりに、チップを渡す・回収する。プレイヤーの画面にも各自の額が出ている。' };
      case 'FINAL': return { mc: '最終結果です。', staff: '実物のチップで上位の枚数を確かめる。' };
      default: return { mc: '', staff: '' };
    }
  }

  /* 公開の写し: 参加コード・提出カード・入札・判定の全体は載せない。SHOWDOWN からは上位5名、落札結果からは集計と払い出し */
  function publicView(g) {
    const p = clone(g);
    SEATS.forEach((s) => { p.seats[s] = { name: g.seats[s].name }; });
    delete p.log;
    p.rounds = {};
    const ph = ORDER.indexOf(g.phase);
    Object.keys(g.rounds || {}).forEach((k) => {
      const r = +k, rd = g.rounds[k];
      const past = r < g.round || g.phase === 'FINAL';
      const cur = r === g.round;
      const out = { chips: rd.chips || {}, closedAt: rd.closedAt || null, forced: !!rd.forced };
      if (rd.judge && (past || (cur && ph >= ORDER.indexOf('SHOWDOWN')))) out.judge = rd.judge.filter((x) => x.pos <= 5).map((x) => ({ seat: x.seat, pos: x.pos, bonus: x.bonus }));
      if (rd.tally && (past || (cur && ph >= ORDER.indexOf('RESULT')))) {
        out.tally = { roles: rd.tally.roles.map((x) => ({ role: x.role, winner: x.winner || null, top: x.top || 0, tie: !!x.tie, bidsCount: x.bids ? x.bids.length : 0 })) };
        out.settle = rd.settle || {};
      }
      p.rounds[k] = out;
    });
    return p;
  }

  /* ================= GMの操作 ================= */
  function blankGame(opt) {
    const used = new Set();
    const seats = {};
    SEATS.forEach((s) => { seats[s] = { name: 'プレイヤー' + s, code: newCode(used) }; });
    return {
      v: 2, id: 'g' + now().toString(36) + Math.random().toString(36).slice(2, 5),
      createdAt: now(), configVersion: C.version, mode: opt.mode || 'test', fast: !!opt.fast,
      seats, round: 0, phase: 'SETUP', phaseAt: now(), timerEndsAt: null, freeStartedAt: null, rounds: {}, log: []
    };
  }
  function entryStatus(g) {
    const r = g.round;
    const cards = {}, chips = {};
    let count = 0;
    SEATS.forEach((s) => { const e = entryOf(g, r, s); if (e) { cards[s] = e.cards; chips[s] = e.chips; count++; } });
    let alerts = [];
    if (r && E.hasDeals()) alerts = E.checkCards(r, cards);
    return { count, cards, chips, alerts };
  }
  function bidTargets(g) { const rd = g.rounds[g.round] || {}; return SEATS.filter((s) => rd.chips && rd.chips[s] != null); }
  function allBidsIn(g) { const ts = bidTargets(g); return ts.length > 0 && ts.every((s) => bidOf(g, g.round, s)); }
  function bidCount(g) { let n = 0; SEATS.forEach((s) => { if (bidOf(g, g.round, s)) n++; }); return n; }
  /* 会場画面の数(共有のときはGMが流す数を読む) */
  function progressOf(g) {
    if (Store.kind === 'local') return { entries: entryStatus(g).count, bids: bidCount(g) };
    const p = Store.data.progress;
    return p && p.gameId === g.id && p.round === g.round ? p : { entries: 0, bids: 0 };
  }
  function setPhase(g, phase, extra) { Object.assign(g, { phase, phaseAt: now() }, extra || {}); log(g, 'R' + g.round + ' ' + LABEL[phase]); }
  function needDeals() { if (E.hasDeals()) return false; toast('配札表が読み込まれていません。「設定」のタブで貼ってください'); GUI.tab = 'config'; render(true); return true; }

  const act = {
    async createGame(opt) { const g = blankGame(opt || {}); log(g, 'ゲームを作成'); await Store.writeCodes(g); await Store.setGame(g); GUI.tab = 'seats'; },
    async startGame() { if (needDeals()) return; const g = clone(G()); g.round = 1; setPhase(g, 'READY'); await Store.setGame(g); },
    async startFree() { const g = clone(G()); const st = now() + C.startLeadMs; setPhase(g, 'FREE', { freeStartedAt: st, timerEndsAt: st + C.freeMs * speed(g) }); await Store.setGame(g); },
    async toEntry() { const g = clone(G()); setPhase(g, 'ENTRY', { timerEndsAt: null }); await Store.setGame(g); },
    async closeEntry(force) {
      if (needDeals()) return;
      const g = clone(G());
      const r = g.round;
      const st = entryStatus(g);
      if (!force && (st.count < 10 || st.alerts.length)) return;
      const hands = {};
      Object.keys(st.cards).forEach((s) => { hands[s] = st.cards[s].concat(E.community(r)); });
      const judge = E.rankHands(hands, r).map((x) => ({ seat: x.seat, key: x.key, best: x.best, name: x.name, pos: x.pos, bonus: x.bonus }));
      g.rounds[r] = { cards: st.cards, chips: st.chips, judge, closedAt: now(), forced: !!force };
      setPhase(g, 'JUDGED', { timerEndsAt: null });
      if (force) log(g, 'カード提出を強制締切(' + st.count + '/10)');
      await Store.setGame(g);
    },
    async showShowdown() { const g = clone(G()); setPhase(g, 'SHOWDOWN'); await Store.setGame(g); },
    async startAuction() { const g = clone(G()); const st = now() + C.startLeadMs; setPhase(g, 'AUCTION', { timerEndsAt: st + C.auctionMs * speed(g), auctionStartedAt: st }); await Store.setGame(g); },
    async closeAuction(allIn) {
      if (G().phase !== 'AUCTION') return;   // 二重に締め切らない
      const g = clone(G());
      const r = g.round;
      if (allIn) log(g, '全員の入札がそろったので締め切り');
      const rd = g.rounds[r];
      const limit = (g.timerEndsAt || Infinity) + 3000;
      const bids = {};
      SEATS.forEach((s) => {
        const b = bidOf(g, r, s);
        if (!b || b.submittedAt > limit || rd.chips[s] == null) return;
        const chk = E.checkBid(b, rd.chips[s]);
        if (!chk.ok) { log(g, s + '席の入札は条件を満たさないため無効'); return; }
        bids[s] = { amounts: b.amounts || {}, free: b.free || {} };
      });
      const hands = {};
      Object.keys(rd.cards).forEach((s) => { hands[s] = rd.cards[s].concat(E.community(r)); });
      const tally = E.tally(r, bids, hands);
      rd.bids = bids;
      rd.tally = tally;
      rd.settle = E.settle(r, rd.judge, tally, rd.chips);
      setPhase(g, 'TALLIED', { timerEndsAt: null });
      await Store.setGame(g);
    },
    async showResult() { const g = clone(G()); setPhase(g, 'RESULT'); await Store.setGame(g); },
    async nextRound() {
      const g = clone(G());
      if (g.round < 4) { g.round += 1; setPhase(g, 'READY', { timerEndsAt: null, freeStartedAt: null }); }
      else {
        const st = g.rounds[4] && g.rounds[4].settle;
        g.final = SEATS.map((s) => ({ seat: s, chips: st && st[s] ? st[s].balance : null })).sort((a, b) => (b.chips ?? -1) - (a.chips ?? -1));
        setPhase(g, 'FINAL', { timerEndsAt: null });
      }
      await Store.setGame(g);
    },
    async advance() {
      const g = G();
      const m = { SETUP: act.startGame, READY: act.startFree, JUDGED: act.showShowdown, SHOWDOWN: act.startAuction, TALLIED: act.showResult, RESULT: act.nextRound };
      if (m[g.phase]) await m[g.phase]();
    },
    async extend() { const g = clone(G()); if (!g.timerEndsAt) return; g.timerEndsAt = Math.max(g.timerEndsAt, now()) + 60000; log(g, '時計を1分延長'); await Store.setGame(g); },
    async closeNow() {
      const g = G();
      if (g.phase === 'FREE') await act.toEntry();
      else if (g.phase === 'AUCTION') { const h = clone(g); h.timerEndsAt = now(); log(h, 'オークションを早めに締め切り'); await Store.setGame(h); await act.closeAuction(); }
      else if (g.phase === 'ENTRY') await act.closeEntry(true);
    },
    async back() {
      const g = clone(G());
      const i = ORDER.indexOf(g.phase);
      if (g.phase === 'FINAL') { g.phase = 'RESULT'; delete g.final; }
      else if (i > 0) {
        const prev = ORDER[i - 1];
        const extra = {};
        if (prev === 'FREE' || prev === 'AUCTION') extra.timerEndsAt = now() + 60000;
        else extra.timerEndsAt = null;
        if (prev === 'ENTRY' && g.rounds[g.round]) { delete g.rounds[g.round].judge; }
        if (prev === 'AUCTION' && g.rounds[g.round]) { delete g.rounds[g.round].tally; delete g.rounds[g.round].settle; delete g.rounds[g.round].bids; }
        Object.assign(g, extra);
        g.phase = prev;
      } else if (g.phase === 'READY' && g.round > 1) { g.round -= 1; g.phase = 'RESULT'; }
      else if (g.phase === 'READY') { g.round = 0; g.phase = 'SETUP'; }
      g.phaseAt = now();
      log(g, '段を戻す → R' + g.round + ' ' + LABEL[g.phase]);
      await Store.setGame(g);
    },
    /* 新しいゲームは「緊急」のタブで選んだ種類と時計で作る(前の試合の設定は引き継がない) */
    async reset() { await act.createGame({ mode: GUI.mode, fast: GUI.mode === 'test' && GUI.fast }); },
    async rename(seat, name) { const g = clone(G()); g.seats[seat].name = name.trim() || ('プレイヤー' + seat); await Store.setGame(g); },
    async recode() { const g = clone(G()); const used = new Set(); SEATS.forEach((s) => { g.seats[s].code = newCode(used); }); log(g, '参加コードを作り直し'); await Store.writeCodes(g); await Store.setGame(g); },
    /* 稽古用 */
    async fillCards() {
      if (needDeals()) return;
      const g = G();
      const r = g.round;
      const prev = r > 1 && g.rounds[r - 1] && g.rounds[r - 1].settle;
      for (const s of SEATS) {
        const chips = r === 1 ? C.startChips : (prev && prev[s] && prev[s].balance != null ? prev[s].balance : C.startChips);
        await Store.putDoc('entries', entryId(g, r, s), { gameId: g.id, round: r, seat: s, cards: E.dealt(r, s), chips, submittedAt: now(), by: 'test' });
      }
      toast('全席のカードを配札どおりに入れました');
    },
    async fillBids() {
      const g = G();
      const r = g.round;
      const rd = g.rounds[r] || {};
      for (const s of SEATS) {
        const chips = rd.chips && rd.chips[s];
        if (chips == null) continue;
        const roles = E.PUBLIC_ROLES.slice().sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3));
        const amounts = {};
        let left = chips;
        roles.forEach((role) => { const v = Math.min(left, 5 * (1 + Math.floor(Math.random() * 6))); if (v > 0) { amounts[role] = v; left -= v; } });
        const free = r === 4 && Math.random() < 0.3 && left >= 10 ? { text: 'オールスター', amount: 10 } : { text: '', amount: 0 };
        const total = Object.values(amounts).reduce((a, b) => a + b, 0) + (free.amount || 0);
        await Store.putDoc('bids', entryId(g, r, s), { gameId: g.id, round: r, seat: s, amounts, free, total, submittedAt: now(), by: 'test' });
      }
      toast('全席にランダムな入札を入れました');
    },
    async timerZero() { const g = clone(G()); if (!g.timerEndsAt) return; g.timerEndsAt = now(); log(g, 'デバッグ: 時計を0にした'); await Store.setGame(g); },
    async timer10() { const g = clone(G()); if (!g.timerEndsAt) return; g.timerEndsAt = now() + 10000; log(g, 'デバッグ: 残り10秒にした'); await Store.setGame(g); },
    async forceNext() {
      const g = G();
      if (g.phase === 'FREE') await act.toEntry();
      else if (g.phase === 'ENTRY') await act.closeEntry(true);
      else if (g.phase === 'AUCTION') { const h = clone(g); h.timerEndsAt = now(); await Store.setGame(h); await act.closeAuction(); }
      else await act.advance();
    },
    async autoRound() {
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      for (let i = 0; i < 14; i++) {
        const g = G();
        if (g.phase === 'RESULT' || g.phase === 'FINAL') break;
        if (g.phase === 'ENTRY') { await act.fillCards(); await wait(400); await act.closeEntry(true); }
        else if (g.phase === 'AUCTION') { await act.fillBids(); await wait(400); if (G().phase === 'AUCTION') { const h = clone(G()); h.timerEndsAt = now(); await Store.setGame(h); await act.closeAuction(); } }
        else await act.forceNext();
        await wait(400);
      }
      toast('落札結果まで自動で進めました');
    },
    async setMode(v) { const g = clone(G()); g.mode = v; log(g, 'この試合を' + (v === 'test' ? 'TEST' : '本番') + 'に切り替え'); await Store.setGame(g); },
  };

  /* 自動で進める(GM画面だけが受け持つ) */
  let autoBusy = false;
  async function gmTick() {
    if (route() !== 'gm' || !Store.isGM || autoBusy || Store.readOnly) return;
    const g = G();
    if (!g) return;
    const t = now();
    autoBusy = true;
    try {
      Store.publishProgress({ gameId: g.id, round: g.round, entries: entryStatus(g).count, bids: bidCount(g) });
      if (g.phase === 'FREE' && g.timerEndsAt && t >= g.timerEndsAt) await act.toEntry();
      else if (g.phase === 'ENTRY') { const st = entryStatus(g); if (st.count === 10 && !st.alerts.length && E.hasDeals()) await act.closeEntry(false); }
      else if (g.phase === 'AUCTION' && g.timerEndsAt && t >= g.timerEndsAt) await act.closeAuction();
      else if (g.phase === 'AUCTION' && allBidsIn(g)) await act.closeAuction(true);
    } catch (e) { toast('自動の進行で問題が起きました: ' + (e.message || e)); }
    finally { autoBusy = false; }
  }

  /* ================= 画面の切り替え ================= */
  function route() { const h = (location.hash || '').replace('#', ''); return ['gm', 'display', 'play'].includes(h) ? h : 'home'; }
  let lastView = null, lastSig = null, pending = false, rafId = 0;
  /* 同期の帯: 購読が止まったとき、または保存が8秒たっても届かないとき */
  function syncBadText() {
    if (Store.kind !== 'shared') return '';
    if (Store.syncErr) return Store.syncErr;
    if (Store.pendingSince && Date.now() - Store.pendingSince > 8000) return '保存がまだ届いていません。回線を確かめてください。直らなければページを開き直してください。';
    return '';
  }
  let lastBad = '';
  setInterval(() => { const b = syncBadText(); if (b !== lastBad) { lastBad = b; Store.emit(); } }, 2000);
  function scheduleRender() { if (rafId) return; rafId = requestAnimationFrame(() => { rafId = 0; render(false); }); }
  function render(force) {
    const v = route();
    document.body.dataset.view = v;
    if (Store.kind === 'pending') { app.innerHTML = bootHtml(); return; }
    if (Store.kind === 'error') { app.innerHTML = errorHtml(); return; }
    const a = document.activeElement;
    const typing = a && app.contains(a) && a.matches('input, textarea');
    let html, sig = null;
    if (v === 'play') { const p = playerHtml(); html = p.html; sig = p.sig; }
    else if (v === 'gm') { html = gmHtml(); sig = 'gm'; }
    else if (v === 'display') { html = displayHtml(); }
    else html = homeHtml();
    const bad = syncBadText();
    if (bad) { html = '<div class="sync-bad" role="alert"><span>' + esc(bad) + '</span><button class="btn btn-small" data-act="reload">開き直す</button></div>' + html; if (sig !== null) sig += '|bad'; }
    if (!force && v === lastView && typing) {
      if (v === 'play' && sig === lastSig) return;
      if (v !== 'play') { pending = true; return; }
    }
    if (!force && v === 'play' && v === lastView && sig === lastSig && !pending) return;
    pending = false;
    lastView = v; lastSig = sig;
    app.innerHTML = html;
    tickText();
    if (v === 'play') afterPlayerRender();
  }
  app.addEventListener('focusout', () => { setTimeout(() => { const a = document.activeElement; const still = a && app.contains(a) && a.matches('input, textarea'); if (pending && !still) render(true); }, 0); });
  window.addEventListener('hashchange', () => render(true));
  Store.onChange(scheduleRender);

  /* 時計の文字だけを書き換える */
  function tickText() {
    const t = now();
    app.querySelectorAll('[data-end]').forEach((el) => { el.textContent = fmt(+el.dataset.end - Math.max(t, +el.dataset.start || 0)); });
  }
  setInterval(tickText, 100);   // 秒の変わり目で端末どうしの表示がずれないよう、文字は細かく書き換える
  setInterval(gmTick, 250);

  /* ================= 起動中・ホーム ================= */
  function bootHtml() {
    return '<div class="wrap narrow"><div class="big-msg"><p class="eyebrow">THE AUCTION POKER</p><h2>接続を確かめています</h2><p class="quiet">しばらくお待ちください。</p></div></div>';
  }
  function errorHtml() {
    return '<div class="wrap narrow stack"><div class="big-msg stack"><p class="eyebrow">THE AUCTION POKER</p><h2>サーバーにつながりません</h2><p class="quiet">電波を確かめて、ページを開き直してください。</p><p class="quiet" style="font-size:12px">' + esc(Store.initErr) + '</p></div>' +
      '<button class="btn" data-act="reload">開き直す</button></div>';
  }
  function homeHtml() {
    const shared = Store.kind === 'shared';
    const g = G();
    const syncNote = shared ? '共有: 同じページを開いた端末どうしで同期しています。' : (Store.hasConfig ? 'この端末だけ: 同じ端末のタブどうしだけで同期します(稽古用)。' : 'この端末だけ: 共有の設定(config.js)がまだありません。同じ端末のタブどうしだけで同期します。');
    return '<div class="wrap narrow stack">' +
      '<header class="home-hero stack"><p class="eyebrow">運営アプリ</p><h1 class="wordmark"><i>The</i> Auction<br>Poker</h1>' +
      '<p class="quiet">GMが進めると、プレイヤーの画面と会場画面が同じ段に切り替わります。</p></header>' +
      '<div class="choices">' +
      '<a class="choice" href="#gm"><b>GM</b><span class="quiet">進行表に沿って進める。ゲームの作成、提出の監視、判定と払い出し表。</span></a>' +
      '<a class="choice" href="#display"><b>会場画面</b><span class="quiet">スクリーンに映す。時計、SHOWDOWN、落札結果。</span></a>' +
      '<a class="choice" href="#play"><b>プレイヤー</b><span class="quiet">参加コードで席に入る。カード5枚とチップの入力、入札。</span></a>' +
      '</div>' +
      '<section class="panel stack"><div class="row"><span class="grow"><b>同期のしかた</b><br><small>' + syncNote + '</small></span>' +
      (Store.hasConfig ? '<span class="seg" role="group" aria-label="同期のしかた"><button data-act="mode" data-v="shared" aria-pressed="' + shared + '">共有</button><button data-act="mode" data-v="local" aria-pressed="' + !shared + '">この端末だけ</button></span>' : '') + '</div>' +
      (g ? '<p class="quiet">いまのゲーム: R' + g.round + ' ' + LABEL[g.phase] + '(' + (g.mode === 'live' ? '本番' : 'TEST') + ')</p>' : '<p class="quiet">まだゲームはありません。GMの画面で作ります。</p>') +
      '</section><p class="quiet" style="font-size:12px">' + esc(C.version) + '。' + esc(C.note) + '。</p></div>';
  }

  /* ================= プレイヤー ================= */
  const PUI = { key: '', step: 'edit', pick: [], chips: '', bid: null, bidStep: 'edit', bidErr: [], join: '', joinSeat: null, joinCode: '', rev: 0, busy: false };
  function mySeat(g) {
    const proxy = ss.get('ap.proxy');
    if (proxy && SEATS.includes(proxy) && Store.isGM) return { seat: proxy, proxy: true };
    const s = g ? ls.get('ap.seat.' + g.id) : null;
    if (s && SEATS.includes(s)) return { seat: s, proxy: false };
    const m = Store.data.myMember;
    if (g && m && m.gameId === g.id && SEATS.includes(m.seat)) return { seat: m.seat, proxy: false };
    return null;
  }
  function resetPUI(g, me) {
    const k = g.id + ':' + g.round + ':' + g.phase + ':' + me.seat;
    if (k === PUI.key) return;
    PUI.key = k;
    PUI.step = 'edit';
    PUI.bidStep = 'edit';
    PUI.bidErr = [];
    const e = entryOf(g, g.round, me.seat);
    PUI.pick = e ? e.cards.slice() : [];
    PUI.chips = e ? String(e.chips) : (g.round === 1 ? String(C.startChips) : '');
    PUI.bid = { amounts: {}, free: { text: '', amount: '' } };
  }
  function playerHtml() {
    const g = G();
    if (!g) return { html: '<div class="wrap narrow"><div class="big-msg"><p class="eyebrow">THE AUCTION POKER</p><h2>まだゲームが始まっていません</h2><p class="quiet">GMがゲームを作るとここに参加の画面が出ます。</p></div></div>', sig: 'none' };
    const me = mySeat(g);
    if (!me) return joinHtml(g);
    resetPUI(g, me);
    const r = g.round;
    const e = r ? entryOf(g, r, me.seat) : null;
    const b = r ? bidOf(g, r, me.seat) : null;
    const sig = [g.id, g.phase, r, me.seat, me.proxy, e && e.submittedAt, b && b.submittedAt, PUI.step, PUI.bidStep, PUI.rev, g.timerEndsAt, g.rev].join('|');
    let body = '';
    const head = (me.proxy ? '<div class="proxy-bar"><span>GMが' + me.seat + '席の代わりに入力しています</span><button class="btn btn-small" data-act="proxyExit" style="background:var(--ink);color:var(--ivory);border-color:var(--ink)">GMの画面に戻る</button></div>' : '') +
      '<header class="p-head"><div class="seat-badge">' + me.seat + '</div><div class="who grow"><b>' + esc(seatName(g, me.seat)) + '</b><small>' + (r ? 'ラウンド' + r + ' · ' : '') + LABEL[g.phase] + '</small></div></header>';
    switch (g.phase) {
      case 'SETUP': body = msg('まもなく始まります', '参加の受付は済んでいます。GMの合図を待ってください。'); break;
      case 'READY': body = msg('ラウンド' + r + 'の準備中', '封筒が配られたら、カードが5枚あるか確かめてください。'); break;
      case 'FREE': body = freeHtml(g); break;
      case 'ENTRY': body = entryHtml(g, me, e); break;
      case 'JUDGED': case 'SHOWDOWN': case 'TALLIED':
        body = msg('スクリーンをご覧ください', '') + myCardsHtml(g, me); break;
      case 'AUCTION': body = auctionHtml(g, me, b); break;
      case 'RESULT': body = resultHtml(g, me); break;
      case 'FINAL': body = finalMineHtml(g, me); break;
      default: body = '';
    }
    return { html: '<div class="wrap narrow stack">' + head + body + '</div>', sig };
  }
  const msg = (h, p) => '<div class="big-msg stack"><h2>' + h + '</h2>' + (p ? '<p class="quiet">' + p + '</p>' : '') + '</div>';
  function joinHtml(g) {
    if (PUI.joinSeat) {
      const s = PUI.joinSeat;
      return { html: '<div class="wrap narrow stack"><div class="big-msg stack"><p class="eyebrow">参加の確認</p><div class="seat-badge" style="margin:0 auto">' + s + '</div><h2>' + esc(seatName(g, s)) + '</h2><p class="quiet">この席で参加しますか。</p></div>' +
        '<button class="btn btn-main btn-big" data-act="joinYes">この席で参加する</button><button class="btn" data-act="joinNo">コードを入れ直す</button></div>', sig: 'join-confirm-' + s };
    }
    return { html: '<div class="wrap narrow stack"><div class="big-msg stack" style="padding-bottom:8px"><p class="eyebrow">THE AUCTION POKER</p><h2>参加コードを入れてください</h2><p class="quiet">座席札に書かれた6文字です。</p></div>' +
      '<label class="stack"><input id="join-code" class="code-input" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" value="' + esc(PUI.join) + '" aria-label="参加コード"></label>' +
      '<button class="btn btn-main btn-big" data-act="join">参加する</button><p id="join-err" class="quiet" role="alert"></p></div>', sig: 'join' };
  }
  function freeHtml(g) {
    const r = g.round;
    return '<section class="panel stack"><p class="eyebrow">交渉の時間</p><p class="p-count count" ' + clockAttr(g) + '></p>' +
      '<p class="quiet">' + (r === 1 ? 'ラウンド1で交換できるのはカードだけです。' : 'カードの交換に加えて、チップの受け渡しもできます。') + 'カードは交換の前後で必ず5枚にしてください。</p></section>';
  }
  function myCardsHtml(g, me) {
    const cs = (entryOf(g, g.round, me.seat) || {}).cards;
    if (!cs) return '';
    return '<section class="panel stack"><p class="eyebrow">あなたの5枚</p><div class="cards">' + cs.map((c) => cardFace(c)).join('') + '</div></section>';
  }
  function entryHtml(g, me, e) {
    if (e && PUI.step !== 'edit-again' && PUI.step !== 'confirm') {
      return '<section class="panel stack"><p class="eyebrow">提出済み <span class="num">' + new Date(e.submittedAt).toLocaleTimeString('ja-JP') + '</span></p><div class="cards">' + e.cards.map((c) => cardFace(c)).join('') + '</div>' +
        '<p>所持チップ <b class="count" style="font-size:22px">' + e.chips + '</b></p><p class="quiet">カードを係に渡してください。締め切りまでは直せます。</p>' +
        '<button class="btn" data-act="reedit">修正する</button></section>';
    }
    if (PUI.step === 'confirm') {
      return '<section class="panel stack"><p class="eyebrow">この内容で登録しますか</p><div class="cards">' + PUI.pick.map((c) => cardFace(c)).join('') + '</div>' +
        '<p>所持チップ <b class="count" style="font-size:22px">' + esc(PUI.chips) + '</b></p>' +
        '<button class="btn btn-main btn-big" data-act="entrySubmit">この内容で登録する</button><button class="btn" data-act="entryBack">戻って直す</button></section>';
    }
    // 共通カードは画面で示さない(選び間違えた札はGMの画面に「配札にない札」として出る)
    const rows = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
    let grid = '';
    rows.forEach((rk) => {
      E.SUITS.forEach((s) => {
        const id = E.RANK_CH[rk] + s;
        const i = PUI.pick.indexOf(id);
        grid += '<button class="pk ' + (E.isRed(id) ? 'red' : 'blk') + '" data-act="pick" data-id="' + id + '" aria-pressed="' + (i >= 0) + '" aria-label="' + E.SUIT_SYM[s] + E.RANK_LABEL[rk] + '">' +
          '<span class="c-r">' + E.RANK_LABEL[rk] + '</span><span class="c-s">' + E.SUIT_SYM[s] + '︎</span>' + (i >= 0 ? '<span class="no">' + (i + 1) + '</span>' : '') + '</button>';
      });
    });
    const tray = [0, 1, 2, 3, 4].map((i) => (PUI.pick[i] ? '<button data-act="unpick" data-id="' + PUI.pick[i] + '" aria-label="外す">' + cardFace(PUI.pick[i]) + '</button>' : '<span class="card slot"></span>')).join('');
    const ready = PUI.pick.length === 5;
    return '<div class="tray stack" style="gap:6px"><div class="row"><b class="grow">手元の5枚をタップ</b><small class="num">' + PUI.pick.length + ' / 5</small></div><div class="tray-cards">' + tray + '</div></div>' +
      '<div class="picker" role="group" aria-label="カードを選ぶ">' + grid + '</div>' +
      '<div class="bottom-bar stack" style="gap:8px"><label class="row"><span class="grow"><b>所持チップ</b><br><small>いま手元にある枚数</small></span><input id="chips" class="chip-input num" inputmode="numeric" pattern="[0-9]*" style="max-width:150px" value="' + esc(PUI.chips) + '" aria-label="所持チップ"></label>' +
      '<button class="btn btn-main btn-big" data-act="entryConfirm"' + (ready ? '' : ' disabled') + '>' + (ready ? '内容を確かめる' : 'あと' + (5 - PUI.pick.length) + '枚選んでください') + '</button></div>';
  }
  function auctionHtml(g, me, b) {
    const r = g.round;
    const rd = g.rounds[r] || {};
    const declared = rd.chips ? rd.chips[me.seat] : null;
    const timer = '<p class="p-count count" ' + clockAttr(g) + '></p>';
    if (declared == null) return timer + msg('入札できません', 'このラウンドのカード提出がないため、入札はできません。');
    if (b) {
      const lines = E.PUBLIC_ROLES.filter((k) => E.toInt(b.amounts && b.amounts[k]) > 0).map((k) => '<tr><td>' + E.ROLE_JA[k] + '</td><td class="n">' + E.toInt(b.amounts[k]) + '</td></tr>');
      if (b.free && b.free.text) lines.push('<tr><td>' + esc(b.free.text) + '</td><td class="n">' + E.toInt(b.free.amount) + '</td></tr>');
      return timer + '<section class="panel stack"><p class="eyebrow">送信済み</p>' + (lines.length ? '<table>' + lines.join('') + '<tr><th>合計</th><th class="n">' + b.total + '</th></tr></table>' : '<p>入札なしで送信しました。</p>') + '<p class="quiet">結果はスクリーンで発表します。</p></section>';
    }
    if (PUI.bidStep === 'confirm') {
      const d = PUI.bid;
      const lines = E.PUBLIC_ROLES.filter((k) => E.toInt(d.amounts[k]) > 0).map((k) => '<tr><td>' + E.ROLE_JA[k] + '</td><td class="n">' + E.toInt(d.amounts[k]) + '</td></tr>');
      if (String(d.free.text).trim()) lines.push('<tr><td>' + esc(d.free.text) + '</td><td class="n">' + E.toInt(d.free.amount) + '</td></tr>');
      const chk = E.checkBid(d, declared);
      return timer + '<section class="panel stack"><p class="eyebrow">この内容で送信しますか</p>' + (lines.length ? '<table>' + lines.join('') + '<tr><th>合計</th><th class="n">' + chk.total + ' / ' + declared + '</th></tr></table>' : '<p>入札なしで送信します。</p>') +
        '<p class="alert">送信したあとは変更できません。</p><button class="btn btn-main btn-big" data-act="bidSubmit">送信する</button><button class="btn" data-act="bidBack">戻って直す</button></section>';
    }
    const d = PUI.bid;
    const rows = E.PUBLIC_ROLES.map((k) => '<div class="bid-row"><div><span class="rn">' + E.ROLE_JA[k] + '</span><small>1パターン ' + E.roleBonusOf(k, r) + 'チップ</small></div><input id="bid-' + k + '" data-bid="' + k + '" inputmode="numeric" pattern="[0-9]*" placeholder="—" value="' + esc(d.amounts[k] || '') + '" aria-label="' + E.ROLE_JA[k] + 'の入札額"></div>').join('');
    const free = '<div class="bid-row free"><div><input id="bid-free-text" class="ft" data-free="text" placeholder="その他の役名(自由記入)" value="' + esc(d.free.text) + '" aria-label="その他の役名"></div><input id="bid-free-amt" data-free="amount" inputmode="numeric" pattern="[0-9]*" placeholder="—" value="' + esc(d.free.amount) + '" aria-label="その他の役の入札額"></div>';
    const chk = E.checkBid(d, declared);
    return timer + '<div class="tray" style="padding-block:8px"><div class="sum-bar"><span>入札の合計 / 所持</span><span><b id="bid-total" class="count ' + (chk.total > declared ? 'over' : '') + '">' + (Number.isNaN(chk.total) ? '—' : chk.total) + '</b> <span class="quiet">/ ' + declared + '</span></span></div></div>' +
      '<p class="quiet">入札は1回だけ。合計は所持チップまで。入れない役は空欄のままにしてください。</p>' +
      '<div class="bid-list">' + rows + free + '</div><div id="bid-err" class="stack" role="alert">' + PUI.bidErr.map((m) => '<p class="alert">' + esc(m) + '</p>').join('') + '</div>' +
      '<div class="bottom-bar"><button class="btn btn-main btn-big" data-act="bidConfirm">内容を確かめる</button></div>';
  }
  function resultHtml(g, me) {
    const rd = g.rounds[g.round] || {};
    const st = rd.settle && rd.settle[me.seat];
    if (!st) return msg('スクリーンをご覧ください', '');
    const big = st.payout >= 0 ? '<p class="eyebrow">受け取るチップ</p><p class="disp-big-num plus" style="font-size:64px">' + signed(st.payout) + '</p>' : '<p class="eyebrow">渡すチップ</p><p class="disp-big-num minus" style="font-size:64px">' + Math.abs(st.payout) + '</p>';
    return '<section class="panel stack" style="text-align:center">' + big +
      '<table><tr><td>順位ボーナス</td><td class="n">' + st.rankBonus + '</td></tr><tr><td>役ボーナスの合計</td><td class="n">' + st.roleBonus + '</td></tr><tr><td>オークションの支払い</td><td class="n">−' + st.paid + '</td></tr></table>' +
      '<p class="quiet">係がこの額でチップを受け渡しします。</p></section>';
  }
  function finalMineHtml(g, me) {
    const row = (g.final || []).find((x) => x.seat === me.seat);
    const pos = (g.final || []).findIndex((x) => x.seat === me.seat) + 1;
    return msg('おつかれさまでした', '') + (row ? '<section class="panel stack" style="text-align:center"><p class="eyebrow">最終チップ(計算上)</p><p class="disp-big-num" style="font-size:64px">' + (row.chips ?? '—') + '</p><p class="quiet">' + pos + '位</p></section>' : '');
  }
  function afterPlayerRender() {
    const code = document.getElementById('join-code');
    if (code && !code.value) code.focus();
  }

  /* 落札結果の行。GMの読み上げと会場画面の一覧で同じ行を使う(オールスターは落札があったときだけ出す) */
  function resultRows(g) {
    const t = (g.rounds[g.round] || {}).tally;
    return t ? t.roles.filter((x) => x.role !== 'ALL_STAR' || x.winner) : [];
  }
  const nBids = (x) => (x.bids ? x.bids.length : (x.bidsCount || 0));

  /* ================= 会場画面 ================= */
  function displayHtml() {
    const g = G();
    const band = (r) => '<header class="disp-band"><span class="wordmark"><i>The</i> Auction Poker</span><span class="disp-round">' + (r ? 'ROUND ' + r : '') + '</span></header>';
    if (!g) return '<div class="disp">' + band(0) + '<div class="disp-body"><p class="disp-title"><i>The</i> Auction Poker</p></div></div>';
    const r = g.round;
    let body = '';
    switch (g.phase) {
      case 'SETUP': body = '<p class="disp-title"><i>The</i> Auction Poker</p><p class="disp-sub">まもなく開始します</p>'; break;
      case 'READY': body = '<p class="disp-title">ROUND ' + r + '</p><p class="disp-sub">まもなく開始します</p>'; break;
      case 'FREE': body = '<p class="disp-sub">交渉タイム</p><p class="count disp-count" ' + clockAttr(g) + '></p>'; break;
      case 'ENTRY': body = '<p class="disp-sub">カード提出</p><p class="disp-big-num num">' + progressOf(g).entries + '<span class="quiet" style="font-size:.5em"> / 10</span></p><p class="disp-sub">手元の画面で、カード5枚と所持チップを入力してください</p>'; break;
      case 'JUDGED': body = '<p class="disp-title">SHOWDOWN</p><p class="disp-sub">まもなく発表します</p>'; break;
      case 'SHOWDOWN': {
        const rows = ((g.rounds[r] || {}).judge || []).filter((x) => x.pos <= 5);
        body = '<p class="disp-title">SHOWDOWN</p><table class="disp-table">' + '<tr><th>順位</th><th>プレイヤー</th><th class="n">順位ボーナス</th></tr>' + rows.map((x) => '<tr><td class="pos">' + x.pos + '</td><td>' + esc(seatName(g, x.seat)) + '</td><td class="n amt">' + x.bonus + '</td></tr>').join('') + '</table>';
        break;
      }
      case 'AUCTION': body = '<p class="disp-title">AUCTION TIME</p><p class="count disp-count" ' + clockAttr(g) + '></p><p class="disp-sub">送信 <span class="num">' + progressOf(g).bids + '</span> / ' + bidTargets(g).length + '</p>'; break;
      case 'TALLIED': body = '<p class="disp-title">RESULT</p><p class="disp-sub">落札結果を発表します</p>'; break;
      case 'RESULT': {
        const rows = resultRows(g);
        body = '<p class="disp-title">RESULT</p><table class="disp-table"><tr><th>役</th><th>落札者</th><th class="n">落札額</th></tr>' + rows.map((x) => '<tr><td>' + E.ROLE_JA[x.role] + '</td><td>' + (x.winner ? esc(seatName(g, x.winner)) : '<span class="quiet">' + (nBids(x) ? '落札なし' : '入札なし') + '</span>') + '</td><td class="n amt">' + (x.winner ? x.top : '—') + '</td></tr>').join('') + '</table>';
        break;
      }
      case 'FINAL': {
        const rows = g.final || [];
        body = '<p class="disp-title">FINAL</p><table class="disp-table"><tr><th>順位</th><th>プレイヤー</th><th class="n">チップ</th></tr>' + rows.map((x, i) => { const pos = i > 0 && rows[i - 1].chips === x.chips ? null : i + 1; return '<tr><td class="pos">' + (pos || '') + '</td><td>' + esc(seatName(g, x.seat)) + '</td><td class="n amt">' + (x.chips ?? '—') + '</td></tr>'; }).join('') + '</table>';
        break;
      }
      default: body = '';
    }
    return '<div class="disp">' + band(r) + '<div class="disp-body">' + body + '</div></div>';
  }

  /* ================= GM ================= */
  const GUI = { tab: 'seats', armed: null, armedAt: 0, mode: 'test', fast: false, dealEdit: false };
  function armBtn(actName, label, cls) {
    const armed = GUI.armed === actName && now() - GUI.armedAt < 4000;
    return '<button class="btn btn-small ' + (armed ? 'btn-armed' : (cls || '')) + '" data-act="arm" data-a="' + actName + '">' + (armed ? 'もう一度押すと実行' : label) + '</button>';
  }
  const gmTop = (inner) => '<div class="gm-top"><div class="wrap"><span class="wordmark"><i>The</i> Auction Poker</span>' + inner + '<a class="btn btn-small" href="#" style="margin-left:auto">ホーム</a></div></div>';
  function gmLoginHtml() {
    const other = !Store.anon && Store.email;
    return gmTop('<span class="pill brass">GM</span>') + '<div class="wrap narrow stack"><section class="panel stack"><p class="eyebrow">GMのログイン</p><h2>GMとして登録した Google アカウントでログインしてください</h2>' +
      (other ? '<p class="alert">いまのアカウント ' + esc(Store.email) + ' はGMとして登録されていません。</p>' : '<p class="quiet">会場画面とプレイヤーの画面はログインなしで使えます。</p>') +
      '<button class="btn btn-main btn-big" data-act="gmLogin">Google でログイン</button>' + (other ? '<button class="btn" data-act="logout">ログアウト</button>' : '') + '</section></div>';
  }
  function gmHtml() {
    if (Store.kind === 'shared' && !Store.isGM) return gmLoginHtml();
    const g = G();
    const who = Store.kind === 'shared' ? '<span class="pill">' + esc(Store.email || '') + '</span>' : '';
    if (!g) {
      return gmTop('<span class="pill brass">GM</span>' + who) + '<div class="wrap narrow stack"><section class="panel stack"><p class="eyebrow">新しいゲーム</p><h2>ゲームを作る</h2><p class="quiet">10席ぶんの参加コードを作ります。</p>' +
        '<div class="row"><span class="grow">種類</span><span class="seg"><button data-act="gmode" data-v="test" aria-pressed="' + (GUI.mode === 'test') + '">TEST</button><button data-act="gmode" data-v="live" aria-pressed="' + (GUI.mode === 'live') + '">本番</button></span></div>' +
        (GUI.mode === 'test' ? '<label class="row"><input type="checkbox" id="fast" data-act="gfast"' + (GUI.fast ? ' checked' : '') + '> <span>時計を1/10にする(稽古用: 自由時間2分、オークション30秒)</span></label>' : '') +
        '<button class="btn btn-main btn-big" data-act="create">ゲームを作る</button></section>' + (E.hasDeals() ? '' : dealsPanel()) + '</div>';
    }
    const r = g.round;
    const timer = g.timerEndsAt ? '<span class="count num" ' + clockAttr(g) + '></span>' : '';
    const head = gmTop('<span class="pill brass">' + (r ? 'R' + r + ' · ' : '') + LABEL[g.phase] + '</span>' + (timer ? '<span class="pill">' + timer + '</span>' : '') +
      '<span class="pill ' + (g.mode === 'live' ? 'warn' : '') + '">' + (g.mode === 'live' ? '本番' : 'TEST') + (g.fast ? ' · 時計1/10' : '') + '</span><span class="pill">' + (Store.kind === 'shared' ? '共有' : 'この端末だけ') + '</span>' + who);
    const c = cue(g);
    const press = pressLabel(g);
    let main = '';
    let note = '';
    if (g.phase === 'FREE') note = '時計が0:00になると自動でカード提出に進みます。' + (nextRevealAt(g) ? ' 卓で次の共通カードをめくるまで <span class="num" data-end="' + nextRevealAt(g) + '"></span>。' : '');
    if (g.phase === 'ENTRY') { const st = entryStatus(g); note = '提出 <b>' + st.count + '/10</b>。全員そろい、警告がなければ自動でジャッジします。' + (st.alerts.length ? ' <span class="minus">警告があるため止まっています。</span>' : ''); }
    if (g.phase === 'TALLIED') note = '下の一覧をワンペアから順に読み上げてから公開します。スクリーンにはまだ出ていません。';
    if (g.phase === 'RESULT') note = 'スクリーンに同じ一覧が出ています。';
    const readout = g.phase === 'TALLIED' || g.phase === 'RESULT' ? readoutHtml(g) : '';
    if (g.phase === 'AUCTION') note = '送信 <b>' + bidCount(g) + '/' + bidTargets(g).length + '</b>。全員の入札がそろうか、時計が0:00になると、自動で締め切って集計します(まだ公開しません)。';
    if (press && !Store.readOnly) main = '<button class="btn btn-main btn-big" data-act="advance">' + press + '</button>';
    else if (!press && g.phase !== 'FINAL') main = '<p class="pill">自動で進みます</p>';
    const steps = '<div class="steps" aria-label="ラウンドの進行">' + ORDER.map((p) => { const i = ORDER.indexOf(p), ci = ORDER.indexOf(g.phase); return '<span class="' + (i < ci ? 'done' : i === ci ? 'cur' : '') + '">' + (PRESS[p] || p === 'RESULT' ? '★' : '') + LABEL[p] + '</span>'; }).join('') + '</div>';
    const nextPh = ORDER[ORDER.indexOf(g.phase) + 1];
    const dealWarn = E.hasDeals() ? '' : '<p class="alert">配札表が読み込まれていません。「設定」のタブで貼ってください。</p>';
    const nowPanel = '<section class="panel stack now"><div class="row"><p class="eyebrow grow">今</p>' + (g.timerEndsAt ? '<span class="count" ' + clockAttr(g) + '></span>' : '') + '</div>' +
      '<h2>' + (r ? 'ラウンド' + r + ' · ' : '') + LABEL[g.phase] + '</h2>' + dealWarn + (note ? '<p>' + note + '</p>' : '') + readout + main + (g.phase === 'FINAL' ? finalTable(g) + '<div class="stack">' + newGameHtml() + '</div>' : '') +
      '<dl class="cue"><dt>司会</dt><dd>「' + esc(c.mc) + '」</dd><dt>係</dt><dd>' + esc(c.staff) + '</dd></dl>' +
      (r ? steps + (nextPh ? '<p class="quiet">次: ' + LABEL[nextPh] + '</p>' : (g.phase === 'RESULT' && r < 4 ? '<p class="quiet">次: ラウンド' + (r + 1) + 'の準備</p>' : '')) : '') + debugHtml(g) + '</section>';
    const alerts = alertsHtml(g);
    const tabs = [['seats', '席'], ['judge', 'ジャッジ'], ['bids', '入札'], ['payout', '払い出し'], ['config', '設定'], ['ops', '緊急']];
    const tabBar = '<div class="tabs" role="tablist">' + tabs.map(([k, l]) => '<button role="tab" data-act="tab" data-v="' + k + '" aria-selected="' + (GUI.tab === k) + '">' + l + '</button>').join('') + '</div>';
    let tabBody = '';
    if (GUI.tab === 'seats') tabBody = seatsHtml(g);
    else if (GUI.tab === 'judge') tabBody = judgeHtml(g);
    else if (GUI.tab === 'bids') tabBody = bidsHtml(g);
    else if (GUI.tab === 'payout') tabBody = payoutHtml(g);
    else if (GUI.tab === 'config') tabBody = configHtml(g);
    else tabBody = opsHtml(g);
    return head + '<div class="wrap stack"><div class="gm-grid"><div class="stack">' + nowPanel + alerts + '</div><section class="panel" style="padding-top:8px">' + tabBar + tabBody + '</section></div></div>';
  }
  function debugHtml(g) {
    if (g.mode !== 'test' || g.phase === 'FINAL') return '';
    const timed = (g.phase === 'FREE' || g.phase === 'AUCTION') && g.timerEndsAt;
    const b = (a, l) => '<button class="btn btn-small" data-act="' + a + '">' + l + '</button>';
    return '<div class="debug stack"><p class="eyebrow">デバッグ(TESTのときだけ)</p><div class="row">' +
      (timed ? b('timerZero', '時計を0にする') + b('timer10', '残り10秒にする') : '') +
      (g.phase === 'ENTRY' ? b('fillCards', '全席のカードを配札どおりに入れる') : '') +
      (g.phase === 'AUCTION' ? b('fillBids', '全席にランダムな入札を入れる') : '') +
      b('forceNext', '強制で次の段へ') +
      (g.phase !== 'RESULT' && g.phase !== 'SETUP' ? b('autoRound', 'このラウンドを落札結果まで自動で進める') : '') +
      '</div></div>';
  }
  /* 読み上げ用の落札結果(会場画面の一覧と同じ行・同じ順) */
  function readoutHtml(g) {
    const rows = resultRows(g);
    if (!rows.length) return '';
    return '<div class="tbl-wrap"><table class="readout"><tr><th>役</th><th>落札者</th><th class="n">落札額</th></tr>' + rows.map((x) => '<tr><td><b>' + E.ROLE_JA[x.role] + '</b></td><td>' + (x.winner ? '<b>' + esc(seatName(g, x.winner)) + '</b> <small>' + x.winner + '席</small>' : '<span class="quiet">' + (nBids(x) ? '落札なし(同額)' : '入札なし') + '</span>') + '</td><td class="n">' + (x.winner ? '<span class="amt">' + x.top + '</span>' : '<span class="quiet">—</span>') + '</td></tr>').join('') + '</table></div>';
  }
  function finalTable(g) {
    const rows = g.final || [];
    return '<div class="tbl-wrap"><table><tr><th>順位</th><th>席</th><th class="n">計算上のチップ</th></tr>' + rows.map((x, i) => '<tr><td class="n">' + (i + 1) + '</td><td>' + x.seat + ' ' + esc(seatName(g, x.seat)) + '</td><td class="n">' + (x.chips ?? '—') + '</td></tr>').join('') + '</table></div>';
  }
  function alertsHtml(g) {
    const r = g.round;
    const items = [];
    if (g.phase === 'ENTRY') entryStatus(g).alerts.forEach((a) => items.push('<p class="alert">' + esc(a.text) + '</p>'));
    if (r > 1 && (g.phase === 'ENTRY' || g.phase === 'JUDGED')) {
      const prev = g.rounds[r - 1] && g.rounds[r - 1].settle;
      if (prev) SEATS.forEach((s) => { const e = entryOf(g, r, s); if (e && prev[s] && prev[s].balance != null && e.chips !== prev[s].balance) items.push('<p class="alert info">' + s + '席の申告 ' + e.chips + '(前回の計算 ' + prev[s].balance + '、差 ' + signed(e.chips - prev[s].balance) + ')</p>'); });
    }
    const rd = g.rounds[r];
    if (rd && rd.forced) items.push('<p class="alert info">このラウンドは未提出のまま締め切りました。</p>');
    if (!items.length) return '';
    return '<section class="panel stack"><p class="eyebrow">警告と参考</p>' + items.join('') + '</section>';
  }
  function seatsHtml(g) {
    const r = g.round;
    const setup = g.phase === 'SETUP';
    const rd = g.rounds[r] || {};
    const rows = SEATS.map((s) => {
      const e = r ? entryOf(g, r, s) : null;
      const b = r ? bidOf(g, r, s) : null;
      const j = joinedOf(g, s);
      const st = rd.settle && rd.settle[s];
      return '<tr><td><b>' + s + '</b> <span class="dot ' + (j ? 'on' : '') + '" title="' + (j ? '参加済み' : '未参加') + '"></span></td>' +
        '<td>' + (setup ? '<input class="name-input" data-name="' + s + '" value="' + esc(seatName(g, s)) + '" aria-label="' + s + '席の名前">' : esc(seatName(g, s))) + '</td>' +
        '<td class="code">' + esc(g.seats[s].code) + '</td>' +
        (setup ? '' : '<td>' + (e ? miniCards(e.cards) : '<span class="quiet">—</span>') + '</td><td class="n">' + (e ? e.chips : '—') + '</td><td>' + (b ? '<span class="pill ok">済</span>' : '<span class="quiet">—</span>') + '</td><td class="n">' + (st ? '<span class="' + (st.payout >= 0 ? 'plus' : 'minus') + '">' + signed(st.payout) + '</span>' : '') + '</td>') +
        '<td><button class="btn btn-small" data-act="proxy" data-seat="' + s + '">代理</button></td></tr>';
    }).join('');
    return '<div class="tbl-wrap"><table><tr><th>席</th><th>名前</th><th>コード</th>' + (setup ? '' : '<th>カード</th><th class="n">チップ</th><th>入札</th><th class="n">払い出し</th>') + '<th></th></tr>' + rows + '</table></div>' +
      (setup ? '<div class="row" style="margin-top:12px"><button class="btn btn-small" data-act="recode">コードを作り直す</button><small class="quiet">● は参加済み。名前を変えると会場画面の表示も変わります。</small></div>' : '<p class="quiet" style="margin-top:8px;font-size:13px">「代理」でその席の画面を開き、GMが代わりに入力できます。</p>') +
      '<p class="quiet" style="margin-top:8px;font-size:13px">プレイヤーのページ: <span class="url">' + esc(playerUrl()) + '</span></p>';
  }
  function judgeHtml(g) {
    const rd = g.rounds[g.round];
    if (!rd || !rd.judge) return '<p class="quiet">カード提出を締め切るとここに1〜10位が出ます。</p>';
    return '<div class="tbl-wrap"><table><tr><th>順位</th><th>席</th><th>役</th><th>最強の5枚</th><th>提出した5枚</th><th class="n">ボーナス</th></tr>' + rd.judge.map((x) => '<tr><td class="n">' + x.pos + '</td><td>' + x.seat + ' ' + esc(seatName(g, x.seat)) + '</td><td>' + x.name + '</td><td>' + miniCards(x.best) + '</td><td>' + miniCards(rd.cards[x.seat]) + '</td><td class="n">' + x.bonus + '</td></tr>').join('') + '</table></div>' +
      (E.hasDeals() ? '<p class="quiet" style="font-size:13px">共通カード: ' + E.community(g.round).map(ct).join(' ') + '</p>' : '');
  }
  function bidsHtml(g) {
    const r = g.round;
    const rd = g.rounds[r] || {};
    if (rd.tally) {
      return '<div class="tbl-wrap"><table><tr><th>役</th><th>入札(高い順)</th><th>落札</th><th class="n">落札額</th><th>成立したパターン</th><th class="n">役ボーナス</th></tr>' + rd.tally.roles.map((x) => '<tr><td>' + E.ROLE_JA[x.role] + '</td><td>' + (x.bids.map((b) => b.seat + ':' + b.amount).join(' ') || '<span class="quiet">なし</span>') + '</td><td>' + (x.winner ? x.winner : (x.tie ? '<span class="minus">同額で落札なし</span>' : '—')) + '</td><td class="n">' + (x.winner ? x.top : '') + '</td><td class="wrapcell">' + (x.winner ? (x.patterns.length ? esc(x.patterns.join('、')) : '<span class="quiet">不成立</span>') : '') + '</td><td class="n">' + (x.winner ? x.reward : '') + '</td></tr>').join('') + '</table></div>';
    }
    if (g.phase !== 'AUCTION') return '<p class="quiet">オークションが始まると送信の状況、締め切ると役ごとの結果が出ます。</p>';
    return '<div class="tbl-wrap"><table><tr><th>席</th><th>入札</th><th class="n">合計</th></tr>' + SEATS.map((s) => { const b = bidOf(g, r, s); if (!b) return '<tr><td>' + s + '</td><td class="quiet">未送信</td><td></td></tr>'; const parts = E.PUBLIC_ROLES.filter((k) => E.toInt(b.amounts[k]) > 0).map((k) => E.ROLE_JA[k] + ' ' + E.toInt(b.amounts[k])); if (b.free && b.free.text) parts.push('「' + esc(b.free.text) + '」 ' + E.toInt(b.free.amount)); return '<tr><td>' + s + '</td><td class="wrapcell">' + (parts.join('、') || '入札なし') + '</td><td class="n">' + b.total + '</td></tr>'; }).join('') + '</table></div>';
  }
  function payoutHtml(g) {
    const rd = g.rounds[g.round] || {};
    if (!rd.settle) return '<p class="quiet">オークションを締め切るとここに席ごとの払い出し額が出ます。</p>';
    return '<div class="tbl-wrap"><table><tr><th>席</th><th class="n">順位B</th><th class="n">役B</th><th class="n">支払</th><th class="n">払い出し</th><th class="n">申告</th><th class="n">計算上の残高</th></tr>' + SEATS.map((s) => { const x = rd.settle[s]; return '<tr><td>' + s + ' ' + esc(seatName(g, s)) + '</td><td class="n">' + x.rankBonus + '</td><td class="n">' + x.roleBonus + '</td><td class="n">' + x.paid + '</td><td class="n"><b class="' + (x.payout >= 0 ? 'plus' : 'minus') + '">' + (x.payout >= 0 ? '渡す ' + x.payout : '回収 ' + Math.abs(x.payout)) + '</b></td><td class="n">' + (x.declared ?? '—') + '</td><td class="n">' + (x.balance ?? '—') + '</td></tr>'; }).join('') + '</table></div><p class="quiet" style="font-size:13px">払い出し = 順位ボーナス + 役ボーナスの合計 − オークションの支払い</p>';
  }
  function dealsPanel() {
    return '<section class="panel stack"><p class="eyebrow">配札表(GMだけが読める所に置く)</p><p class="quiet">配札表はページの中に入れていません。渡された配札表(JSON)をここに貼って読み込んでください。一度読み込めば、同じアカウントのGMの画面ではどの端末でも使えます。</p>' +
      '<textarea id="deals-input" class="deal-input" spellcheck="false" aria-label="配札表"></textarea><button class="btn btn-main" data-act="dealsLoad">配札表を読み込む</button></section>';
  }
  function configHtml(g) {
    const rb = '<table><tr><th>順位</th><th class="n">R1</th><th class="n">R2</th><th class="n">R3</th><th class="n">R4</th></tr>' + [0, 1, 2, 3, 4].map((i) => '<tr><td>' + (i + 1) + '位</td>' + [1, 2, 3, 4].map((r) => '<td class="n">' + C.rankBonus[r][i] + '</td>').join('') + '</tr>').join('') + '</table>';
    const ro = '<table><tr><th>役</th><th class="n">R1</th><th class="n">R2</th><th class="n">R3</th><th class="n">R4</th></tr>' + E.ROLES.map((k) => '<tr><td>' + E.ROLE_JA[k] + '</td>' + [0, 1, 2, 3].map((i) => '<td class="n">' + (C.roleBonus[k][i] || '—') + '</td>').join('') + '</tr>').join('') + '</table>';
    const r = g.round || 1;
    let deal = '';
    if (E.hasDeals() && !GUI.dealEdit) {
      deal = '<p class="eyebrow">配札(GMだけが見る)</p><div class="tbl-wrap"><table><tr><th>席</th><th>配札(R' + r + ')</th></tr>' + SEATS.map((s) => '<tr><td>' + s + '</td><td>' + miniCards(E.dealt(r, s)) + '</td></tr>').join('') + '<tr><td>共通</td><td>' + miniCards(E.community(r)) + '</td></tr></table></div>' +
        '<div class="row"><button class="btn btn-small" data-act="dealEdit">配札表を貼り直す</button></div>';
    } else deal = dealsPanel();
    return '<div class="stack"><p><b>' + esc(C.version) + '</b><br><small>' + esc(C.note) + '</small></p><p class="eyebrow">順位ボーナス</p><div class="tbl-wrap">' + rb + '</div><p class="eyebrow">役ボーナス(1パターンあたり)</p><div class="tbl-wrap">' + ro + '</div>' + deal + '</div>';
  }
  function newGameHtml() {
    return '<p class="eyebrow" style="margin-top:8px">リセット(新しいゲームを作る)</p><div class="row"><span class="seg" role="group" aria-label="新しいゲームの種類"><button data-act="gmode" data-v="test" aria-pressed="' + (GUI.mode === 'test') + '">TEST</button><button data-act="gmode" data-v="live" aria-pressed="' + (GUI.mode === 'live') + '">本番</button></span>' +
      (GUI.mode === 'test' ? '<label class="row"><input type="checkbox" id="fast" data-act="gfast"' + (GUI.fast ? ' checked' : '') + '> <span>時計を1/10</span></label>' : '') +
      armBtn('reset', 'リセットして' + (GUI.mode === 'live' ? '本番' : 'TEST') + 'のゲームを作る', 'btn-danger') + '</div><small class="quiet">今のゲームを消して、参加コードも作り直し、受付から始めます。押し間違えないよう、二度押しです。</small>';
  }
  function opsHtml(g) {
    const timed = g.phase === 'FREE' || g.phase === 'AUCTION';
    let html = '<div class="stack"><p class="eyebrow">緊急</p><div class="row">' + armBtn('back', '段を1つ戻す', 'btn-danger') +
      (timed ? '<button class="btn btn-small" data-act="extend">時計を1分延ばす</button>' + armBtn('closeNow', '今すぐ締め切る', 'btn-danger') : '') +
      (g.phase === 'ENTRY' ? armBtn('closeNow', '未提出のまま締め切る', 'btn-danger') : '') + '</div>';
    html += newGameHtml();
    html += '<p class="eyebrow" style="margin-top:8px">この試合の種類</p><div class="row"><span class="seg" role="group" aria-label="この試合の種類"><button data-act="setMode" data-v="test" aria-pressed="' + (g.mode === 'test') + '">TEST</button><button data-act="setMode" data-v="live" aria-pressed="' + (g.mode === 'live') + '">本番</button></span><small class="quiet">TESTのときは「今」の欄にデバッグの操作が出ます。</small></div>' +
      '<div class="row"><a class="btn btn-small" href="#display" target="_blank" rel="noopener">会場画面を別タブで開く</a>' + (Store.kind === 'shared' ? '<button class="btn btn-small" data-act="logout">ログアウト</button>' : '') + '</div>';
    html += '<p class="eyebrow" style="margin-top:8px">操作の記録</p><div class="tbl-wrap"><table>' + (g.log || []).slice().reverse().map((l) => '<tr><td class="num quiet" style="white-space:nowrap">' + new Date(l.t).toLocaleTimeString('ja-JP') + '</td><td class="wrapcell">' + esc(l.msg) + '</td></tr>').join('') + '</table></div></div>';
    return html;
  }

  /* ================= 押したときの処理 ================= */
  const handlers = {
    reload() { location.reload(); },
    mode(el) { ls.set('ap.mode', el.dataset.v); location.reload(); },
    gmLogin() { if (Store.login) Store.login(); },
    logout() { if (Store.logout) Store.logout(); },
    gmode(el) { GUI.mode = el.dataset.v; render(true); },
    gfast(el) { GUI.fast = el.checked; },
    create(el) { el.disabled = true; act.createGame({ mode: GUI.mode, fast: GUI.mode === 'test' && GUI.fast }); },
    advance(el) { el.disabled = true; act.advance(); },
    closeNow() { act.closeNow(); },
    extend() { act.extend(); },
    tab(el) { GUI.tab = el.dataset.v; render(true); },
    recode() { act.recode(); },
    fillCards() { act.fillCards(); },
    fillBids() { act.fillBids(); },
    timerZero() { act.timerZero(); },
    timer10() { act.timer10(); },
    forceNext() { act.forceNext(); },
    autoRound(el) { el.disabled = true; act.autoRound(); },
    setMode(el) { act.setMode(el.dataset.v); },
    dealEdit() { GUI.dealEdit = true; render(true); },
    async dealsLoad() {
      const t = (document.getElementById('deals-input') || {}).value || '';
      let d = null;
      try { d = JSON.parse(t); } catch (e) { toast('配札表(JSON)が読めません。貼り付けを確かめてください'); return; }
      const errs = E.checkDeals(d);
      if (errs.length) { toast('配札表に誤りがあります: ' + errs.slice(0, 2).join(' / ')); return; }
      await Store.setDeals(d);
      GUI.dealEdit = false;
      toast('配札表を読み込みました');
      render(true);
    },
    arm(el) {
      const a = el.dataset.a;
      if (GUI.armed === a && now() - GUI.armedAt < 4000) { GUI.armed = null; act[a](); }
      else { GUI.armed = a; GUI.armedAt = now(); setTimeout(() => { if (GUI.armed === a) { GUI.armed = null; render(true); } }, 4100); }
      render(true);
    },
    proxy(el) { ss.set('ap.proxy', el.dataset.seat); location.hash = 'play'; },
    proxyExit() { ss.del('ap.proxy'); PUI.key = ''; location.hash = 'gm'; },
    async join(el) {
      const g = G();
      if (!g || PUI.busy) return;
      const v = (document.getElementById('join-code').value || '').normalize('NFKC').toUpperCase().replace(/\s/g, '');
      PUI.join = v;
      const errEl = document.getElementById('join-err');
      PUI.busy = true;
      if (el) el.disabled = true;
      const hit = await Store.lookupCode(v);
      PUI.busy = false;
      if (el) el.disabled = false;
      if (!hit || hit.gameId !== g.id) { if (errEl) errEl.textContent = 'コードを確かめてください。'; return; }
      PUI.joinSeat = hit.seat;
      PUI.joinCode = v;
      render(true);
    },
    async joinYes(el) {
      const g = G();
      const s = PUI.joinSeat;
      el.disabled = true;
      try { await Store.setMember({ gameId: g.id, seat: s, code: PUI.joinCode }); }
      catch (e) { el.disabled = false; toast('参加できませんでした。コードを入れ直してください(' + errText(e) + ')'); PUI.joinSeat = null; render(true); return; }
      ls.set('ap.seat.' + g.id, s);
      PUI.joinSeat = null;
      render(true);
    },
    joinNo() { PUI.joinSeat = null; render(true); },
    pick(el) {
      const id = el.dataset.id;
      const i = PUI.pick.indexOf(id);
      if (i >= 0) PUI.pick.splice(i, 1);
      else if (PUI.pick.length >= 5) { toast('5枚まで選べます。外してから選んでください。'); return; }
      else PUI.pick.push(id);
      PUI.rev++;
      render(true);
    },
    unpick(el) { const i = PUI.pick.indexOf(el.dataset.id); if (i >= 0) PUI.pick.splice(i, 1); PUI.rev++; render(true); },
    entryConfirm() {
      const chips = E.toInt(PUI.chips);
      if (PUI.pick.length !== 5) return;
      if (Number.isNaN(chips) || PUI.chips === '') { toast('所持チップを数字で入れてください'); document.getElementById('chips').focus(); return; }
      if (chips > 9999) { toast('所持チップが大きすぎます。確かめてください'); return; }
      PUI.chips = String(chips);
      PUI.step = 'confirm';
      render(true);
    },
    entryBack() { PUI.step = 'edit-again'; render(true); },
    reedit() { PUI.step = 'edit-again'; render(true); },
    async entrySubmit(el) {
      const g = G();
      if (g.phase !== 'ENTRY') { toast('カード提出は締め切られました'); return; }
      const me = mySeat(g);
      el.disabled = true;
      try {
        await Store.putDoc('entries', entryId(g, g.round, me.seat), { gameId: g.id, round: g.round, seat: me.seat, cards: PUI.pick.slice(), chips: E.toInt(PUI.chips), submittedAt: now(), by: me.proxy ? 'gm' : 'player' });
        PUI.step = 'done';
      } catch (e) { el.disabled = false; PUI.step = 'confirm'; }
      render(true);
    },
    bidConfirm() {
      const g = G();
      const me = mySeat(g);
      const declared = g.rounds[g.round].chips[me.seat];
      const chk = E.checkBid(PUI.bid, declared);
      PUI.bidErr = chk.errors;
      if (chk.ok) PUI.bidStep = 'confirm';
      render(true);
    },
    bidBack() { PUI.bidStep = 'edit'; render(true); },
    async bidSubmit(el) {
      const g = G();
      const me = mySeat(g);
      if (g.phase !== 'AUCTION' || (g.timerEndsAt && now() > g.timerEndsAt)) { toast('オークションは締め切られました'); return; }
      const rd = g.rounds[g.round];
      const chk = E.checkBid(PUI.bid, rd.chips[me.seat]);
      if (!chk.ok) { PUI.bidErr = chk.errors; PUI.bidStep = 'edit'; render(true); return; }
      el.disabled = true;
      const amounts = {};
      E.PUBLIC_ROLES.forEach((k) => { const v = E.toInt(PUI.bid.amounts[k]); if (v > 0) amounts[k] = v; });
      const free = { text: String(PUI.bid.free.text || '').trim(), amount: E.toInt(PUI.bid.free.amount) || 0 };
      try { await Store.putDoc('bids', entryId(g, g.round, me.seat), { gameId: g.id, round: g.round, seat: me.seat, amounts, free, total: chk.total, submittedAt: now(), by: me.proxy ? 'gm' : 'player' }); }
      catch (e) { el.disabled = false; }
      render(true);
    }
  };
  handlers.reset = () => act.reset();
  handlers.back = () => act.back();
  app.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || !app.contains(el)) return;
    const a = el.dataset.act;
    if (a === 'gfast') { handlers.gfast(el); return; }
    if (handlers[a]) { ev.preventDefault(); handlers[a](el); }
  });
  app.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.id === 'chips') PUI.chips = el.value;
    else if (el.id === 'join-code') PUI.join = el.value;
    else if (el.dataset.bid) { PUI.bid.amounts[el.dataset.bid] = el.value; updateBidTotal(); }
    else if (el.dataset.free) { PUI.bid.free[el.dataset.free] = el.value; updateBidTotal(); }
  });
  app.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.dataset.name) act.rename(el.dataset.name, el.value);
  });
  app.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.id === 'join-code') handlers.join(null); });
  function updateBidTotal() {
    const g = G();
    const me = mySeat(g);
    const declared = g.rounds[g.round] && g.rounds[g.round].chips[me.seat];
    const chk = E.checkBid(PUI.bid, declared);
    const el = document.getElementById('bid-total');
    if (el) { el.textContent = Number.isNaN(chk.total) ? '—' : chk.total; el.classList.toggle('over', chk.total > declared); }
  }

  render(true);
  initStore();
})();
