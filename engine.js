/* THE AUCTION POKER — 判定・集計エンジン(ブラウザとNodeの両方で動く)
   配札表はこのファイルに入れない(公開のリポジトリに置くため)。GMの画面が読み込んで setDeals で渡す。 */
(function (root) {
  'use strict';

  const SUITS = ['s', 'h', 'd', 'c'];
  const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const SYM_SUIT = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' };
  const RANK_CH = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const CH_RANK = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
  const RANK_LABEL = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const JOKER = 'JK';
  const SEATS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

  const DECK = [];
  for (const s of SUITS) for (let r = 14; r >= 2; r--) DECK.push(RANK_CH[r] + s);

  function parseCard(str) {
    str = String(str).trim();
    if (/^(JOKER|JK|ジョーカー)$/i.test(str)) return JOKER;
    const m = str.match(/^(10|[2-9TJQKA])\s*([♠♥♦♣shdcSHDC])$/i);
    if (!m) throw new Error('カードを読めません: ' + str);
    const r = m[1] === '10' ? 'T' : m[1].toUpperCase();
    const s = SYM_SUIT[m[2]] || m[2].toLowerCase();
    return r + s;
  }
  const parseList = (s) => s.trim().split(/[\s・,、]+/).filter(Boolean).map(parseCard);
  const rankOf = (id) => CH_RANK[id[0]];
  const suitOf = (id) => id[1];
  const isRed = (id) => id[1] === 'h' || id[1] === 'd';
  function cardText(id) {
    if (id === JOKER) return 'JOKER';
    return SUIT_SYM[suitOf(id)] + RANK_LABEL[rankOf(id)];
  }

  /* ---------- 数値の設定表(ルールブックv0.2準拠) ---------- */
  const ROLES = ['ONE_PAIR', 'TWO_PAIR', 'THREE', 'STRAIGHT', 'FLUSH', 'FULL_HOUSE', 'FOUR', 'STRAIGHT_FLUSH', 'ROYAL_FLUSH', 'ALL_STAR'];
  const PUBLIC_ROLES = ROLES.slice(0, 9);
  const ROLE_JA = {
    ONE_PAIR: 'ワンペア', TWO_PAIR: 'ツーペア', THREE: 'スリーカード', STRAIGHT: 'ストレート', FLUSH: 'フラッシュ',
    FULL_HOUSE: 'フルハウス', FOUR: 'フォーカード', STRAIGHT_FLUSH: 'ストレートフラッシュ', ROYAL_FLUSH: 'ロイヤルフラッシュ', ALL_STAR: 'オールスター'
  };
  const MIN = 60 * 1000;
  const CONFIG = {
    version: 'ルールブックv0.2準拠・設定v2026-11-26',
    note: 'R3フラッシュは150(2026-11-26 確定)。R4の共通カード3枚目は伏せたまま判定に入れる(同日 確定)。共通カードは画面に出さず卓で公開する',
    startChips: 100,
    /* 時計の開始を押してから実際に動くまでの猶予。全端末に届いてから同時に動かすため */
    startLeadMs: 3000,
    freeMs: 20 * MIN,
    auctionMs: 5 * MIN,
    /* 共通カードを卓でめくる時刻(自由時間の開始から)。画面には出さず、司会と係の台本とGMの時計にだけ使う */
    revealAt: { 1: [0, 0], 2: [3 * MIN, 7 * MIN], 3: [3 * MIN, 7 * MIN], 4: [3 * MIN, 7 * MIN] },
    rankBonus: { 1: [30, 20, 15, 10, 5], 2: [60, 35, 20, 10, 5], 3: [80, 45, 30, 15, 10], 4: [120, 70, 45, 25, 15] },
    roleBonus: {
      ONE_PAIR: [10, 70, 20, 30], TWO_PAIR: [15, 100, 30, 45], THREE: [20, 40, 40, 60], STRAIGHT: [25, 45, 50, 75],
      FLUSH: [30, 50, 150, 90], FULL_HOUSE: [40, 60, 80, 120], FOUR: [60, 35, 120, 180], STRAIGHT_FLUSH: [90, 50, 180, 270],
      ROYAL_FLUSH: [120, 120, 240, 360], ALL_STAR: [0, 0, 0, 600]
    }
  };
  /* 配札表 { 1: { community: 'K♥ 6♦', seats: { A: '...', ... } }, 2: ..., 3: ..., 4: ... } */
  let DEALS = null;
  function checkDeals(d) {
    const errs = [];
    if (!d || typeof d !== 'object') return ['配札表が読めません'];
    for (const r of [1, 2, 3, 4]) {
      const x = d[r] || d[String(r)];
      if (!x || typeof x.community !== 'string' || !x.seats) { errs.push('R' + r + ' がありません'); continue; }
      const seen = new Set();
      const add = (c, where) => { if (seen.has(c)) errs.push('R' + r + ' で ' + cardText(c) + ' が重複(' + where + ')'); seen.add(c); };
      try { parseList(x.community).forEach((c) => add(c, '共通')); } catch (e) { errs.push('R' + r + ' 共通: ' + e.message); }
      for (const s of SEATS) {
        if (typeof x.seats[s] !== 'string') { errs.push('R' + r + ' ' + s + '席がありません'); continue; }
        try { const cs = parseList(x.seats[s]); if (cs.length !== 5) errs.push('R' + r + ' ' + s + '席が5枚ではありません'); cs.forEach((c) => add(c, s + '席')); } catch (e) { errs.push('R' + r + ' ' + s + '席: ' + e.message); }
      }
    }
    return errs;
  }
  function setDeals(d) { DEALS = d || null; }
  const hasDeals = () => !!DEALS;
  const dealOf = (round) => { if (!DEALS) throw new Error('配札表が読み込まれていません'); return DEALS[round] || DEALS[String(round)]; };
  const roleBonusOf = (role, round) => CONFIG.roleBonus[role][round - 1];
  const rolesFor = (round) => (round === 4 ? ROLES : PUBLIC_ROLES);
  function community(round) { return parseList(dealOf(round).community); }
  function dealt(round, seat) { return parseList(dealOf(round).seats[seat]); }
  function dealtSet(round) { const s = new Set(); for (const k of SEATS) dealt(round, k).forEach((c) => s.add(c)); return s; }

  /* ---------- 役の判定 ---------- */
  function cmp(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }
  function eval5(cs) {
    const rs = cs.map(rankOf).sort((a, b) => b - a);
    const ss = cs.map(suitOf);
    const flush = ss.every((s) => s === ss[0]);
    const cnt = {};
    rs.forEach((r) => { cnt[r] = (cnt[r] || 0) + 1; });
    const g = Object.keys(cnt).map((r) => [+r, cnt[r]]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const u = [...new Set(rs)];
    let hi = 0;
    if (u.length === 5) {
      if (u[0] - u[4] === 4) hi = u[0];
      else if (u[0] === 14 && u[1] === 5 && u[4] === 2) hi = 5;
    }
    if (hi && flush) return [8, hi];
    if (g[0][1] === 4) return [7, g[0][0], g[1][0]];
    if (g[0][1] === 3 && g[1][1] === 2) return [6, g[0][0], g[1][0]];
    if (flush) return [5, ...rs];
    if (hi) return [4, hi];
    if (g[0][1] === 3) return [3, g[0][0], ...g.slice(1).map((x) => x[0])];
    if (g[0][1] === 2 && g[1][1] === 2) return [2, g[0][0], g[1][0], g[2][0]];
    if (g[0][1] === 2) return [1, g[0][0], ...g.slice(1).map((x) => x[0])];
    return [0, ...rs];
  }
  function best5(cards) {
    const n = cards.length;
    let best = null;
    const idx = [0, 1, 2, 3, 4];
    if (n < 5) return null;
    while (true) {
      const pick = idx.map((i) => cards[i]);
      const key = eval5(pick);
      if (!best || cmp(key, best.key) > 0) best = { key, cards: pick };
      let i = 4;
      while (i >= 0 && idx[i] === n - 5 + i) i--;
      if (i < 0) break;
      idx[i]++;
      for (let j = i + 1; j < 5; j++) idx[j] = idx[j - 1] + 1;
    }
    return best;
  }
  function countRanks(nat) { const c = {}; nat.forEach((id) => { const r = rankOf(id); c[r] = (c[r] || 0) + 1; }); return c; }

  function bestHand(ids) {
    const nat = ids.filter((c) => c !== JOKER);
    const jokers = ids.length - nat.length;
    if (jokers > 1) throw new Error('ジョーカーは1枚まで');
    if (jokers === 0) return best5(nat);
    const cnt = countRanks(nat);
    let as = 0;
    for (const r in cnt) if (cnt[r] >= 4 && +r > as) as = +r;
    if (as) return { key: [9, as], cards: nat.filter((c) => rankOf(c) === as).concat([JOKER]) };
    const have = new Set(nat);
    let best = null, sub = null;
    for (const c of DECK) {
      if (have.has(c)) continue;
      const res = best5(nat.concat([c]));
      if (!best || cmp(res.key, best.key) > 0) { best = res; sub = c; }
    }
    return { key: best.key, cards: best.cards.map((c) => (c === sub ? JOKER : c)) };
  }
  const CAT_JA = ['ハイカード', 'ワンペア', 'ツーペア', 'スリーカード', 'ストレート', 'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ', 'オールスター'];
  function handName(key) {
    if (key[0] === 8 && key[1] === 14) return 'ロイヤルフラッシュ';
    return CAT_JA[key[0]];
  }

  /* 順位づけ(同じ強さは同率、次は繰り下がる) */
  function rankHands(hands, round) {
    const rows = Object.keys(hands).map((seat) => {
      const b = bestHand(hands[seat]);
      return { seat, key: b.key, best: b.cards, name: handName(b.key) };
    });
    rows.sort((a, b) => cmp(b.key, a.key) || (a.seat < b.seat ? -1 : 1));
    rows.forEach((row, i) => {
      row.pos = i > 0 && cmp(row.key, rows[i - 1].key) === 0 ? rows[i - 1].pos : i + 1;
      row.bonus = row.pos <= 5 ? CONFIG.rankBonus[round][row.pos - 1] : 0;
    });
    return rows;
  }

  /* ---------- 役パターンの数(ジョーカーは何にでもなれる札として最大で数える) ---------- */
  const SEQS = []; // 5連続の並び(低い順): A-5 ... T-A
  for (let lo = 1; lo <= 10; lo++) SEQS.push([0, 1, 2, 3, 4].map((k) => (lo + k === 1 ? 14 : lo + k)));
  function patternList(ids, role) {
    const nat = ids.filter((c) => c !== JOKER);
    const j = ids.length - nat.length;
    const cnt = countRanks(nat);
    const has = new Set(nat);
    const c = (r) => cnt[r] || 0;
    const ranks = Object.keys(cnt).map(Number).sort((a, b) => b - a);
    const out = [];
    const rl = (r) => RANK_LABEL[r];
    const seqLabel = (seq) => rl(seq[0]) + '〜' + rl(seq[4]);
    switch (role) {
      case 'ONE_PAIR': ranks.forEach((r) => { if (c(r) + j >= 2) out.push(rl(r) + 'のペア'); }); break;
      case 'THREE': ranks.forEach((r) => { if (c(r) + j >= 3) out.push(rl(r) + 'のスリーカード'); }); break;
      case 'FOUR': ranks.forEach((r) => { if (c(r) + j >= 4) out.push(rl(r) + 'のフォーカード'); }); break;
      case 'ALL_STAR': ranks.forEach((r) => { if (j >= 1 && c(r) >= 4) out.push(rl(r) + 'のオールスター'); }); break;
      case 'TWO_PAIR':
        for (let a = 0; a < ranks.length; a++) for (let b = a + 1; b < ranks.length; b++) {
          const d = Math.max(0, 2 - c(ranks[a])) + Math.max(0, 2 - c(ranks[b]));
          if (d <= j) out.push(rl(ranks[a]) + '+' + rl(ranks[b]));
        }
        break;
      case 'FULL_HOUSE':
        ranks.forEach((t) => ranks.forEach((p) => {
          if (t === p) return;
          const d = Math.max(0, 3 - c(t)) + Math.max(0, 2 - c(p));
          if (d <= j) out.push(rl(t) + '×3+' + rl(p) + '×2');
        }));
        break;
      case 'STRAIGHT':
        SEQS.forEach((seq) => { const miss = seq.filter((r) => c(r) === 0).length; if (miss <= j) out.push(seqLabel(seq)); });
        break;
      case 'FLUSH':
        SUITS.forEach((s) => { const n = nat.filter((id) => suitOf(id) === s).length; if (n + j >= 5) out.push(SUIT_SYM[s] + 'のフラッシュ'); });
        break;
      case 'STRAIGHT_FLUSH':
        // ロイヤルフラッシュ(同じマークの10〜A)はストレートフラッシュに数えない(ルールブック)
        SUITS.forEach((s) => SEQS.forEach((seq) => {
          if (seq[0] === 10) return;
          const miss = seq.filter((r) => !has.has(RANK_CH[r] + s)).length;
          if (miss <= j) out.push(SUIT_SYM[s] + seqLabel(seq));
        }));
        break;
      case 'ROYAL_FLUSH':
        SUITS.forEach((s) => { const miss = [10, 11, 12, 13, 14].filter((r) => !has.has(RANK_CH[r] + s)).length; if (miss <= j) out.push(SUIT_SYM[s] + 'のロイヤル'); });
        break;
      default: break;
    }
    return out;
  }
  const patternCount = (ids, role) => patternList(ids, role).length;

  /* ---------- オークション ---------- */
  function freeTextRole(text, round) {
    const t = String(text || '').normalize('NFKC').toLowerCase().replace(/[\s・･\-_.。、,!！]/g, '');
    if (round === 4 && (t === 'オールスター' || t === 'allstar' || t === 'おーるすたー')) return 'ALL_STAR';
    return null;
  }
  function toInt(v) {
    if (v === '' || v === null || v === undefined) return 0;
    const s = String(v).normalize('NFKC').trim();
    if (!/^\d+$/.test(s)) return NaN;
    return parseInt(s, 10);
  }
  /* bid = { amounts: {ONE_PAIR: 30, ...}, free: {text, amount} } */
  function checkBid(bid, declared) {
    const errors = [];
    let total = 0;
    for (const role of PUBLIC_ROLES) {
      const v = toInt(bid.amounts && bid.amounts[role]);
      if (Number.isNaN(v)) errors.push(ROLE_JA[role] + 'の金額は数字で入れてください');
      else total += v;
    }
    const fv = toInt(bid.free && bid.free.amount);
    const ft = String((bid.free && bid.free.text) || '').trim();
    if (Number.isNaN(fv)) errors.push('自由記入の金額は数字で入れてください');
    else {
      if (fv > 0 && !ft) errors.push('自由記入は役名も入れてください');
      if (ft && !fv) errors.push('自由記入は金額も入れてください');
      total += fv || 0;
    }
    if (!Number.isNaN(total) && total > declared) errors.push('入札の合計 ' + total + ' が所持チップ ' + declared + ' を超えています');
    return { total, ok: errors.length === 0, errors };
  }
  function tally(round, bids, hands) {
    const roles = rolesFor(round).map((role) => ({ role, bids: [] }));
    const byRole = {};
    roles.forEach((r) => { byRole[r.role] = r; });
    for (const seat of Object.keys(bids)) {
      const b = bids[seat];
      for (const role of PUBLIC_ROLES) {
        const v = toInt(b.amounts && b.amounts[role]);
        if (v > 0) byRole[role].bids.push({ seat, amount: v });
      }
      const fr = freeTextRole(b.free && b.free.text, round);
      const fv = toInt(b.free && b.free.amount);
      if (fr && fv > 0 && byRole[fr]) byRole[fr].bids.push({ seat, amount: fv });
    }
    const seats = {};
    const seatRow = (s) => (seats[s] = seats[s] || { paid: 0, roleBonus: 0, wins: [] });
    for (const r of roles) {
      r.bids.sort((a, b) => b.amount - a.amount || (a.seat < b.seat ? -1 : 1));
      if (!r.bids.length) { r.winner = null; continue; }
      r.top = r.bids[0].amount;
      const tops = r.bids.filter((x) => x.amount === r.top);
      r.tie = tops.length > 1;
      r.winner = r.tie ? null : tops[0].seat;
      if (r.winner) {
        const hand = hands[r.winner] || [];
        r.patterns = patternList(hand, r.role);
        r.bonusPer = roleBonusOf(r.role, round);
        r.reward = r.bonusPer * r.patterns.length;
        const sr = seatRow(r.winner);
        sr.paid += r.top;
        sr.roleBonus += r.reward;
        sr.wins.push({ role: r.role, price: r.top, patterns: r.patterns.length, reward: r.reward });
      }
    }
    return { roles, seats };
  }
  function settle(round, judgeRows, tallyRes, chips) {
    const out = {};
    for (const seat of SEATS) {
      const j = judgeRows.find((x) => x.seat === seat);
      const t = tallyRes.seats[seat] || { paid: 0, roleBonus: 0, wins: [] };
      const rankBonus = j ? j.bonus : 0;
      const payout = rankBonus + t.roleBonus - t.paid;
      const declared = chips[seat];
      out[seat] = { rankBonus, roleBonus: t.roleBonus, paid: t.paid, payout, declared: declared ?? null, balance: declared == null ? null : declared + payout };
    }
    return out;
  }
  /* 提出カードの照合: 重複と配札外の札 */
  function checkCards(round, cardsBySeat) {
    const alerts = [];
    const ok = dealtSet(round);
    const owner = {};
    for (const seat of Object.keys(cardsBySeat)) {
      for (const c of cardsBySeat[seat]) {
        (owner[c] = owner[c] || []).push(seat);
        if (!ok.has(c)) alerts.push({ level: 'high', kind: 'outside', card: c, seats: [seat], text: cardText(c) + ' はこのラウンドの配札にない札です(' + seat + '席)' });
      }
    }
    for (const c of Object.keys(owner)) {
      if (owner[c].length > 1) alerts.push({ level: 'high', kind: 'dup', card: c, seats: owner[c], text: cardText(c) + ' が ' + owner[c].join('・') + ' 席で重複しています' });
    }
    return alerts;
  }

  const API = {
    SUITS, SUIT_SYM, RANK_CH, RANK_LABEL, JOKER, SEATS, DECK, ROLES, PUBLIC_ROLES, ROLE_JA, CONFIG,
    parseCard, parseList, rankOf, suitOf, isRed, cardText, cmp, eval5, best5, bestHand, handName, rankHands,
    patternList, patternCount, freeTextRole, toInt, checkBid, tally, settle, checkCards,
    community, dealt, dealtSet, roleBonusOf, rolesFor, setDeals, hasDeals, checkDeals
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.APE = API;
})(typeof window !== 'undefined' ? window : globalThis);
