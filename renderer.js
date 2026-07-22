/* LoRA Steps Calculator — расчёт, автоподбор по пропорции, пресеты */

const PARAM_DEFS = [
  { key: 'images',  name: 'Картинок в датасете', sub: 'размер датасета', min: 1, max: 100000, def: 30, lockable: false },
  { key: 'repeats', name: 'Num repeats',          sub: 'повторов картинки за эпоху', min: 1, max: 300, def: 10, lockable: true },
  { key: 'epochs',  name: 'Эпох',                 sub: 'полных проходов датасета', min: 1, max: 200, def: 10, lockable: true },
  { key: 'batch',   name: 'Batch size',           sub: 'картинок за проход (VRAM)', min: 1, max: 64, def: 2, lockable: true },
  { key: 'accum',   name: 'Grad. accumulation',   sub: 'накопление градиента', min: 1, max: 64, def: 1, lockable: true }
];

const SOLVER_RANGES = { repeats: [1, 300], epochs: [1, 200], batch: [1, 64], accum: [1, 64] };

let params = load('lsc.params', Object.fromEntries(PARAM_DEFS.map(d => [d.key, d.def])));
let locks = load('lsc.locks', {});
let presets = load('lsc.presets', []);
let activePreset = load('lsc.activePreset', null);
let targetMode = load('lsc.targetMode', 'balance');

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
function persist() {
  localStorage.setItem('lsc.params', JSON.stringify(params));
  localStorage.setItem('lsc.locks', JSON.stringify(locks));
  localStorage.setItem('lsc.presets', JSON.stringify(presets));
  localStorage.setItem('lsc.activePreset', JSON.stringify(activePreset));
  localStorage.setItem('lsc.targetMode', JSON.stringify(targetMode));
}

/* ---------- расчёт ---------- */

function derive(p) {
  const effBatch = p.batch * p.accum;
  const viewsPerEpoch = p.images * p.repeats;
  const totalViews = viewsPerEpoch * p.epochs;
  // как в kohya: батчей за эпоху с округлением вверх, затем накопление
  const batchesPerEpoch = Math.ceil(viewsPerEpoch / p.batch);
  const stepsPerEpoch = Math.ceil(batchesPerEpoch / p.accum);
  const totalSteps = stepsPerEpoch * p.epochs;
  const viewsPerImage = p.repeats * p.epochs;
  return { effBatch, viewsPerEpoch, totalViews, stepsPerEpoch, totalSteps, viewsPerImage };
}

function fmt(n) { return n.toLocaleString('ru-RU'); }

/* Ориентиры для стилевой LoRA на Krea 2:
   500–1000 — быстрая проверка, 1500–3000 — стандарт,
   3000–4000 — сложный стиль (с пониженным LR), дальше — пережарка */
function stepsBadge(steps) {
  if (steps < 500) return ['bad', 'очень мало'];
  if (steps < 1500) return ['warn', 'быстрая проверка стиля'];
  if (steps <= 3000) return ['ok', 'стандарт для стиля'];
  if (steps <= 4000) return ['warn', 'сложный стиль — снизьте LR'];
  return ['bad', 'риск пережарки'];
}
// 1500–3000 шагов на датасете 20–40 картинок при батче 1 → ~40–150 проходов на картинку
function vpiBadge(vpi) {
  if (vpi < 20) return ['bad', 'мало'];
  if (vpi < 40) return ['warn', 'маловато'];
  if (vpi <= 150) return ['ok', 'норма (ориентир ~75)'];
  if (vpi <= 250) return ['warn', 'много'];
  return ['bad', 'риск пережарки'];
}
/* 3–10 — техминимум (риск выучить композицию вместо стиля),
   20–40 — золотая середина, 50–100+ — для сложного стиля */
function imagesBadge(n) {
  if (n < 3) return ['bad', 'ниже минимума (3)'];
  if (n < 20) return ['warn', 'риск выучить композицию'];
  if (n <= 40) return ['ok', 'золотая середина'];
  return ['warn', 'сложный стиль — дольше'];
}
// LR согласован с числом шагов: высокий LR → мало шагов, низкий → много
function lrHint(steps) {
  if (steps <= 1000) return '3e-4…7e-4 (облако)';
  if (steps < 2000) return '1e-4…3e-4';
  if (steps <= 4000) return '1e-4 (локально)';
  return '<1e-4 + ранние чекпоинты';
}

/* ---------- UI: параметры ---------- */

const paramsEl = document.getElementById('params');
const inputs = {};

