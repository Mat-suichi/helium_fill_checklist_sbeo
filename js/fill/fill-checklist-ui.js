(function (root) {
'use strict';
var Core = root.FillChecklistCore, Gas = root.BalloonGas;
var STORAGE_KEY = 'fill-checklist-v2', OLD_KEY = 'fill-checklist-v1', PREDICTOR_KEY = 'gas-calculator-settings-v4';
var GAS_FIELDS = ['inputMode', 'balloonMassG', 'componentMassG', 'otherMassG', 'parachuteMassG', 'recoveryEquipmentMassG', 'verificationOtherMassG', 'targetAscentRate', 'temperatureC', 'pressureHpa', 'densityDifferenceKgM3', 'targetCylinderPressureMpa', 'firstCylinderOffsetMpa', 'cylinderTemperatureC', 'cylinderProcess', 'polytropicN'];
var TEXT_FIELDS = { inputMode: true, cylinderProcess: true };
var state, lastPlan = null, lastRequired = null, lastLift = null, lastTopup = null, lastSpokenKey = null;
var TL = [], GROUPS = [], lastIndex = 0, planCurrent = 0, startSel = { group: 'day', key: '' }, lastScrolledKey = null;

// ---------- 小物 ----------
function el(id) { return document.getElementById(id); }
function fmt(v, d) { return Number(v).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function mpa(v) { return v == null || !Number.isFinite(Number(v)) ? '-' : fmt(v, 2) + ' MPa'; }
function litres(v) { return fmt(Math.round(v), 0) + ' L'; }
function kg(v) { return fmt(v, 2) + ' kg'; }
function rate(v) { return fmt(v, 1) + ' m/s'; }
function pct(v) { return (v >= 0 ? '+' : '') + fmt(v, 1) + '%'; }
function nowIso() { return new Date().toISOString(); }
function clock(iso) { return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function toast(msg) { var t = el('fc_toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.hidden = true; }, 3000); }
function measured(v) { return v !== '' && v != null && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= Core.MAX_PRESSURE_MPA; }
function positive(v) { return v !== '' && v != null && Number(v) > 0; }
function safeId(key) { return key.replace(/[^\w-]/g, '_'); }
// 入力欄の入った部分を描き直すと、その欄の blur→change が描き直しの途中で起きる。描き直しは次の処理に回す。
function later(fn) { setTimeout(fn, 0); }
function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* 保存できなくても画面は動かす */ } }

// ---------- 状態 ----------
function emptyRunCylinder() { return { initialMpa: '', finalMpa: '' }; }
function emptyLift() { return { holderKg: '', withKg: '', attachedG: '0', resolutionKg: '0.1' }; }
function emptyTopup() { return { startMpa: '', endMpa: '', checks: {}, history: [] }; }
function emptyRun(n) { var cyl = []; for (var i = 0; i < n; i += 1) cyl.push(emptyRunCylinder()); return { started: false, startKey: '', checks: {}, cyl: cyl, recoveryMpa: '', lift: emptyLift(), topup: emptyTopup(), log: [] }; }
function defaultGas() { var d = Gas.DEFAULTS, g = {}; GAS_FIELDS.forEach(function (k) { g[k] = d[k]; }); return g; }
function defaultState() { return { settings: { requiredMode: 'calc', manualRequiredL: '', gas: defaultGas(), cylinders: [0, 1, 2, 3].map(function () { return { volumeL: 47, pressureMpa: 14 }; }) }, run: emptyRun(4) }; }
function resizeRun(s) { var n = s.settings.cylinders.length; while (s.run.cyl.length < n) s.run.cyl.push(emptyRunCylinder()); if (s.run.cyl.length > n) s.run.cyl.length = n; }
function parse(key) { try { return JSON.parse(storageGet(key) || 'null'); } catch (e) { return null; } }
function predictorSettings() { return parse(PREDICTOR_KEY); }
function applyPredictorSettings(s, saved) {
    GAS_FIELDS.forEach(function (k) { if (saved[k] != null && saved[k] !== '') s.settings.gas[k] = saved[k]; });
    if (Array.isArray(saved.cylinders) && saved.cylinders.length) {
        s.settings.cylinders = saved.cylinders.slice(0, Core.MAX_CYLINDERS).map(function (c) { return { volumeL: c.volumeL, pressureMpa: c.pressureMpa }; });
        resizeRun(s);
    }
    s.settings.requiredMode = 'calc';
}
function load() {
    var saved = parse(STORAGE_KEY);
    if (saved && saved.settings && saved.run) {
        saved.settings.gas = Object.assign(defaultGas(), saved.settings.gas || {});
        saved.run = Object.assign(emptyRun(saved.settings.cylinders.length), saved.run);
        saved.run.lift = Object.assign(emptyLift(), saved.run.lift || {});
        saved.run.topup = Object.assign(emptyTopup(), saved.run.topup || {});
        state = saved; resizeRun(state); return;
    }
    state = defaultState();
    var old = parse(OLD_KEY);
    if (old && old.settings) { // 前の版の設定（ボンベ・機体）だけ引き継ぐ
        state.settings = old.settings; state.settings.gas = Object.assign(defaultGas(), old.settings.gas || {});
        state.run = emptyRun(state.settings.cylinders.length); return;
    }
    var p = predictorSettings(); if (p) applyPredictorSettings(state, p);
}
function save() { storageSet(STORAGE_KEY, JSON.stringify(state)); }

// ---------- 計算・タイムライン ----------
function gasOptions() { var g = {}, src = state.settings.gas; GAS_FIELDS.forEach(function (k) { g[k] = TEXT_FIELDS[k] ? src[k] : Number(src[k]); }); return g; }
function cylindersForPlan() { return state.settings.cylinders.map(function (c, i) { var r = state.run.cyl[i] || {}; return { volumeL: Number(c.volumeL), pressureMpa: Number(c.pressureMpa), initialMpa: r.initialMpa, finalMpa: r.finalMpa }; }); }
function cylDone(i) { var r = state.run.cyl[i]; return !!r && measured(r.initialMpa) && measured(r.finalMpa); }
function compute() {
    var errorBox = el('fc_error'), n = state.settings.cylinders.length;
    planCurrent = 0; while (planCurrent < n && cylDone(planCurrent)) planCurrent += 1;
    try {
        var o = gasOptions();
        lastRequired = Core.requiredGas({ requiredMode: state.settings.requiredMode, manualRequiredL: state.settings.manualRequiredL, gas: o });
        lastPlan = Core.buildPlan(o, lastRequired.gasVolumeL, cylindersForPlan(), planCurrent);
        errorBox.hidden = true;
    } catch (err) {
        lastPlan = null; lastRequired = null;
        errorBox.textContent = err.message || String(err); errorBox.hidden = false;
    }
    lastIndex = Core.lastCylinderIndex(lastPlan, n);
    TL = Core.timeline(lastIndex); GROUPS = Core.groups(lastIndex);
    try { lastLift = Core.liftCheck(gasOptions(), state.run.lift); } catch (e) { lastLift = { error: e.message || String(e) }; }
    computeTopup();
}
function startIndex() { var i = TL.findIndex(function (t) { return t.key === state.run.startKey; }); return i < 0 ? 0 : i; }
function currentIndex() { var s = startIndex(); for (var i = s; i < TL.length; i += 1) if (!state.run.checks[TL[i].key]) return i; return -1; }
function currentItem() { var i = currentIndex(); return i < 0 ? null : TL[i]; }
function firstDIndex() { return TL.findIndex(function (t) { return t.sec === 'D'; }); }
function lastDIndex() { var k = -1; TL.forEach(function (t, i) { if (t.sec === 'D') k = i; }); return k; }
function curCyl() {
    var i = currentIndex();
    if (i < 0) return lastIndex;
    if (TL[i].cyl != null) return TL[i].cyl;
    return i < firstDIndex() ? 0 : lastIndex;
}
function afterFilling() { var i = currentIndex(); return state.run.started && (i < 0 || i > lastDIndex()); }
function groupOf(id) { return GROUPS.find(function (g) { return g.id === id; }) || { id: id, code: id, title: '' }; }
function rowOf(i) { return lastPlan ? lastPlan.rows[i] : null; }
function deliveredOf(i) {
    var r = state.run.cyl[i], c = state.settings.cylinders[i];
    if (!cylDone(i)) return 0;
    try { return Core.deliveredL(gasOptions(), Number(c.volumeL), i, Number(r.initialMpa), Number(r.finalMpa)); } catch (e) { return 0; }
}
function filledTotal() { var s = 0; for (var i = 0; i < state.settings.cylinders.length; i += 1) s += deliveredOf(i); state.run.topup.history.forEach(function (h) { s += h.addedL || 0; }); return s; }
function itemInputValue(item) {
    var inp = item.step.input;
    if (inp === 'initial' || inp === 'final') return state.run.cyl[item.cyl][inp === 'initial' ? 'initialMpa' : 'finalMpa'];
    if (inp === 'holderKg' || inp === 'withKg') return state.run.lift[inp];
    if (inp === 'recoveryMpa') return state.run.recoveryMpa;
    return null;
}
function itemReady(item) {
    var inp = item.step.input; if (!inp) return true;
    var v = itemInputValue(item);
    return inp === 'holderKg' || inp === 'withKg' ? positive(v) : measured(v);
}
function log(where, text) { state.run.log.push({ t: nowIso(), where: where, text: text }); }
function whereOf(item) { return item ? (item.cyl != null ? (item.cyl + 1) + '本目 ' : '') + (item.step.code || groupOf(item.group).code) : ''; }
function setCheck(item, on) {
    if (on) { state.run.checks[item.key] = nowIso(); log(whereOf(item), '✓ ' + item.step.text); }
    else { delete state.run.checks[item.key]; log(whereOf(item), '✗ 取り消し: ' + item.step.text); }
}

// ---------- 状態カード・チップ ----------
function renderStatus() {
    var box = el('fc_status'), label = el('fc_status_target_label'), target = el('fc_status_target'), note = el('fc_status_target_note');
    var item = currentItem(), cyl = curCyl(), n = state.settings.cylinders.length;
    box.classList.remove('is-warn', 'is-done');
    var g = item ? groupOf(item.group) : null;
    el('fc_status_cyl').textContent = !state.run.started ? '開始前' : (item ? g.code + ' ' + g.title : '全工程完了');
    el('fc_status_next').textContent = !state.run.started ? '次: ① ボンベ情報を入力して開始位置を選ぶ' : (item ? '次: ' + (item.step.code ? '[' + item.step.code + '] ' : '') + item.step.text : '');
    if (!lastPlan) {
        el('fc_status_total').textContent = '用意 ' + n + '本';
        label.textContent = '目標一次圧'; target.textContent = '-'; note.textContent = 'ボンベ情報・機体条件を確認してください';
        box.classList.add('is-warn'); renderProgress(0, 0, 0); return;
    }
    el('fc_status_total').textContent = '使用予定 ' + (lastIndex + 1) + '本 / 用意 ' + n + '本';
    var after = afterFilling(), filled = filledTotal(), row = rowOf(cyl);
    if (after) {
        var L = lastLift && lastLift.measured ? lastLift : null;
        if (L) {
            label.textContent = '想定上昇速度（体重計）'; target.textContent = L.canFly ? rate(L.ascentRate) : '上がらない';
            note.textContent = '目標 ' + rate(L.targetAscentRate) + ' ・ 計算との差 ' + pct(L.errorPct) + (L.withinTolerance ? '（±5%以内）' : '（±5%超）');
            box.classList.add(L.withinTolerance ? 'is-done' : 'is-warn');
        } else { label.textContent = '充填量'; target.textContent = litres(filled); note.textContent = '必要 ' + litres(lastPlan.requiredL) + ' ・ 次は F 浮力確認'; box.classList.add('is-done'); }
    } else if (cylDone(cyl)) {
        label.textContent = (cyl + 1) + '本目で入った量'; target.textContent = litres(deliveredOf(cyl)); note.textContent = '一次圧 ' + mpa(Number(state.run.cyl[cyl].initialMpa)) + ' → ' + mpa(Number(state.run.cyl[cyl].finalMpa));
    } else if (row && (row.role === 'full' || row.role === 'partial')) {
        label.textContent = (cyl + 1) + '本目の目標一次圧（ここで出口を閉める）'; target.textContent = mpa(row.targetMpa);
        note.textContent = (row.initialIsMeasured ? '実測 ' + mpa(row.startMpa) : '予定 ' + mpa(row.startMpa) + '（実測を入れると更新）') + ' → 約 ' + litres(row.useL) + (row.role === 'partial' ? '（途中まで）' : '');
    } else { label.textContent = '目標一次圧'; target.textContent = '-'; note.textContent = 'このボンベの容積・初期圧を確認してください'; box.classList.add('is-warn'); }
    if (lastPlan.insufficient && !after) { box.classList.add('is-warn'); note.textContent += ' ／ 全ボンベを使っても約 ' + litres(lastPlan.shortfallL) + ' 不足'; }
    var nowL = !after && row && !cylDone(cyl) ? row.useL : 0;
    renderProgress(filled, nowL, lastPlan.requiredL);
}
function renderProgress(done, now, required) {
    var p = function (v) { return required > 0 ? Math.max(0, Math.min(100, v / required * 100)) : 0; };
    var dp = p(done), np = Math.min(p(now), 100 - dp);
    el('fc_progress_done').style.width = dp + '%'; el('fc_progress_now').style.width = np + '%';
    var text = required > 0 ? '充填済み ' + litres(done) + ' / 必要 ' + litres(required) + '（残り ' + litres(Math.max(0, required - done)) + '）' : '';
    if (now > 0) text += ' ・ このボンベの予定 ' + litres(now);
    el('fc_progress_text').textContent = text; el('fc_progress_label').setAttribute('aria-label', text);
}
function renderChips() {
    var box = el('fc_status');
    var chips = [[el('fc_status_cyl').textContent, 'on'], [el('fc_status_target_label').textContent.replace(/（.*）/, '').replace(/^\d+本目の/, '') + ' ' + el('fc_status_target').textContent, box.classList.contains('is-warn') ? 'error' : (box.classList.contains('is-done') ? 'ok' : '')]];
    if (lastPlan) chips.push(['残り ' + litres(Math.max(0, lastPlan.requiredL - filledTotal())), '']);
    el('fc_chips').innerHTML = chips.map(function (c) { return '<span class="chip ' + c[1] + '">' + escapeHtml(c[0]) + '</span>'; }).join('');
}

// ---------- ① ボンベ情報と開始位置 ----------
function countOptionsHtml() { var h = ''; for (var i = 1; i <= Core.MAX_CYLINDERS; i += 1) h += '<option value="' + i + '"' + (i === state.settings.cylinders.length ? ' selected' : '') + '>' + i + ' 本</option>'; return h; }
function cylinderRowsHtml() {
    return state.settings.cylinders.map(function (c, i) {
        var r = state.run.cyl[i];
        return '<div class="cyl-grid cyl5' + (cylDone(i) ? ' is-used' : '') + '"><strong>' + (i + 1) + '</strong>' +
            '<input type="number" min="0.1" step="0.1" inputmode="decimal" data-cyl="' + i + '" data-field="volumeL" value="' + escapeHtml(c.volumeL) + '" aria-label="' + (i + 1) + '本目の容積 (L)">' +
            '<input type="number" min="0" max="15" step="0.1" inputmode="decimal" data-cyl="' + i + '" data-field="pressureMpa" value="' + escapeHtml(c.pressureMpa) + '" aria-label="' + (i + 1) + '本目の初期圧 (MPa)">' +
            '<input type="number" min="0" max="15" step="0.01" inputmode="decimal" data-run-cyl="' + i + '" data-run-field="initialMpa" value="' + escapeHtml(r.initialMpa) + '" placeholder="-" aria-label="' + (i + 1) + '本目の実測開始一次圧">' +
            '<input type="number" min="0" max="15" step="0.01" inputmode="decimal" data-run-cyl="' + i + '" data-run-field="finalMpa" value="' + escapeHtml(r.finalMpa) + '" placeholder="-" aria-label="' + (i + 1) + '本目の実測終了一次圧"></div>';
    }).join('');
}
function setupPreviewHtml() {
    if (!lastPlan) return '<p class="note error">' + escapeHtml(el('fc_error').textContent || '入力を確認してください') + '</p>';
    var g = state.settings.gas, about = lastRequired.source === 'manual' ? '直接入力' : '気球 ' + g.balloonMassG + ' g・上昇速度 ' + g.targetAscentRate + ' m/s';
    var plan = lastPlan.rows.filter(function (r) { return r.state === 'done'; }).map(function (r) { return '<li class="is-done"><b>' + (r.index + 1) + '本目</b> 使用済み（約 ' + litres(r.deliveredL) + '）</li>'; }).join('') +
        lastPlan.rows.filter(function (r) { return r.state !== 'done' && (r.role === 'full' || r.role === 'partial'); }).map(function (r) { return '<li><b>' + (r.index + 1) + '本目</b> ' + mpa(r.targetMpa) + ' まで（約 ' + litres(r.useL) + '）</li>'; }).join('');
    return '<p class="setup-need">必要ガス量 <b>' + litres(lastPlan.requiredL) + '</b><span class="note">（' + escapeHtml(about) + '）</span></p>' +
        (plan ? '<ul class="setup-plan">' + plan + '</ul>' : '') +
        (lastPlan.insufficient ? '<p class="note error">全ボンベを使っても約 ' + litres(lastPlan.shortfallL) + ' 不足します。本数を増やしてください。</p>' : '');
}
function startSelectHtml() {
    if (!GROUPS.some(function (g) { return g.id === startSel.group; })) startSel.group = 'day';
    var items = TL.filter(function (t) { return t.group === startSel.group; });
    if (!items.some(function (t) { return t.key === startSel.key; })) startSel.key = items.length ? items[0].key : '';
    return '<label class="field"><span>開始する節</span><select data-start="group">' + GROUPS.map(function (g) { return '<option value="' + g.id + '"' + (g.id === startSel.group ? ' selected' : '') + '>' + escapeHtml(g.code + ' ' + g.title) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>開始する手順</span><select data-start="key">' + items.map(function (t) { var txt = t.step.text.length > 36 ? t.step.text.slice(0, 36) + '…' : t.step.text; return '<option value="' + t.key + '"' + (t.key === startSel.key ? ' selected' : '') + '>' + escapeHtml((t.step.code ? t.step.code + ' ' : '') + txt) + '</option>'; }).join('') + '</select></label>';
}
function renderSetup() {
    var box = el('fc_setup');
    box.className = 'card setup-card';
    box.innerHTML = '<h3>' + (state.run.started ? 'ボンベ情報（作業中も変更できます）' : 'まずボンベ情報を入力') + '</h3>' +
        '<p class="note">ボンベのラベルと圧力計で容積と初期圧（一次圧）を入れます。途中から始めるときや後から直すときは、使ったボンベの「実測開始・実測終了」の一次圧も入れてください（空欄なら予定どおり使ったものとして扱います）。</p>' +
        '<label class="field"><span>本数</span><select data-setup="count">' + countOptionsHtml() + '</select></label>' +
        '<div class="cyl-grid cyl5 cyl-head"><span>本</span><span>容積 L</span><span>初期圧 MPa</span><span>実測開始</span><span>実測終了</span></div>' +
        '<div class="setup-cyls">' + cylinderRowsHtml() + '</div>' +
        '<div id="fc_setup_preview" class="setup-preview">' + setupPreviewHtml() + '</div>' +
        '<h3>開始位置</h3>' +
        '<p class="note">全シーケンス（現地入り〜放球）のどこから始めるかを選びます。前の手順はスキップ扱いになり、あとからでもチェックできます。</p>' +
        '<div id="fc_start_pick" class="start-pick">' + startSelectHtml() + '</div>' +
        '<div class="setup-actions">' +
        (state.run.started ? '<button type="button" class="btn" data-action="restart-here">開始位置をここに変更</button><button type="button" class="btn btn-primary btn-big" data-action="go-check">② タイムラインへ ▶</button>'
            : '<button type="button" class="btn btn-primary btn-big" data-action="start">ここから始める ▶</button>') +
        '</div>';
}
function renderSetupSummary() {
    var box = el('fc_setup_summary');
    if (!state.run.started) {
        box.className = 'card locked-card';
        box.innerHTML = '<p>先に <b>① ボンベ情報</b> を入力して、開始位置を選んで「ここから始める」を押してください。</p><button type="button" class="btn btn-primary btn-big" data-action="go-gas">① ボンベ情報へ</button>';
        return;
    }
    var cyls = state.settings.cylinders.map(function (c) { return fmt(Number(c.volumeL), 0) + 'L/' + fmt(Number(c.pressureMpa), 1); }).join('・');
    box.className = 'setup-summary';
    box.innerHTML = '<span>ボンベ ' + state.settings.cylinders.length + '本（' + escapeHtml(cyls) + ' MPa）' + (lastPlan ? ' ・ 必要 ' + litres(lastPlan.requiredL) : '') + '</span><button type="button" class="btn btn-small" data-action="go-gas">ボンベ情報・開始位置を変更</button>';
}
function onSetupInput(e) {
    var t = e.target, s = state.settings;
    if (t.dataset.start) {
        if (t.dataset.start === 'group') { startSel.group = t.value; startSel.key = ''; } else startSel.key = t.value;
        if (e.type === 'change') later(function () { el('fc_start_pick').innerHTML = startSelectHtml(); });
        return;
    }
    if (t.dataset.setup === 'count') { if (e.type === 'change') { setCylinderCount(Number(t.value)); later(refresh); } return; }
    if (t.dataset.cyl != null) s.cylinders[Number(t.dataset.cyl)][t.dataset.field] = t.value;
    else if (t.dataset.runCyl != null) state.run.cyl[Number(t.dataset.runCyl)][t.dataset.runField] = t.value;
    else return;
    compute(); renderStatus(); renderChips(); renderPlan();
    var preview = el('fc_setup_preview'); if (preview) preview.innerHTML = setupPreviewHtml();
    if (e.type === 'change') {
        var i = Number(t.dataset.cyl != null ? t.dataset.cyl : t.dataset.runCyl);
        var what = { volumeL: '容積 ' + t.value + ' L', pressureMpa: '初期圧 ' + t.value + ' MPa', initialMpa: '実測開始 ' + t.value + ' MPa', finalMpa: '実測終了 ' + t.value + ' MPa' }[t.dataset.field || t.dataset.runField];
        log('①', 'ボンベ情報を変更: ' + (i + 1) + '本目 ' + what);
        later(function () { renderSetupSummary(); renderFocus(); renderTimeline(); renderLog(); el('fc_start_pick').innerHTML = startSelectHtml(); });
    }
    save();
}
function setCylinderCount(n) {
    var s = state.settings;
    while (s.cylinders.length < n) { var last = s.cylinders[s.cylinders.length - 1] || { volumeL: 47, pressureMpa: 14 }; s.cylinders.push({ volumeL: last.volumeL, pressureMpa: last.pressureMpa }); }
    s.cylinders.length = n; resizeRun(state);
}
// 途中のボンベ以降から始めるとき、前のボンベの実測が空なら「予定どおり使った」として埋める
function assumeEarlierCylinders(item) {
    var idx = TL.indexOf(item), upto = item.cyl != null ? item.cyl : (idx > lastDIndex() ? lastIndex + 1 : 0), filledIn = [];
    for (var i = 0; i < upto && i < state.settings.cylinders.length; i += 1) {
        if (cylDone(i)) continue;
        var r = state.run.cyl[i], row = rowOf(i);
        if (!measured(r.initialMpa)) r.initialMpa = String(state.settings.cylinders[i].pressureMpa);
        if (!measured(r.finalMpa)) r.finalMpa = String(row && row.targetMpa != null ? row.targetMpa : state.settings.gas.targetCylinderPressureMpa);
        filledIn.push((i + 1) + '本目 ' + r.initialMpa + '→' + r.finalMpa + ' MPa');
        compute();
    }
    if (filledIn.length) { log('①', '実測が空のため予定どおり使ったとして入力: ' + filledIn.join('、')); toast('前のボンベの実測が空だったので、予定どおり使ったとして入れました（① で直せます）'); }
}
function startAt(key, changing) {
    if (!lastPlan) { toast('ボンベ情報・機体条件を確認してください'); return; }
    var item = TL.find(function (t) { return t.key === key; }) || TL[0];
    assumeEarlierCylinders(item);
    item = TL.find(function (t) { return t.key === key; }) || TL[0];
    state.run.started = true; state.run.startKey = item.key;
    log(groupOf(item.group).code, (changing ? '開始位置を変更: ' : '開始: ') + (item.step.code ? item.step.code + ' ' : '') + item.step.text);
    lastScrolledKey = null;
    selectTab('check'); refresh();
}

// ---------- ② タイムライン ----------
function inputHtml(item, big) {
    var inp = item.step.input; if (!inp) return '';
    var v = itemInputValue(item), attr, unit, label, step = '0.01';
    if (inp === 'initial' || inp === 'final') { attr = 'data-pressure="' + (inp === 'initial' ? 'initialMpa' : 'finalMpa') + '" data-pcyl="' + item.cyl + '"'; unit = 'MPa'; label = inp === 'initial' ? '開始時の一次圧' : '出口を閉めた直後の一次圧'; }
    else if (inp === 'recoveryMpa') { attr = 'data-recovery="1"'; unit = 'MPa'; label = '回復後の一次圧'; }
    else { attr = 'data-lift="' + inp + '"'; unit = 'kg'; step = '0.05'; label = inp === 'holderKg' ? '保持者の体重' : '気球を持った状態の体重'; }
    return '<label class="' + (big ? 'focus-input' : 'fc-step-input') + '">' + (big ? '<span>' + label + '</span>' : '') +
        '<input type="number" step="' + step + '" min="0" inputmode="decimal" ' + attr + ' value="' + escapeHtml(v) + '" aria-label="' + label + '"><span>' + unit + '</span></label>';
}
function targetHtml(item, big) {
    var s = item.step; if (item.cyl == null) return '';
    var row = rowOf(item.cyl), done = cylDone(item.cyl);
    if (s.target) {
        if (done) return '';
        return row && row.targetMpa != null ? (big ? '<p class="focus-target">一次圧 <b>' + mpa(row.targetMpa) + '</b> まで</p>' : '<span class="fc-step-target">' + mpa(row.targetMpa) + ' まで</span>') : '<span class="fc-step-meta">このボンベは不要（必要量に到達）</span>';
    }
    if (s.input === 'final') {
        if (done) return '<span class="fc-step-meta topup-added">→ このボンベで約 ' + litres(deliveredOf(item.cyl)) + '</span>';
        if (row && row.targetMpa != null) return big ? '<p class="focus-target">目標 ' + mpa(row.targetMpa) + '</p>' : '<span class="fc-step-meta">目標 ' + mpa(row.targetMpa) + '</span>';
    }
    return '';
}
function liftSummaryHtml() {
    var L = lastLift;
    if (!L || L.error) return '<p class="fc-error">' + escapeHtml(L && L.error || '') + '</p>';
    if (!L.measured) return '<p class="note">F-1・F-2 の体重を入れると判定します。目標は「②が①より ' + kg(L.targetPullKg) + ' 軽い」。</p>';
    var ok = L.withinTolerance, need = L.deltaPullKg > liftResolution();
    return '<div class="lift-judge ' + (ok ? 'is-ok' : 'is-warn') + '"><span>計算との差 <b>' + pct(L.errorPct) + '</b>' + (ok ? '（±5%以内）' : '（±5%を超えています）') + '</span><span>想定上昇速度 <b>' + (L.canFly ? rate(L.ascentRate) : '上がらない') + '</b>（目標 ' + rate(L.targetAscentRate) + '）</span></div>' +
        (need ? '<p class="note warn">あと約 ' + kg(L.deltaPullKg) + '（ヘリウム約 ' + litres(L.gasAdjustL) + '）足りません。「③ 浮力」の追加充填をしてから F-2 を測り直してください。</p><p><button type="button" class="btn btn-primary btn-big" data-action="go-lift">③ 追加充填へ</button></p>' :
            (L.deltaPullKg < -liftResolution() ? '<p class="note warn">浮力が目標より約 ' + kg(-L.deltaPullKg) + ' 多い。「③ 浮力」で対応を確認してください。</p>' : ''));
}
function renderFocus() {
    var box = el('fc_focus');
    box.hidden = !state.run.started; if (!state.run.started) return;
    var idx = currentIndex(), item = idx < 0 ? null : TL[idx], anyDone = Object.keys(state.run.checks).length > 0;
    var g = item ? groupOf(item.group) : null;
    var head = '<div class="focus-head"><span>' + (item ? escapeHtml(g.code + ' ' + g.title) + ' ・ ' + (idx + 1) + ' / ' + TL.length : '全工程') + '</span><button type="button" class="btn btn-small" data-action="undo"' + (anyDone ? '' : ' disabled') + '>↶ 1つ戻す</button></div>';
    if (!item) { box.innerHTML = head + '<p class="focus-text">全工程が完了しました。</p><p class="note">記録を上部の「記録をコピー」か「CSV」で保存してください。</p>'; speakKey('end', '全工程が完了しました。'); return; }
    var s = item.step, extra = inputHtml(item, true) + targetHtml(item, true);
    if (s.lift) extra += liftSummaryHtml();
    if (s.action === 'go-gas') extra += '<p><button type="button" class="btn" data-action="go-gas">① ボンベ情報を開く</button></p>';
    box.innerHTML = head + '<p class="focus-section">' + (s.code ? '<span class="code">' + escapeHtml(s.code) + '</span>' : '') + escapeHtml(g.title) + '</p>' +
        '<p class="focus-text">' + escapeHtml(s.text) + '</p>' + (s.note ? '<p class="focus-note">' + escapeHtml(s.note) + '</p>' : '') + extra +
        '<div class="focus-actions"><button type="button" class="btn btn-primary btn-huge" data-action="complete" data-key="' + item.key + '"' + (itemReady(item) ? '' : ' disabled') + '>✓ 完了</button></div>';
    var row = item.cyl != null ? rowOf(item.cyl) : null;
    speakKey(item.key, s.text + (s.target && row && row.targetMpa != null ? '。目標は' + fmt(row.targetMpa, 2) + 'メガパスカル' : ''));
}
function renderGroupBar() {
    var idx = currentIndex(), cur = idx < 0 ? null : TL[idx].group;
    el('fc_groupbar').innerHTML = GROUPS.map(function (g) {
        var items = TL.filter(function (t) { return t.group === g.id; }), done = items.filter(function (t) { return state.run.checks[t.key]; }).length;
        var cls = 'gchip' + (g.id === cur ? ' is-current' : '') + (items.length && done === items.length ? ' is-done' : '');
        return '<button type="button" class="' + cls + '" data-jump="' + g.id + '" title="' + escapeHtml(g.title) + '"><b>' + escapeHtml(g.code) + '</b><span>' + done + '/' + items.length + '</span></button>';
    }).join('');
}
function renderTimeline() {
    renderGroupBar();
    var s = startIndex(), idx = currentIndex(), html = '';
    GROUPS.forEach(function (g) {
        var items = TL.filter(function (t) { return t.group === g.id; });
        if (!items.length) return;
        var done = items.filter(function (t) { return state.run.checks[t.key]; }).length;
        html += '<section class="tl-group" id="grp-' + g.id + '"><header class="tl-head"><span class="tl-code">' + escapeHtml(g.code) + '</span><span class="tl-title">' + escapeHtml(g.title) + '</span><span class="tl-count">' + done + '/' + items.length + '</span>' +
            '<button type="button" class="btn btn-small" data-start-key="' + items[0].key + '">ここから開始</button></header>';
        items.forEach(function (item) {
            var i = TL.indexOf(item), checked = !!state.run.checks[item.key], skipped = !checked && i < s, next = i === idx, id = safeId(item.key);
            var cls = 'fc-step' + (checked ? ' is-done' : '') + (skipped ? ' is-skipped' : '') + (next ? ' is-next' : '');
            var dis = item.step.input && !checked && !itemReady(item) ? ' disabled' : '';
            var meta = checked ? '<span class="fc-step-meta">' + clock(state.run.checks[item.key]) + ' 確認</span>' : (skipped ? '<span class="fc-step-meta">スキップ</span>' : '');
            html += '<div class="' + cls + '" data-row="' + item.key + '" id="row-' + id + '"><input type="checkbox" id="chk_' + id + '" data-key="' + item.key + '"' + (checked ? ' checked' : '') + dis + '>' +
                '<div class="fc-step-body"><label class="fc-step-text" for="chk_' + id + '">' + (item.step.code ? '<span class="code">' + escapeHtml(item.step.code) + '</span>' : '') + escapeHtml(item.step.text) + '</label>' +
                (item.step.note ? '<span class="fc-step-note">' + escapeHtml(item.step.note) + '</span>' : '') + inputHtml(item, false) + targetHtml(item, false) + meta + '</div></div>';
        });
        html += '</section>';
    });
    el('fc_steps').innerHTML = html;
    var cur = idx < 0 ? null : TL[idx].key;
    if (cur && cur !== lastScrolledKey && !el('fc_tab_check').hidden) {
        lastScrolledKey = cur;
        var rowEl = el('row-' + safeId(cur)), list = el('fc_steps');
        if (rowEl) later(function () { list.scrollTop = Math.max(0, rowEl.offsetTop - 40); });
    }
}
function completeKey(key) {
    var item = TL.find(function (t) { return t.key === key; }); if (!item) return;
    if (!itemReady(item)) { toast('値を入力してください'); var i = el('fc_focus').querySelector('input'); if (i) i.focus(); return; }
    setCheck(item, true);
    if (item.step.input === 'recoveryMpa') log(whereOf(item), '残圧の回復: ' + mpa(Number(state.run.recoveryMpa)));
    refresh();
}
function undoStep() {
    var c = state.run.checks, lastKey = null;
    Object.keys(c).forEach(function (k) { if (!lastKey || c[k] > c[lastKey]) lastKey = k; });
    if (!lastKey) return;
    var item = TL.find(function (t) { return t.key === lastKey; });
    if (item) setCheck(item, false); else delete c[lastKey];
    refresh();
}
function setPressure(cyl, key, value) {
    var r = state.run.cyl[cyl], loggedKey = 'logged_' + key;
    r[key] = value;
    if (!measured(value) || value === r[loggedKey]) return;
    r[loggedKey] = value;
    var where = (cyl + 1) + '本目';
    if (key === 'initialMpa') { log(where, '開始一次圧 ' + mpa(Number(value)) + ' を入力'); return; }
    var row = rowOf(cyl), target = row && row.targetMpa != null ? row.targetMpa : null;
    compute();
    log(where, '終了一次圧 ' + mpa(Number(value)) + ' を入力' + (target != null ? '（目標 ' + mpa(target) + '）' : '') + ' → このボンベから約 ' + litres(deliveredOf(cyl)));
}
function onTimelineInput(e) {
    var t = e.target;
    if (t.dataset.key) { if (e.type === 'change') { var item = TL.find(function (x) { return x.key === t.dataset.key; }); if (item) { setCheck(item, t.checked); later(refresh); } } return; }
    if (t.dataset.pressure) {
        var cyl = Number(t.dataset.pcyl);
        if (e.type === 'change') { setPressure(cyl, t.dataset.pressure, t.value); later(refresh); }
        else { state.run.cyl[cyl][t.dataset.pressure] = t.value; liveUpdate(t); }
        save(); return;
    }
    if (t.dataset.lift) { state.run.lift[t.dataset.lift] = t.value; if (e.type === 'change') later(refresh); else liveUpdate(t); save(); return; }
    if (t.dataset.recovery) { state.run.recoveryMpa = t.value; if (e.type === 'change') later(refresh); else liveUpdate(t); save(); }
}
// 入力中は描き直さず、完了ボタンなどの有効・無効と上部の表示だけ更新する
function liveUpdate(t) {
    compute(); renderStatus(); renderChips();
    var item = currentItem(), done = el('fc_focus').querySelector('[data-action="complete"]');
    if (done && item) done.disabled = !itemReady(item);
    var row = t.closest('.fc-step'), box = row && row.querySelector('input[type="checkbox"]');
    if (box && !box.checked) { var it = TL.find(function (x) { return x.key === box.dataset.key; }); if (it) box.disabled = !itemReady(it); }
}
function onStepRowClick(e) {
    var jump = e.target.closest('[data-jump]');
    if (jump) { var g = el('grp-' + jump.dataset.jump), list = el('fc_steps'); if (g) list.scrollTop = g.offsetTop; return; }
    var sk = e.target.closest('[data-start-key]');
    if (sk) {
        if (Object.keys(state.run.checks).length && !root.confirm('ここから開始します（チェック済みの記録は残ります）。よろしいですか？')) return;
        startAt(sk.dataset.startKey, true); return;
    }
    var row = e.target.closest('.fc-step');
    if (!row || e.target.closest('input, label, button')) return;
    var box = row.querySelector('input[type="checkbox"]');
    if (box && !box.disabled) box.click();
}

// ---------- ボンベ計画表・設定フォーム ----------
function renderPlan() {
    var body = el('fc_plan_body'), sum = el('fc_summary');
    if (!lastPlan) { body.innerHTML = ''; sum.innerHTML = ''; return; }
    var p2 = function (v) { return v == null || !Number.isFinite(Number(v)) ? '-' : fmt(v, 2); }, cc = curCyl();
    body.innerHTML = lastPlan.rows.map(function (row) {
        var cls = row.state === 'done' ? 'is-done' : (row.index === cc && state.run.started ? 'is-current' : ''), r = state.run.cyl[row.index];
        var initial = row.state === 'done' ? p2(row.initialMpa) : (row.startMpa == null ? '-' : p2(row.startMpa) + (row.initialIsMeasured ? '' : ' <span class="is-planned">予定</span>'));
        var target = row.state === 'done' ? '-' : (row.targetMpa != null ? p2(row.targetMpa) : (row.role === 'unused' ? '不要' : '-'));
        var final = measured(r.finalMpa) ? p2(Number(r.finalMpa)) : '-';
        var use = row.state === 'done' ? litres(row.deliveredL) : (row.useL > 0 ? litres(row.useL) + ' <span class="is-planned">予定</span>' : '-');
        return '<tr class="' + cls + '"><td>' + (row.index + 1) + '</td><td>' + initial + '</td><td>' + target + '</td><td>' + final + '</td><td>' + use + '</td></tr>';
    }).join('');
    var items = [['必要ガス量', litres(lastPlan.requiredL) + (lastRequired.source === 'manual' ? '（直接入力）' : '')]];
    if (lastRequired.source === 'calc') items.push(['総重量', fmt(lastRequired.totalMassKg, 3) + ' kg'], ['純浮力', fmt(lastRequired.pureLiftKg, 3) + ' kg'], ['全浮力（計量目安）', fmt(lastRequired.totalLiftKg, 3) + ' kg']);
    items.push(['充填済み（使い終わったボンベ）', litres(lastPlan.filledL)], ['残り必要量', litres(lastPlan.remainingL)], ['計算過程', 'n = ' + fmt(lastPlan.exponentN, 2)]);
    if (lastPlan.insufficient) items.push(['不足', '<span class="is-warn">約 ' + litres(lastPlan.shortfallL) + '</span>']);
    sum.innerHTML = items.map(function (it) { return '<dt>' + it[0] + '</dt><dd>' + it[1] + '</dd>'; }).join('');
}
function renderSettings() {
    var form = el('fc_settings'), s = state.settings;
    form.elements.requiredMode.value = s.requiredMode;
    form.elements.manualRequiredL.value = s.manualRequiredL;
    GAS_FIELDS.forEach(function (k) { var f = form.elements['gas.' + k]; if (f && document.activeElement !== f) f.value = s.gas[k] == null ? '' : String(s.gas[k]); });
    updateModeVisibility();
}
function updateModeVisibility() {
    var form = el('fc_settings'), mode = state.settings.requiredMode, inputMode = state.settings.gas.inputMode;
    form.querySelectorAll('[data-mode]').forEach(function (n) { n.hidden = n.dataset.mode !== mode; });
    form.querySelectorAll('[data-input-mode]').forEach(function (n) { n.hidden = n.dataset.inputMode !== inputMode; });
    form.elements['gas.polytropicN'].closest('label').hidden = state.settings.gas.cylinderProcess !== 'polytropic';
}
function onSettingsInput(e) {
    var t = e.target, s = state.settings;
    if (t.name && t.name.indexOf('gas.') === 0) s.gas[t.name.slice(4)] = t.value;
    else if (t.name) s[t.name] = t.value;
    updateModeVisibility();
    compute(); renderStatus(); renderChips(); renderPlan();
    if (e.type === 'change') later(function () { renderSetup(); renderSetupSummary(); renderTimeline(); renderFocus(); renderLift(); renderTopup(); });
    save();
}

// ---------- ③ 浮力測定・追加充填 ----------
function liftResolution() { return Number(state.run.lift.resolutionKg) > 0 ? Number(state.run.lift.resolutionKg) : 0.1; }
function renderLift() {
    var L = lastLift || {}, res = el('fc_lift_result'), tgt = el('fc_lift_target');
    if (L.error) { tgt.textContent = ''; res.innerHTML = '<p class="fc-error">' + escapeHtml(L.error) + '（「① ボンベ」の機体条件を確認）</p>'; el('fc_lift_record').disabled = true; return; }
    tgt.innerHTML = '目標: ②が①より <strong>' + kg(L.targetPullKg) + '</strong> 軽くなれば上昇速度 ' + rate(L.targetAscentRate) + '（計算の全浮力 ' + kg(L.targetGrossLiftKg) + '・総重量 ' + kg(L.totalMassKg) + '・気球 ' + kg(L.balloonKg) + '）';
    el('fc_lift_record').disabled = !L.measured;
    if (!L.measured) { res.innerHTML = ''; return; }
    var warn = !L.canFly || !L.withinTolerance;
    var html = '<div class="fc-lift-rate' + (warn ? ' is-warn' : '') + '"><span>想定上昇速度</span><strong>' + (L.canFly ? rate(L.ascentRate) : '上がらない') + '</strong></div>';
    html += '<dl class="fc-summary">' + [
        ['計算との差（F-2：±5%以内）', '<span class="' + (L.withinTolerance ? 'ok-text' : 'is-warn') + '">' + pct(L.errorPct) + (L.withinTolerance ? ' OK' : ' 範囲外') + '</span>'],
        ['体重計の差（①−②）', kg(L.pullKg)],
        ['全浮力（差＋気球＋付属物）', kg(L.grossLiftKg)],
        ['純浮力（全浮力−総重量）', kg(L.pureLiftKg)],
        ['目盛り ±' + fmt(liftResolution(), 2) + ' kg の幅', L.canFly ? rate(Math.max(0, L.rateLow)) + ' 〜 ' + rate(L.rateHigh) : '-']
    ].map(function (it) { return '<dt>' + it[0] + '</dt><dd>' + it[1] + '</dd>'; }).join('') + '</dl>';
    var advice, cls;
    if (Math.abs(L.deltaPullKg) <= liftResolution()) { advice = '目標どおりです（差は目盛り以内）'; cls = 'is-ok'; }
    else if (L.deltaPullKg > 0) { advice = '浮力不足: あと約 ' + kg(L.deltaPullKg) + '（ヘリウム約 ' + litres(L.gasAdjustL) + '）。下の追加充填へ'; cls = 'is-warn'; }
    else { advice = '浮力過多: 目標より約 ' + kg(-L.deltaPullKg) + '（ヘリウム約 ' + litres(-L.gasAdjustL) + '）多い'; cls = 'is-warn'; }
    res.innerHTML = html + '<p class="fc-lift-advice ' + cls + '">' + advice + '</p>';
}
function recordLift() {
    var L = lastLift; if (!L || !L.measured) return;
    var l = state.run.lift;
    log('F', '浮力測定: 保持者 ' + kg(Number(l.holderKg)) + ' / 気球込み ' + kg(Number(l.withKg)) + '（付属物 ' + (Number(l.attachedG) || 0) + ' g）→ 差 ' + kg(L.pullKg) + '・計算との差 ' + pct(L.errorPct) + '・想定上昇速度 ' + (L.canFly ? rate(L.ascentRate) : '上がらない') + '（目標 ' + rate(L.targetAscentRate) + '）');
    refresh(); toast('浮力測定を記録しました');
}
function renderLiftInputs() { document.querySelectorAll('#fc_lift [data-lift]').forEach(function (i) { if (document.activeElement !== i) i.value = state.run.lift[i.dataset.lift]; }); }

// 浮力確認はホースが入ったまま・最後のボンベにレギュレータが付いたまま行う（全シーケンス表 E-3・F-2）。
// E-3 で脱圧は済んでいて、元栓・出口・圧力調整バルブはすべて閉。ホースは気球に入ったままなので、
// 追加充填ではレギュレータの付け直しやホースの締結が要らず、通常の開栓→二次圧調整→充填→脱圧を1回やり直すだけ。
// 残圧が足りないときだけ次のボンベへ付け替える。
var TOPUP_STEPS = [
    { id: 'u0', swap: true, text: 'レギュレータ（ホース付き）を{cyl}のボンベへ付け替える：今のボンベの元栓・出口・圧力調整バルブが閉まっているのを確認して外し、{cyl}のキャップを外す→元栓閉を確認→フラッシング→パッキン確認→取り付け' },
    { id: 'u1', text: 'レギュレータの出口バルブ・圧力調整バルブが閉まっている（脱圧済み）ことを確認し、開栓許可を得て周囲に声を出して知らせる' },
    { id: 'u2', text: '{cyl}の元栓をゆっくり（1秒に5°程度）開け、一次圧の指針が止まったら入力する', input: 'startMpa' },
    { id: 'u3', text: '圧力調整バルブで二次圧を 0.5〜0.8 MPa に調整し直す（脱圧で緩めてあるため）' },
    { id: 'u4', text: '出口バルブをゆっくり開けて充填し、一次圧が目標まで下がったら閉めて、直後の一次圧を入力する', input: 'endMpa', target: true },
    { id: 'u5', text: '脱圧する：元栓を閉め、出口バルブを開けて一次圧・二次圧が0になったら閉め、圧力調整バルブも閉める（レギュレータは付けたまま）' },
    { id: 'u6', text: 'もう一度浮力を測る（② タイムラインの F-2 を測り直す）' }
];
function regulatorCyl() { var h = state.run.topup.history; return h.length ? h[h.length - 1].cyl : lastIndex; }
function cylinderPressureNow(i) {
    var hist = state.run.topup.history.filter(function (h) { return h.cyl === i; });
    if (hist.length) return Number(hist[hist.length - 1].endMpa);
    var r = state.run.cyl[i] || {};
    if (measured(r.finalMpa)) return Number(r.finalMpa);
    if (measured(r.initialMpa)) return Number(r.initialMpa);
    return Number(state.settings.cylinders[i].pressureMpa);
}
function topupCandidates() {
    var n = state.settings.cylinders.length, reg = Math.min(regulatorCyl(), n - 1), order = [reg], i;
    for (i = reg + 1; i < n; i += 1) order.push(i);
    for (i = reg - 1; i >= 0; i -= 1) order.push(i);
    return order.map(function (k) { return { index: k, volumeL: Number(state.settings.cylinders[k].volumeL), pressureMpa: cylinderPressureNow(k) }; });
}
function computeTopup() {
    lastTopup = null;
    var L = lastLift;
    if (!L || !L.measured || L.error || !(L.deltaPullKg > liftResolution())) return null;
    try {
        var o = gasOptions(), cands = topupCandidates(), plan = Core.topupPlan(o, L.gasAdjustL, cands), t = state.run.topup;
        if (plan.rows.length && measured(t.startMpa)) {
            var first = plan.rows[0].index;
            cands.forEach(function (c) { if (c.index === first) c.pressureMpa = Number(t.startMpa); });
            plan = Core.topupPlan(o, L.gasAdjustL, cands);
        }
        var addedL = 0;
        if (plan.rows.length && measured(t.startMpa) && measured(t.endMpa)) addedL = Core.deliveredL(Object.assign({}, o, { firstCylinderOffsetMpa: 0 }), plan.rows[0].volumeL, 1, Number(t.startMpa), Number(t.endMpa));
        lastTopup = Object.assign(plan, { addedL: addedL });
    } catch (e) { lastTopup = { error: e.message || String(e), rows: [] }; }
    return lastTopup;
}
function renderTopup() {
    var box = el('fc_topup'), L = lastLift, t = state.run.topup;
    var history = t.history.length ? '<p class="note">これまでの追加充填: ' + t.history.map(function (h) { return (h.cyl + 1) + '本目 ' + fmt(h.startMpa, 2) + '→' + fmt(h.endMpa, 2) + ' MPa（約 ' + litres(h.addedL) + '）'; }).join('、') + '</p>' : '';
    if (!L || !L.measured || L.error) { box.innerHTML = history; return; }
    if (Math.abs(L.deltaPullKg) <= liftResolution()) { box.innerHTML = '<div class="card topup-card is-ok"><h3>追加充填</h3><p>目標の上昇速度 ' + rate(L.targetAscentRate) + ' になっています（差は体重計の目盛り以内）。追加充填は不要です。次は G 締結へ。</p>' + history + '</div>'; return; }
    if (L.deltaPullKg < 0) {
        box.innerHTML = '<div class="card topup-card"><h3>浮力が目標より多い</h3><p>目標より約 <b>' + kg(-L.deltaPullKg) + '</b>（ヘリウム約 ' + litres(-L.gasAdjustL) + '）多く、このままだと想定上昇速度は <b>' + (L.canFly ? rate(L.ascentRate) : '-') + '</b>（目標 ' + rate(L.targetAscentRate) + '）です。</p>' +
            '<ol class="topup-steps plain"><li>このまま放球してよいか判断する（上昇が速いと破裂高度・飛行時間が変わる）。</li><li>下げる場合は、ホースを気球に入れたまま、他者がホースを保持し、レギュレータの圧力調整バルブ・出口バルブを開けて少しずつガスを抜く。</li><li>バルブを閉めて F-2 をもう一度測る。目標との差が目盛り以内になるまで繰り返す。</li></ol>' + history + '</div>';
        return;
    }
    var P = lastTopup;
    if (!P || P.error) { box.innerHTML = '<p class="fc-error">' + escapeHtml(P && P.error || '追加充填を計算できません') + '</p>'; return; }
    var first = P.rows[0];
    var head = '<div class="card topup-card"><h3>目標の上昇速度 ' + rate(L.targetAscentRate) + ' にするための追加充填</h3><p class="topup-need">あと約 <b>' + kg(L.deltaPullKg) + '</b> の浮力 ＝ ヘリウム約 <b>' + litres(L.gasAdjustL) + '</b></p>';
    if (!first) { box.innerHTML = head + '<p class="fc-error">一次圧が終了目標より高いボンベが残っていません。① でボンベを追加してください。</p>' + history + '</div>'; return; }
    var cylName = (first.index + 1) + '本目', swap = first.index !== regulatorCyl();
    var plan = '<ul class="topup-plan">' + P.rows.map(function (r, k) { return '<li><b>' + (r.index + 1) + '本目</b>：一次圧 ' + mpa(r.startMpa) + (k === 0 && measured(t.startMpa) ? '（実測）' : '（今の値）') + ' → <b>' + (k === 0 ? '<span id="fc_topup_target">' + mpa(r.targetMpa) + '</span>' : mpa(r.targetMpa)) + '</b> まで（約 ' + litres(r.useL) + '）</li>'; }).join('') + '</ul>';
    var notes = '';
    if (swap) notes += '<p class="note warn">レギュレータが付いている ' + (regulatorCyl() + 1) + '本目には使える残圧がないので、' + cylName + 'へ付け替えます。</p>';
    if (P.insufficient) notes += '<p class="fc-error">残りのボンベをすべて使っても約 ' + litres(P.shortfallL) + ' 足りません。</p>';
    if (P.rows.length > 1) notes += '<p class="note">1本では足りません。' + cylName + 'を目標まで使ったら、同じ手順で ' + (P.rows[1].index + 1) + '本目を ' + mpa(P.rows[1].targetMpa) + ' まで入れます。</p>';
    if (first.dropMpa < 0.5) notes += '<p class="note warn">一次圧の変化が約 ' + fmt(first.dropMpa, 2) + ' MPa と小さく、圧力計では読みにくい量です。出口バルブを少しだけ開けて短時間ずつ入れ、F-2 を測り直すのを繰り返すと確実です。</p>';
    var steps = TOPUP_STEPS.filter(function (st) { return !st.swap || swap; }), c = t.checks, next = steps.find(function (st) { return !c[st.id]; });
    var list = '<ol class="topup-steps">' + steps.map(function (st) {
        var done = !!c[st.id], dis = st.input && !measured(t[st.input]) && !done ? ' disabled' : '', extra = '';
        if (st.target) extra += '<span class="topup-target">目標 一次圧 <b>' + mpa(first.targetMpa) + '</b></span>';
        if (st.input) extra += '<span class="fc-step-input"><input type="number" step="0.01" min="0" max="15" inputmode="decimal" data-topup-pressure="' + st.input + '" value="' + escapeHtml(t[st.input]) + '" aria-label="' + (st.input === 'startMpa' ? '追加充填の開始一次圧' : '追加充填の終了一次圧') + ' (MPa)"> MPa' + (st.input === 'endMpa' ? ' <span id="fc_topup_added" class="topup-added">' + (P.addedL > 0 ? '→ 入った量 約 ' + litres(P.addedL) : '') + '</span>' : '') + '</span>';
        if (done) extra += '<span class="fc-step-meta">' + clock(c[st.id]) + ' 確認</span>';
        return '<li class="fc-step' + (done ? ' is-done' : '') + (next && next.id === st.id ? ' is-next' : '') + '"><input type="checkbox" id="topup_' + st.id + '" data-topup-step="' + st.id + '"' + (done ? ' checked' : '') + dis + '><div class="fc-step-body"><label class="fc-step-text" for="topup_' + st.id + '">' + escapeHtml(st.text.replace(/\{cyl\}/g, cylName)) + '</label>' + extra + '</div></li>';
    }).join('') + '</ol>';
    box.innerHTML = head + plan + notes + '<h3>追加充填の手順（ホースは気球に入れたまま）</h3>' + list +
        '<div class="setup-actions"><button type="button" class="btn btn-primary btn-big" data-action="topup-record"' + (measured(t.endMpa) ? '' : ' disabled') + '>追加充填を記録して F-2 を測り直す</button></div>' + history + '</div>';
}
function updateTopupLive() {
    var added = el('fc_topup_added'), t = state.run.topup;
    if (added) added.textContent = lastTopup && lastTopup.addedL > 0 ? '→ 入った量 約 ' + litres(lastTopup.addedL) : '';
    document.querySelectorAll('#fc_topup [data-topup-step]').forEach(function (b) { var st = TOPUP_STEPS.find(function (x) { return x.id === b.dataset.topupStep; }); if (st.input && !b.checked) b.disabled = !measured(t[st.input]); });
    var target = el('fc_topup_target'); if (target && lastTopup && lastTopup.rows.length) target.textContent = mpa(lastTopup.rows[0].targetMpa);
    var rec = document.querySelector('#fc_topup [data-action="topup-record"]'); if (rec) rec.disabled = !measured(t.endMpa);
}
function onLiftPanelInput(e) {
    var t = e.target;
    if (t.dataset.lift) { state.run.lift[t.dataset.lift] = t.value; compute(); renderLift(); renderStatus(); renderChips(); if (e.type === 'change') later(function () { renderTopup(); renderTimeline(); renderFocus(); }); save(); return; }
    if (t.dataset.topupPressure) { state.run.topup[t.dataset.topupPressure] = t.value; computeTopup(); save(); if (e.type === 'change') later(renderTopup); else updateTopupLive(); return; }
    if (t.dataset.topupStep && e.type === 'change') {
        var st = TOPUP_STEPS.find(function (x) { return x.id === t.dataset.topupStep; }), c = state.run.topup.checks;
        if (t.checked) { c[st.id] = nowIso(); log('追加充填', '✓ ' + st.text.replace(/\{cyl\}/g, '')); } else { delete c[st.id]; log('追加充填', '✗ 取り消し'); }
        save(); later(function () { renderTopup(); renderLog(); });
    }
}
function recordTopup() {
    var t = state.run.topup, P = lastTopup;
    if (!P || !P.rows.length || !measured(t.endMpa)) return;
    var cyl = P.rows[0].index, start = measured(t.startMpa) ? Number(t.startMpa) : P.rows[0].startMpa;
    t.history.push({ cyl: cyl, startMpa: start, endMpa: Number(t.endMpa), addedL: P.addedL });
    log('追加充填', (cyl + 1) + '本目 一次圧 ' + mpa(start) + ' → ' + mpa(Number(t.endMpa)) + '（約 ' + litres(P.addedL) + '）');
    t.startMpa = ''; t.endMpa = ''; t.checks = {};
    state.run.lift.withKg = '';
    delete state.run.checks['F-2']; delete state.run.checks['F-3'];
    lastScrolledKey = null;
    selectTab('check'); refresh();
    toast('追加充填を記録しました。F-2 をもう一度測ってください');
}

// ---------- 記録 ----------
function renderLog() { el('fc_log').innerHTML = state.run.log.slice().reverse().map(function (item) { return '<li><time datetime="' + item.t + '">' + clock(item.t) + '</time>[' + escapeHtml(item.where || '') + '] ' + escapeHtml(item.text) + '</li>'; }).join(''); }
function logText() { return state.run.log.map(function (item) { return clock(item.t) + ' [' + (item.where || '') + '] ' + item.text; }).join('\n'); }
function downloadCsv() {
    var rows = [['time', 'where', 'event']].concat(state.run.log.map(function (item) { return [new Date(item.t).toLocaleString('ja-JP'), item.where || '', item.text]; }));
    var csv = '﻿' + rows.map(function (r) { return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n');
    var a = document.createElement('a'), d = new Date();
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'helium-fill-log-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function copyLog() {
    var text = logText();
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('記録をコピーしました'); }, function () { toast('コピーできませんでした。CSV を使ってください'); });
    else toast('このブラウザではコピーできません。CSV を使ってください');
}

// ---------- 読み上げ ----------
function speechOn() { return storageGet(STORAGE_KEY + '-speak') === '1'; }
function renderSpeakButton() { var b = el('fc_speak'); if (!b) return; var on = speechOn(); b.setAttribute('aria-pressed', String(on)); b.textContent = on ? '🔊 読み上げ中' : '🔈 読み上げ'; b.hidden = !('speechSynthesis' in root); }
function speakKey(key, text) {
    if (key === lastSpokenKey) return;
    lastSpokenKey = key;
    if (!speechOn() || !('speechSynthesis' in root)) return;
    try { root.speechSynthesis.cancel(); var u = new SpeechSynthesisUtterance(text); u.lang = 'ja-JP'; u.rate = 1.05; root.speechSynthesis.speak(u); } catch (e) { /* 読み上げできない環境 */ }
}
function toggleSpeech() {
    var on = !speechOn(); storageSet(STORAGE_KEY + '-speak', on ? '1' : '0'); renderSpeakButton();
    if (on) { lastSpokenKey = null; renderFocus(); toast('次の手順を読み上げます'); } else if ('speechSynthesis' in root) root.speechSynthesis.cancel();
}

// ---------- 全体 ----------
function refresh() { compute(); renderStatus(); renderChips(); renderSetup(); renderSetupSummary(); renderFocus(); renderTimeline(); renderPlan(); renderLift(); renderLiftInputs(); renderTopup(); renderLog(); save(); }
function resetRun() {
    if (!root.confirm('チェックと記録をすべて消して最初からやり直します（ボンベの容積・初期圧と機体条件は残ります）。よろしいですか？')) return;
    state.run = emptyRun(state.settings.cylinders.length); lastSpokenKey = null; lastScrolledKey = null;
    selectTab('gas'); refresh(); toast('最初からやり直します');
}
function importPredictor() {
    var p = predictorSettings();
    if (!p) { toast('予測ツールのガス計算設定が見つかりません（同じブラウザで一度ガス計算を開いてください）'); return; }
    applyPredictorSettings(state, p); renderSettings(); refresh(); toast('予測ツールの設定を読み込みました');
}
function selectTab(name) {
    document.querySelectorAll('.rail-btn[data-tab]').forEach(function (b) { var on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    ['check', 'gas', 'lift', 'log'].forEach(function (n) { el('fc_tab_' + n).hidden = n !== name; });
    document.querySelector('.stage').scrollTop = 0;
    storageSet(STORAGE_KEY + '-tab', name);
    if (name === 'check') { lastScrolledKey = null; later(renderTimeline); }
}
function onAction(e) {
    var b = e.target.closest('[data-action]'); if (!b || b.disabled) return;
    var a = b.dataset.action;
    if (a === 'start') startAt(startSel.key, false);
    else if (a === 'restart-here') { if (root.confirm('開始位置を変更します（チェック済みの記録は残ります）。よろしいですか？')) startAt(startSel.key, true); }
    else if (a === 'go-gas') selectTab('gas');
    else if (a === 'go-check') selectTab('check');
    else if (a === 'go-lift') selectTab('lift');
    else if (a === 'complete') completeKey(b.dataset.key);
    else if (a === 'undo') undoStep();
    else if (a === 'topup-record') recordTopup();
}
function keepAwake() { if (!navigator.wakeLock || document.visibilityState !== 'visible') return; navigator.wakeLock.request('screen').catch(function () {}); }
function registerOffline() {
    var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (secure && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
}
function init() {
    load();
    document.querySelectorAll('.rail-btn[data-tab]').forEach(function (b) { b.addEventListener('click', function () { selectTab(b.dataset.tab); }); });
    document.addEventListener('click', onAction);
    el('fc_setup').addEventListener('input', onSetupInput);
    el('fc_setup').addEventListener('change', onSetupInput);
    ['fc_focus', 'fc_steps'].forEach(function (id) { el(id).addEventListener('input', onTimelineInput); el(id).addEventListener('change', onTimelineInput); });
    el('fc_steps').addEventListener('click', onStepRowClick);
    el('fc_groupbar').addEventListener('click', onStepRowClick);
    el('fc_settings').addEventListener('input', onSettingsInput);
    el('fc_settings').addEventListener('change', onSettingsInput);
    el('fc_settings').addEventListener('submit', function (e) { e.preventDefault(); });
    el('fc_reset').addEventListener('click', resetRun);
    el('fc_import').addEventListener('click', importPredictor);
    el('fc_copy_log').addEventListener('click', copyLog);
    el('fc_download_log').addEventListener('click', downloadCsv);
    el('fc_speak').addEventListener('click', toggleSpeech);
    el('fc_lift').addEventListener('input', onLiftPanelInput);
    el('fc_lift').addEventListener('change', onLiftPanelInput);
    el('fc_lift_record').addEventListener('click', recordLift);
    document.addEventListener('visibilitychange', keepAwake);
    renderSettings(); renderSpeakButton(); compute();
    var savedTab = storageGet(STORAGE_KEY + '-tab');
    selectTab(!state.run.started ? 'gas' : (savedTab && el('fc_tab_' + savedTab) ? savedTab : 'check'));
    refresh(); keepAwake(); registerOffline();
}
root.FillChecklistUI = { init: init };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}(typeof globalThis !== 'undefined' ? globalThis : this));
