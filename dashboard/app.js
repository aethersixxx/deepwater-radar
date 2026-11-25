// Deepwater dashboard — vanilla JS, renders from the generated data.js, no network.
(() => {
  const state = {
    q: '',
    cat: '',
    chain: '',
    watchOnly: true,
    sortKey: 'rank',
    sortDir: 1,
    sel: null,
    done: {},
  };

  const el = (id) => document.getElementById(id);
  const rows = RADAR.rows;
  const fmtUsd = (v) => {
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(v >= 1e10 ? 1 : 2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(v >= 1e8 ? 0 : 1) + 'M';
    return '$' + Math.round(v).toLocaleString('en-US');
  };
  const fmtPct = (v) => (v === null || v === undefined) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  const fmtAge = (d) => d === null ? 'unlisted' : d >= 365 ? (d / 365).toFixed(1) + 'y' : d + 'd';

  function statCard(b, s) {
    return `<div class="stat"><b>${b}</b><span>${s}</span></div>`;
  }

  function renderStats() {
    const s = RADAR.summary;
    const top = rows[0];
    el('stats').innerHTML =
      statCard(String(s.rows), 'board rows') +
      statCard(String(s.watchlist_count), 'watchlist floor') +
      statCard(fmtUsd(top.implied_value_usd), 'top implied') +
      statCard(top.name, 'rank 1 protocol') +
      statCard(String(s.tokened_comps), 'tokened comps');
    el('asOf').textContent = s.as_of;
    el('methodModel').textContent = s.model_notes[0] + '.';
    el('methodNotes').innerHTML = s.model_notes.slice(1).map((n) => `<li>${n}.</li>`).join('');
    el('methodNotes').innerHTML += `<li>board ranks the ${s.watchlist_count} watchlist protocols (TVL ≥ ${fmtUsd(s.floor_usd)}, no token recorded, no wrapped or staked product of a traded token) first, then the strongest pre-token protocols below the floor.</li>`;
  }

  function fillSelects() {
    const cats = [...new Set(rows.map((r) => r.category || 'Uncategorised'))].sort();
    const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
    el('cat').innerHTML = '<option value="">All categories</option>' +
      cats.map((c) => `<option>${c}</option>`).join('');
    el('chain').innerHTML = '<option value="">All chains</option>' +
      chains.map((c) => `<option>${c}</option>`).join('');
  }

  function filtered() {
    const q = state.q.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (state.watchOnly && !r.on_watchlist) return false;
      if (state.cat && (r.category || 'Uncategorised') !== state.cat) return false;
      if (state.chain && !r.chains.includes(state.chain)) return false;
      if (q) {
        const hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const k = state.sortKey;
    out.sort((a, b) => {
      let av = a[k], bv = b[k];
      if (k === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (av < bv) return -state.sortDir;
      if (av > bv) return state.sortDir;
      return a.rank - b.rank;
    });
    return out;
  }

  function oddsBar(o) {
    return `<span class="oddsbar"><i style="width:${Math.round(o * 100)}%"></i></span>${Math.round(o * 100)}%`;
  }

  function renderBoard() {
    const list = filtered();
    el('count').textContent = `${list.length} of ${rows.length} protocols`;
    const cols = [
      ['rank', '#'], ['name', 'Protocol'], ['tvl_usd', 'TVL'], ['change_7d', '7d'],
      ['age_days', 'Age'], ['implied_value_usd', 'Implied value'], ['token_odds', 'Token odds'],
    ];
    const head = cols.map(([k, label]) =>
      `<th data-k="${k}" class="${k === 'name' || k === 'rank' ? '' : 'num'} ${state.sortKey === k ? 'on' : ''}">${label}${state.sortKey === k ? (state.sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
    const body = list.map((r) => `<tr data-slug="${r.slug}" class="${state.sel === r.slug ? 'sel' : ''}">
      <td class="rank"><b>${r.rank}</b></td>
      <td class="pname"><b>${r.name}</b>${r.on_watchlist ? '<span class="wtag">watchlist</span>' : ''}<span class="cat">${r.category || 'Uncategorised'} · ${r.chains.slice(0, 3).join(', ')}${r.chains.length > 3 ? ' +' + (r.chains.length - 3) : ''}</span></td>
      <td class="num">${fmtUsd(r.tvl_usd)}</td>
      <td class="num ${r.change_7d >= 0 ? 'up' : 'down'}">${fmtPct(r.change_7d)}</td>
      <td class="num">${fmtAge(r.age_days)}</td>
      <td class="num usd">${fmtUsd(r.implied_value_usd)}</td>
      <td class="num">${oddsBar(r.token_odds)}</td>
    </tr>`).join('');
    el('board').innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    el('board').querySelectorAll('th').forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.k;
        if (state.sortKey === k) state.sortDir = -state.sortDir;
        else { state.sortKey = k; state.sortDir = k === 'rank' ? 1 : -1; }
        renderBoard();
      };
    });
    el('board').querySelectorAll('tr[data-slug]').forEach((tr) => {
      tr.onclick = () => select(tr.dataset.slug);
    });
  }

  function select(slug) {
    state.sel = state.sel === slug ? null : slug;
    const r = rows.find((x) => x.slug === slug);
    const d = el('detail');
    if (!r) { d.hidden = true; renderBoard(); return; }
    d.hidden = false;
    const m = r.model;
    d.innerHTML = `
      <h2>${r.name}</h2>
      <p class="sub">rank #${r.rank}${r.on_watchlist ? ' · on the watchlist floor' : ' · below the floor, found by the radar'} · ${r.category || 'Uncategorised'}</p>
      <h3>Snapshot</h3>
      <div class="kv">
        <span>TVL</span><b>${fmtUsd(r.tvl_usd)}</b>
        <span>7-day change</span><b class="${r.change_7d >= 0 ? 'up' : 'down'}">${fmtPct(r.change_7d)}</b>
        <span>Tracked since</span><b>${r.age_days === null ? 'unlisted' : r.listed_at + ' (' + fmtAge(r.age_days) + ')'}</b>
        <span>Token recorded</span><b>none (DefiLlama)</b>
        <span>Chains</span><b>${r.chains.join(', ')}</b>
        <span>Token odds</span><b>${Math.round(r.token_odds * 100)}%</b>
      </div>
      <h3>Value model</h3>
      <div class="multline">TVL <b>${fmtUsd(r.tvl_usd)}</b><br>
      × category multiple <b>${m.base_multiple}</b> (median ${m.category_median_multiple} of ${m.category_sample} comps, global ${m.global_median_multiple})<br>
      × growth <b>${m.growth_multiplier}</b> (${m.growth_pct === null ? 'no 7d figure' : fmtPct(m.growth_pct)})<br>
      × maturity <b>${m.maturity_multiplier}</b> (${r.age_days === null ? 'unlisted' : fmtAge(r.age_days)})<br>
      = <b>${fmtUsd(r.implied_value_usd)}</b></div>
      <h3>Farm plan</h3>
      <ol class="fsteps">${r.farm_steps.map((s, i) =>
        `<li data-i="${i}" class="${state.done[r.slug + i] ? 'done' : ''}"><span>${s}</span></li>`).join('')}</ol>
      <p class="fine">The implied value is the model's claim about a hypothetical launch, not a prediction that a token ships. Verify any protocol's own criteria before farming.</p>`;
    d.querySelectorAll('.fsteps li').forEach((li) => {
      li.onclick = () => {
        const key = r.slug + li.dataset.i;
        state.done[key] = !state.done[key];
        li.classList.toggle('done', state.done[key]);
      };
    });
    renderBoard();
  }

  function bind() {
    el('q').oninput = (e) => { state.q = e.target.value; renderBoard(); };
    el('cat').onchange = (e) => { state.cat = e.target.value; renderBoard(); };
    el('chain').onchange = (e) => { state.chain = e.target.value; renderBoard(); };
    el('watchOnly').onchange = (e) => { state.watchOnly = e.target.checked; renderBoard(); };
    el('methodBtn').onclick = () => { el('method').hidden = !el('method').hidden; };
  }

  // Deep links: ?q=...&cat=...&chain=...&watch=0&slug=... pre-set the filters (no network needed).
  const params = new URLSearchParams(location.search);
  if (params.has('q')) { state.q = params.get('q'); el('q').value = state.q; }
  if (params.has('cat')) { state.cat = params.get('cat'); el('cat').value = state.cat; }
  if (params.has('chain')) { state.chain = params.get('chain'); el('chain').value = state.chain; }
  if (params.has('watch')) { state.watchOnly = params.get('watch') !== '0'; el('watchOnly').checked = state.watchOnly; }
  const presetSlug = params.get('slug');
  if (presetSlug) {
    state.watchOnly = false;
    el('watchOnly').checked = false;
    state.sel = presetSlug;
    renderBoard();
    select(presetSlug);
    return;
  }

  renderStats();
  fillSelects();
  bind();
  renderBoard();
})();