for (const def of PARAM_DEFS) {
  const row = document.createElement('div');
  row.className = 'param-row';

  const info = document.createElement('div');
  info.className = 'param-info';
  info.innerHTML = `<div class="param-name">${def.name}</div><div class="param-sub">${def.sub}</div>`;
  if (def.key === 'images') {
    info.innerHTML += '<span class="badge" id="b-images"></span>';
  }

  const stepper = document.createElement('div');
  stepper.className = 'stepper';
  const minus = document.createElement('button');
  minus.textContent = '−';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = def.min;
  input.max = def.max;
  input.value = params[def.key];
  const plus = document.createElement('button');
  plus.textContent = '+';
  stepper.append(minus, input, plus);
  inputs[def.key] = input;

  minus.addEventListener('click', () => bump(def, -1));
  plus.addEventListener('click', () => bump(def, +1));
  input.addEventListener('change', () => {
    const v = clamp(parseInt(input.value, 10) || def.min, def.min, def.max);
    input.value = v;
    onUserEdit(def.key, v);
  });

  row.append(info, stepper);

  if (def.lockable) {
    const lock = document.createElement('button');
    lock.className = 'lock-btn' + (locks[def.key] ? ' locked' : '');
    lock.textContent = locks[def.key] ? '🔒' : '🔓';
    lock.title = 'Заблокировать от автоподбора';
    lock.addEventListener('click', () => {
      locks[def.key] = !locks[def.key];
      lock.classList.toggle('locked', locks[def.key]);
      lock.textContent = locks[def.key] ? '🔒' : '🔓';
      persist();
    });
    row.append(lock);
  }

  paramsEl.append(row);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function range(lo, hi) {
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}
// ближайшие к value элементы отсортированного массива (сосед снизу и сверху)
function nearestValues(sorted, value) {
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1; else hi = mid;
  }
  const out = [sorted[lo]];
  if (lo > 0) out.push(sorted[lo - 1]);
  return out;
}

function bump(def, delta) {
  const v = clamp((params[def.key] || def.def) + delta, def.min, def.max);
  inputs[def.key].value = v;
  onUserEdit(def.key, v);
}

function onUserEdit(key, value) {
  params[key] = value;
  if (activePreset) {
    solve(key);
  }
  render();
  persist();
}

/* ---------- автоподбор по пропорции ---------- */

function solve(editedKey) {
  const target = activePreset.target;
  const isFree = (k) => k !== editedKey && !locks[k];
  const freeKeys = Object.keys(SOLVER_RANGES).filter(isFree);

  const devEl = document.getElementById('banner-deviation');
  if (freeKeys.length === 0) {
    devEl.innerHTML = '<span class="warn">Все остальные параметры заблокированы — подбирать нечем.</span>';
    return;
  }

  const wS = targetMode === 'steps' ? 1 : targetMode === 'vpi' ? 0.15 : 1;
  const wV = targetMode === 'vpi' ? 1 : targetMode === 'steps' ? 0.15 : 1;

  // достижимые эффективные батчи: для каждого произведения batch×accum — пара
  // с минимальным отклонением от текущих значений
  const batchVals = isFree('batch')
    ? range(SOLVER_RANGES.batch[0], SOLVER_RANGES.batch[1]) : [params.batch];
  const accumVals = isFree('accum')
    ? range(SOLVER_RANGES.accum[0], SOLVER_RANGES.accum[1]) : [params.accum];
  const pairDrift = (b, a) =>
    Math.abs(Math.log(b / params.batch)) + Math.abs(Math.log(a / params.accum));
  const effOptions = new Map(); // effBatch -> {batch, accum}
  for (const b of batchVals) {
    for (const a of accumVals) {
      const eff = b * a;
      const prev = effOptions.get(eff);
      if (!prev || pairDrift(b, a) < pairDrift(prev.batch, prev.accum)) {
        effOptions.set(eff, { batch: b, accum: a });
      }
    }
  }
  const effSorted = [...effOptions.keys()].sort((x, y) => x - y);

  const repeatsVals = isFree('repeats')
    ? range(SOLVER_RANGES.repeats[0], SOLVER_RANGES.repeats[1]) : [params.repeats];
  const epochsVals = isFree('epochs')
    ? range(SOLVER_RANGES.epochs[0], SOLVER_RANGES.epochs[1]) : [params.epochs];

  let best = null;
  const consider = (r, e, eff) => {
    const pair = effOptions.get(eff);
    const cand = { images: params.images, repeats: r, epochs: e, batch: pair.batch, accum: pair.accum };
    const d = derive(cand);
    const errS = Math.abs(d.totalSteps - target.totalSteps) / target.totalSteps;
    const errV = Math.abs(d.viewsPerImage - target.viewsPerImage) / target.viewsPerImage;
    const errB = Math.abs(d.effBatch - target.effBatch) / target.effBatch;
    // штраф за отдалённость от текущих значений — решение должно быть минимальным изменением
    let drift = pairDrift(pair.batch, pair.accum);
    drift += Math.abs(Math.log(r / params.repeats)) + Math.abs(Math.log(e / params.epochs));
    const score = wS * errS + wV * errV + 0.08 * errB + 0.01 * drift;
    if (!best || score < best.score) best = { score, values: cand, derived: d };
  };

  for (const e of epochsVals) {
    for (const r of repeatsVals) {
      // идеальный эффективный батч под целевые шаги; берём ближайшие достижимые
      const ideal = (params.images * r * e) / target.totalSteps;
      for (const eff of nearestValues(effSorted, ideal)) consider(r, e, eff);
      // плюс текущий эффективный батч, если достижим — минимальное изменение
      const cur = params.batch * params.accum;
      if (effOptions.has(cur)) consider(r, e, cur);
    }
  }

  const changed = [];
  for (const k of freeKeys) {
    if (best.values[k] !== params[k]) {
      params[k] = best.values[k];
      inputs[k].value = best.values[k];
      changed.push(k);
      flash(inputs[k]);
    }
  }

  const d = best.derived;
  const pct = (val, tgt) => {
    const p = ((val - tgt) / tgt) * 100;
    const s = (p > 0 ? '+' : '') + p.toFixed(1) + '%';
    return `<span class="${Math.abs(p) < 3 ? 'ok' : 'warn'}">${s}</span>`;
  };
  devEl.innerHTML =
    `Подобрано: шаги <b>${fmt(d.totalSteps)}</b> (цель ${fmt(target.totalSteps)}, ${pct(d.totalSteps, target.totalSteps)}) · ` +
    `проходов/картинку <b>${fmt(d.viewsPerImage)}</b> (цель ${fmt(target.viewsPerImage)}, ${pct(d.viewsPerImage, target.viewsPerImage)}) · ` +
    `эфф. батч <b>${d.effBatch}</b>` +
    (changed.length ? '' : ' — менять ничего не пришлось');
}

function flash(input) {
  input.classList.add('flash');
  setTimeout(() => input.classList.remove('flash'), 60);
}

/* ---------- рендер результатов ---------- */

function render() {
  const d = derive(params);
  setText('r-steps', fmt(d.totalSteps));
  setText('r-views', fmt(d.totalViews));
  setText('r-vpi', fmt(d.viewsPerImage));
  setText('r-effbatch', `${d.effBatch}  (${params.batch}×${params.accum})`);
  setText('r-steps-epoch', fmt(d.stepsPerEpoch));
  setText('r-views-epoch', fmt(d.viewsPerEpoch));
  setText('r-lr', lrHint(d.totalSteps));
  setText('r-saves', d.totalSteps >= 500
    ? `${Math.floor(d.totalSteps / 500)} (каждые 500 шагов)`
    : 'каждые 250 шагов');
  setBadge('b-steps', stepsBadge(d.totalSteps));
  setBadge('b-vpi', vpiBadge(d.viewsPerImage));
  setBadge('b-images', imagesBadge(params.images));
  renderBanner();
  renderPresets();
}

function setText(id, text) { document.getElementById(id).textContent = text; }
function setBadge(id, [cls, label]) {
  const el = document.getElementById(id);
  el.className = 'badge ' + cls;
  el.textContent = label;
}

/* ---------- баннер режима пропорции ---------- */

function renderBanner() {
  const banner = document.getElementById('proportion-banner');
  if (!activePreset) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  document.getElementById('banner-name').textContent = activePreset.name;
  const t = activePreset.target;
  document.getElementById('banner-target').textContent =
    `цель: ${fmt(t.totalSteps)} шагов · ${fmt(t.viewsPerImage)} проходов/картинку · эфф. батч ${t.effBatch}`;
  syncTargetMode();
}

const targetModeEl = document.getElementById('target-mode');
function syncTargetMode() {
  for (const b of targetModeEl.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.mode === targetMode);
  }
}
targetModeEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  targetMode = btn.dataset.mode;
  syncTargetMode();
  persist();
});

document.getElementById('exit-proportion').addEventListener('click', () => {
  activePreset = null;
  document.getElementById('banner-deviation').innerHTML = '';
  render();
  persist();
});

/* ---------- модал имени пропорции (window.prompt в Electron не работает) ---------- */

const modalOverlay = document.getElementById('modal-overlay');
const presetNameInput = document.getElementById('preset-name-input');
let modalResolve = null;

function askPresetName(defaultName, summary) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    document.getElementById('modal-summary').textContent = summary;
    presetNameInput.value = defaultName;
    modalOverlay.classList.remove('hidden');
    requestAnimationFrame(() => { presetNameInput.focus(); presetNameInput.select(); });
  });
}
function closeModal(result) {
  modalOverlay.classList.add('hidden');
  if (modalResolve) { modalResolve(result); modalResolve = null; }
}
document.getElementById('modal-save').addEventListener('click', () => closeModal(presetNameInput.value));
document.getElementById('modal-cancel').addEventListener('click', () => closeModal(null));
modalOverlay.addEventListener('mousedown', (e) => { if (e.target === modalOverlay) closeModal(null); });
presetNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') closeModal(presetNameInput.value);
  if (e.key === 'Escape') closeModal(null);
});

/* ---------- пресеты ---------- */

document.getElementById('save-preset').addEventListener('click', async () => {
  const d = derive(params);
  const name = await askPresetName(
    `${fmt(d.totalSteps)} шагов · ${d.viewsPerImage}/картинку`,
    `${params.images} карт. × ${params.repeats} repeats × ${params.epochs} эпох · батч ${params.batch}×${params.accum}`);
  if (name === null) return;
  presets.unshift({
    id: Date.now(),
    name: name.trim() || 'Без названия',
    params: { ...params },
    target: { totalSteps: d.totalSteps, viewsPerImage: d.viewsPerImage, effBatch: d.effBatch, totalViews: d.totalViews }
  });
  persist();
  renderPresets();
  toast('Пропорция сохранена');
});

function renderPresets() {
  const wrap = document.getElementById('presets');
  const empty = document.getElementById('presets-empty');
  wrap.innerHTML = '';
  empty.style.display = presets.length ? 'none' : 'block';

  for (const p of presets) {
    const card = document.createElement('div');
    card.className = 'preset-card' + (activePreset && activePreset.id === p.id ? ' active' : '');
    card.innerHTML = `
      <div class="preset-head"><span class="preset-name"></span></div>
      <div class="preset-params">${p.params.images} карт. × ${p.params.repeats} repeats × ${p.params.epochs} эпох · батч ${p.params.batch}×${p.params.accum}</div>
      <div class="preset-derived">
        <span>шаги <b>${fmt(p.target.totalSteps)}</b></span>
        <span>просмотры <b>${fmt(p.target.totalViews)}</b></span>
        <span>на картинку <b>${fmt(p.target.viewsPerImage)}</b></span>
      </div>
      <div class="preset-actions">
        <button class="btn ghost small apply">Применить</button>
        <button class="btn ghost small danger delete">Удалить</button>
      </div>`;
    card.querySelector('.preset-name').textContent = p.name;

    card.querySelector('.apply').addEventListener('click', () => {
      params = { ...p.params };
      for (const def of PARAM_DEFS) inputs[def.key].value = params[def.key];
      activePreset = { id: p.id, name: p.name, target: { ...p.target } };
      document.getElementById('banner-deviation').innerHTML = '';
      render();
      persist();
      toast(`Пропорция «${p.name}» активна — меняйте параметры, остальные подстроятся`);
    });

    card.querySelector('.delete').addEventListener('click', () => {
      presets = presets.filter(x => x.id !== p.id);
      if (activePreset && activePreset.id === p.id) activePreset = null;
      persist();
      render();
    });

    wrap.append(card);
  }
}

/* ---------- сводка ---------- */

document.getElementById('copy-summary').addEventListener('click', () => {
  const d = derive(params);
  const text =
`Датасет: ${params.images} картинок × ${params.repeats} repeats × ${params.epochs} эпох = ${d.totalViews} просмотров
Батч: ${params.batch} × накопление ${params.accum} = эффективный ${d.effBatch}
Шагов: ${d.totalSteps} всего (${d.stepsPerEpoch}/эпоху) · проходов на картинку: ${d.viewsPerImage}`;
  navigator.clipboard.writeText(text).then(() => toast('Сводка скопирована'));
});

/* ---------- toast ---------- */

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

render();
