(function (root) {
'use strict';
var Core = root.FillChecklistCore, Gas = root.BalloonGas;
var STORAGE_KEY = 'fill-checklist-v1', PREDICTOR_KEY = 'gas-calculator-settings-v4';
var GAS_FIELDS = ['inputMode', 'balloonMassG', 'componentMassG', 'otherMassG', 'parachuteMassG', 'recoveryEquipmentMassG', 'verificationOtherMassG', 'targetAscentRate', 'temperatureC', 'pressureHpa', 'densityDifferenceKgM3', 'targetCylinderPressureMpa', 'firstCylinderOffsetMpa', 'cylinderTemperatureC', 'cylinderProcess', 'polytropicN'];
var TEXT_FIELDS = { inputMode: true, cylinderProcess: true };
var state, lastPlan = null, lastRequired = null, lastLift = null, lastTopup = null, lastSpokenKey = null;

// ---------- 小物 ----------
function el(id) { return document.getElementById(id); }
function fmt(v, d) { return Number(v).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function mpa(v) { return v == null || !Number.isFinite(Number(v)) ? '-' : fmt(v, 2) + ' MPa'; }
function litres(v) { return fmt(Math.round(v), 0) + ' L'; }
function kg(v) { return fmt(v, 2) + ' kg'; }
function rate(v) { return fmt(v, 1) + ' m/s'; }
function nowIso() { return new Date().toISOString(); }
function clock(iso) { return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function toast(msg) { var t = el('fc_toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.hidden = true; }, 2600); }
function measured(v) { return v !== '' && v != null && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= Core.MAX_PRESSURE_MPA; }
// 入力欄が入った部分を描き直すと、その欄の blur→change が描き直しの途中で起きる。描き直しは次の処理に回す。
function later(fn) { setTimeout(fn, 0); }
function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* 保存できなくても画面は動かす */ } }

// ---------- 状態 ----------
function emptyRunCylinder() { return { initialMpa: '', finalMpa: '', checks: {} }; }
function emptyLift() { return { holderKg: '', withKg: '', attachedG: '0', resolutionKg: '0.1' }; }
function emptyTopup() { return { startMpa: '', endMpa: '', checks: {}, history: [] }; }
function emptyRun(n) { var cyl = []; for (var i = 0; i < n; i += 1) cyl.push(emptyRunCylinder()); return { started: false, current: 0, finished: false, cyl: cyl, log: [], lift: emptyLift(), topup: emptyTopup() }; }
function defaultGas() { var d = Gas.DEFAULTS, g = {}; GAS_FIELDS.forEach(function (k) { g[k] = d[k]; }); return g; }
function defaultState() { return { settings: { requiredMode: 'calc', manualRequiredL: '', gas: defaultGas(), cylinders: [0, 1, 2, 3].map(function () { return { volumeL: 47, pressureMpa: 14 }; }) }, run: emptyRun(4) }; }
function resizeRun(s) { var n = s.settings.cylinders.length; while (s.run.cyl.length < n) s.run.cyl.push(emptyRunCylinder()); if (s.run.cyl.length > n) s.run.cyl.length = n; if (s.run.current > n - 1) s.run.current = n - 1; }

function predictorSettings() { try { return JSON.parse(storageGet(PREDICTOR_KEY) || 'null'); } catch (e) { return null; } }
function applyPredictorSettings(s, saved) {
    GAS_FIELDS.forEach(function (k) { if (saved[k] != null && saved[k] !== '') s.settings.gas[k] = saved[k]; });
    if (Array.isArray(saved.cylinders) && saved.cylinders.length) {
        s.settings.cylinders = saved.cylinders.slice(0, Core.MAX_CYLINDERS).map(function (c) { return { volumeL: c.volumeL, pressureMpa: c.pressureMpa }; });
        resizeRun(s);
    }
    s.settings.requiredMode = 'calc';
}
function load() {
    var saved = null;
    try { saved = JSON.parse(storageGet(STORAGE_KEY) || 'null'); } catch (e) { saved = null; }
    if (saved && saved.settings && saved.run) {
        saved.settings.gas = Object.assign(defaultGas(), saved.settings.gas || {});
        saved.run.lift = Object.assign(emptyLift(), saved.run.lift || {});
        saved.run.topup = Object.assign(emptyTopup(), saved.run.topup || {});
        if (saved.run.started == null) saved.run.started = saved.run.log.length > 0;
        state = saved;
        resizeRun(state);
        return;
    }
    state = defaultState();
    var p = predictorSettings();
    if (p) applyPredictorSettings(state, p);
}
function save() { storageSet(STORAGE_KEY, JSON.stringify(state)); }
function log(text) { state.run.log.push({ t: nowIso(), cyl: state.run.current + 1, text: text }); }

// ---------- 計算 ----------
function gasOptions() { var g = {}, src = state.settings.gas; GAS_FIELDS.forEach(function (k) { g[k] = TEXT_FIELDS[k] ? src[k] : Number(src[k]); }); return g; }
function cylindersForPlan() { return state.settings.cylinders.map(function (c, i) { var r = state.run.cyl[i] || {}; return { volumeL: Number(c.volumeL), pressureMpa: Number(c.pressureMpa), initialMpa: r.initialMpa, finalMpa: r.finalMpa }; }); }
function compute() {
    var errorBox = el('fc_error');
    try {
        var o = gasOptions();
        lastRequired = Core.requiredGas({ requiredMode: state.settings.requiredMode, manualRequiredL: state.settings.manualRequiredL, gas: o });
        lastPlan = Core.buildPlan(o, lastRequired.gasVolumeL, cylindersForPlan(), state.run.current);
        errorBox.hidden = true;
    } catch (err) {
        lastPlan = null; lastRequired = null;
        errorBox.textContent = err.message || String(err); errorBox.hidden = false;
    }
    try { lastLift = Core.liftCheck(gasOptions(), state.run.lift); } catch (e) { lastLift = { error: e.message || String(e) }; }
    computeTopup();
}
function currentDelivered() {
    var r = state.run.cyl[state.run.current], c = state.settings.cylinders[state.run.current];
    if (!r || !c || !measured(r.initialMpa) || !measured(r.finalMpa)) return 0;
    try { return Core.deliveredL(gasOptions(), Number(c.volumeL), state.run.current, Number(r.initialMpa), Number(r.finalMpa)); } catch (e) { return 0; }
}
function currentRow() { return lastPlan ? lastPlan.rows[state.run.current] : null; }

// ---------- 手順 ----------
function steps() { return Core.stepsFor(state.run.current); }
function checks() { return state.run.cyl[state.run.current].checks; }
function nextStep() { var c = checks(); return steps().find(function (s) { return !c[s.id]; }) || null; }
function pressureKey(step) { return step.input === 'initial' ? 'initialMpa' : 'finalMpa'; }
function stepReady(step) { return !step.input || measured(state.run.cyl[state.run.current][pressureKey(step)]); }
function setCheck(step, on) {
    var c = checks();
    if (on) { c[step.id] = nowIso(); log('✓ ' + step.text); }
    else { delete c[step.id]; log('✗ 取り消し: ' + step.text); }
}
function setPressure(key, value) {
    var r = state.run.cyl[state.run.current], loggedKey = 'logged_' + key;
    r[key] = value;
    if (!measured(value) || value === r[loggedKey]) return;
    r[loggedKey] = value;
    if (key === 'initialMpa') { log('開始一次圧 ' + mpa(Number(value)) + ' を入力'); return; }
    var row = currentRow();
    compute();
    log('終了一次圧 ' + mpa(Number(value)) + ' を入力' + (row && row.targetMpa != null ? '（目標 ' + mpa(row.targetMpa) + '）' : '') + ' → このボンベから約 ' + litres(currentDelivered()));
}

// ---------- 状態カード・チップ ----------
function renderStatus() {
    var box = el('fc_status'), i = state.run.current, n = state.settings.cylinders.length;
    var label = el('fc_status_target_label'), target = el('fc_status_target'), note = el('fc_status_target_note');
    box.classList.remove('is-warn', 'is-done');
    el('fc_status_cyl').textContent = !state.run.started ? '充填前' : (state.run.finished ? '充填終了' : (i + 1) + '本目');
    var next = nextStep();
    el('fc_status_next').textContent = !state.run.started ? '次: ① ボンベ情報を入力して「充填を始める」' : (state.run.finished ? topupNextText() : (next ? '次: ' + next.text : 'このボンベの手順はすべて完了'));
    if (!lastPlan) {
        el('fc_status_total').textContent = '用意 ' + n + '本';
        label.textContent = '目標一次圧'; target.textContent = '-';
        note.textContent = 'ボンベ情報・機体条件を確認してください';
        box.classList.add('is-warn'); renderProgress(0, 0, 0); return;
    }
    var used = lastPlan.rows.filter(function (r) { return r.state === 'done' || r.role === 'full' || r.role === 'partial'; }).length;
    el('fc_status_total').textContent = '使用予定 ' + used + '本 / 用意 ' + n + '本';
    var row = lastPlan.rows[i], nowDelivered = currentDelivered();
    if (state.run.finished) {
        var lift = lastLift && lastLift.measured ? lastLift : null;
        if (lift) { label.textContent = '想定上昇速度（体重計）'; target.textContent = lift.canFly ? rate(lift.ascentRate) : '上がらない'; note.textContent = '目標 ' + rate(lift.targetAscentRate) + ' ・ 充填量 約 ' + litres(lastPlan.filledL + nowDelivered); }
        else { label.textContent = '充填量'; target.textContent = litres(lastPlan.filledL + nowDelivered); note.textContent = '必要 ' + litres(lastPlan.requiredL) + ' ・ 次は「浮力」で測定'; }
        box.classList.add('is-done');
    } else if (row.role === 'full' || row.role === 'partial') {
        label.textContent = (i + 1) + '本目の目標一次圧（ここで出口を閉める）';
        target.textContent = mpa(row.targetMpa);
        note.textContent = (row.initialIsMeasured ? '実測 ' + mpa(row.startMpa) : '予定 ' + mpa(row.startMpa) + '（実測を入れると更新）') + ' → 約 ' + litres(row.useL) + (row.role === 'partial' ? '（途中まで）' : '');
    } else if (row.role === 'unused') {
        label.textContent = 'このボンベは'; target.textContent = '不要'; note.textContent = '必要量に到達しています'; box.classList.add('is-done');
    } else {
        label.textContent = '目標一次圧'; target.textContent = '-'; note.textContent = 'このボンベの容積・初期圧を確認してください'; box.classList.add('is-warn');
    }
    if (lastPlan.insufficient && !state.run.finished) { box.classList.add('is-warn'); note.textContent += ' ／ 全ボンベを使っても約 ' + litres(lastPlan.shortfallL) + ' 不足'; }
    var nowL = row && !state.run.finished ? (nowDelivered > 0 ? nowDelivered : row.useL) : 0;
    renderProgress(lastPlan.filledL + (state.run.finished ? nowDelivered : 0), state.run.finished ? 0 : nowL, lastPlan.requiredL, nowDelivered > 0);
}
function renderProgress(done, now, required, nowIsMeasured) {
    var pct = function (v) { return required > 0 ? Math.max(0, Math.min(100, v / required * 100)) : 0; };
    var donePct = pct(done), nowPct = Math.min(pct(now), 100 - donePct);
    el('fc_progress_done').style.width = donePct + '%'; el('fc_progress_now').style.width = nowPct + '%';
    var text = required > 0 ? '充填済み ' + litres(done) + ' / 必要 ' + litres(required) + '（残り ' + litres(Math.max(0, required - done)) + '）' : '';
    if (now > 0) text += ' ・ このボンベ' + (nowIsMeasured ? 'で' : 'の予定') + ' ' + litres(now);
    el('fc_progress_text').textContent = text;
    el('fc_progress_label').setAttribute('aria-label', text);
}
function renderChips() {
    var box = el('fc_status');
    var chips = [[el('fc_status_cyl').textContent, 'on'], [el('fc_status_target_label').textContent.replace(/（.*）/, '').replace(/^\d+本目の/, '') + ' ' + el('fc_status_target').textContent, box.classList.contains('is-warn') ? 'error' : (box.classList.contains('is-done') ? 'ok' : '')]];
    if (lastPlan) chips.push(['残り ' + litres(Math.max(0, lastPlan.remainingL - currentDelivered())), '']);
    el('fc_chips').innerHTML = chips.map(function (c) { return '<span class="chip ' + c[1] + '">' + escapeHtml(c[0]) + '</span>'; }).join('');
}

// ---------- ① ボンベ情報（充填前に入力・途中でも変更可） ----------
function cylinderRowsHtml() {
    return state.settings.cylinders.map(function (c, i) {
        var started = state.run.started && i < state.run.current;
        return '<div class="cyl-grid' + (started ? ' is-used' : '') + '"><strong>' + (i + 1) + '</strong>' +
            '<input type="number" min="0.1" step="0.1" inputmode="decimal" data-cyl="' + i + '" data-field="volumeL" value="' + escapeHtml(c.volumeL) + '" aria-label="' + (i + 1) + '本目の容積 (L)">' +
            '<input type="number" min="0" max="15" step="0.1" inputmode="decimal" data-cyl="' + i + '" data-field="pressureMpa" value="' + escapeHtml(c.pressureMpa) + '" aria-label="' + (i + 1) + '本目の初期圧 (MPa)"></div>';
    }).join('');
}
function countOptionsHtml() {
    var html = '';
    for (var i = 1; i <= Core.MAX_CYLINDERS; i += 1) html += '<option value="' + i + '"' + (i === state.settings.cylinders.length ? ' selected' : '') + '>' + i + ' 本</option>';
    return html;
}
function setupPreviewHtml() {
    if (!lastPlan) return '<p class="note error">' + escapeHtml(el('fc_error').textContent || '入力を確認してください') + '</p>';
    var g = state.settings.gas, about = lastRequired.source === 'manual' ? '直接入力' : '気球 ' + g.balloonMassG + ' g・上昇速度 ' + g.targetAscentRate + ' m/s';
    var rows = lastPlan.rows.filter(function (r) { return r.state !== 'done' && (r.role === 'full' || r.role === 'partial'); });
    var plan = rows.map(function (r) { return '<li><b>' + (r.index + 1) + '本目</b> ' + mpa(r.targetMpa) + ' まで（約 ' + litres(r.useL) + '）</li>'; }).join('');
    return '<p class="setup-need">必要ガス量 <b>' + litres(lastPlan.requiredL) + '</b><span class="note">（' + escapeHtml(about) + '）</span></p>' +
        (plan ? '<ul class="setup-plan">' + plan + '</ul>' : '') +
        (lastPlan.insufficient ? '<p class="note error">全ボンベを使っても約 ' + litres(lastPlan.shortfallL) + ' 不足します。本数を増やしてください。</p>' : '');
}
function renderSetup() {
    var box = el('fc_setup');
    box.className = 'card setup-card';
    box.innerHTML = '<h3>' + (state.run.started ? 'ボンベ情報（充填中も変更できます）' : 'まずボンベ情報を入力') + '</h3>' +
        (state.run.started ? '<p class="note">使用済みのボンベは実測した一次圧で計算されるので、ここでの変更はこれから使うボンベに効きます。実測した初期圧は ② の入力が優先です。</p>' : '<p class="note">ボンベのラベルと圧力計で、容積と初期圧（一次圧）を確認して入力します。入力すると必要ガス量とボンベごとの目標一次圧が出ます。</p>') +
        '<label class="field"><span>本数</span><select data-setup="count">' + countOptionsHtml() + '</select></label>' +
        '<div class="cyl-grid cyl-head"><span>本</span><span>容積 (L)</span><span>初期圧 (MPa)</span></div>' +
        '<div class="setup-cyls">' + cylinderRowsHtml() + '</div>' +
        '<div id="fc_setup_preview" class="setup-preview">' + setupPreviewHtml() + '</div>' +
        '<div class="setup-actions">' +
        (state.run.started ? '<button type="button" class="btn btn-primary btn-big" data-action="go-check">② チェックに戻る ▶</button>' : '<button type="button" class="btn btn-primary btn-big" data-action="start">この内容で充填を始める ▶</button>') +
        '</div>';
}
function renderSetupSummary() {
    var box = el('fc_setup_summary');
    if (!state.run.started) {
        box.className = 'card locked-card';
        box.innerHTML = '<p>先に <b>① ボンベ情報</b> を入力して「この内容で充填を始める」を押してください。</p>' +
            '<button type="button" class="btn btn-primary btn-big" data-action="go-gas">① ボンベ情報へ</button>';
        return;
    }
    var cyls = state.settings.cylinders.map(function (c) { return fmt(Number(c.volumeL), 0) + 'L/' + fmt(Number(c.pressureMpa), 1); }).join('・');
    box.className = 'setup-summary';
    box.innerHTML = '<span>ボンベ ' + state.settings.cylinders.length + '本（' + escapeHtml(cyls) + ' MPa）' + (lastPlan ? ' ・ 必要 ' + litres(lastPlan.requiredL) : '') + '</span>' +
        '<button type="button" class="btn btn-small" data-action="go-gas">ボンベ情報を変更</button>';
}
function onSetupInput(e) {
    var t = e.target, s = state.settings;
    if (t.dataset.cyl != null) s.cylinders[Number(t.dataset.cyl)][t.dataset.field] = t.value;
    else if (t.dataset.setup === 'count') { if (e.type === 'change') { setCylinderCount(Number(t.value)); later(refresh); } return; }
    else return;
    compute(); renderStatus(); renderChips(); renderPlan(); renderFocus(); renderSetupSummary();
    var preview = el('fc_setup_preview'); if (preview) preview.innerHTML = setupPreviewHtml();
    if (e.type === 'change') { later(renderSettings); log('ボンベ情報を変更: ' + (Number(t.dataset.cyl) + 1) + '本目 ' + (t.dataset.field === 'volumeL' ? '容積 ' + t.value + ' L' : '初期圧 ' + t.value + ' MPa')); renderLog(); }
    save();
}
function setCylinderCount(n) {
    var s = state.settings;
    while (s.cylinders.length < n) { var last = s.cylinders[s.cylinders.length - 1] || { volumeL: 47, pressureMpa: 14 }; s.cylinders.push({ volumeL: last.volumeL, pressureMpa: last.pressureMpa }); }
    s.cylinders.length = n;
    resizeRun(state);
    renderSettings();
    renderSetup();
}
function startFilling() {
    if (!lastPlan) { toast('ボンベ情報・機体条件を確認してください'); return; }
    state.run.started = true;
    log('充填開始（ボンベ ' + state.settings.cylinders.length + '本・必要 ' + litres(lastPlan.requiredL) + '）');
    refresh();
    selectTab('check');
}

// ---------- ② いまの手順（1つずつ大きく） ----------
function renderFocus() {
    var box = el('fc_focus'), list = el('fc_list'), actions = el('fc_check_actions');
    var visible = state.run.started;
    box.hidden = !visible; list.hidden = !visible; actions.hidden = !visible;
    if (!visible) return;
    var row = currentRow(), next = nextStep(), all = steps(), doneCount = all.length - all.filter(function (s) { return !checks()[s.id]; }).length;
    var head = '<div class="focus-head"><span>' + (state.run.current + 1) + '本目 ・ ' + doneCount + ' / ' + all.length + '</span>' +
        '<button type="button" class="btn btn-small" data-action="undo"' + (doneCount ? '' : ' disabled') + '>↶ 1つ戻す</button></div>';
    if (state.run.finished) {
        box.innerHTML = head + '<p class="focus-section">充填終了</p><p class="focus-text">「③ 浮力」で体重計による浮力測定をします。</p>' +
            '<div class="focus-actions"><button type="button" class="btn btn-primary btn-huge" data-action="go-lift">⚖ 浮力測定へ</button></div>';
        speakKey('finished', '充填終了。浮力測定をしてください。');
        return;
    }
    if (!next) {
        var last = state.run.current >= state.settings.cylinders.length - 1, enough = lastPlan && lastPlan.remainingL - currentDelivered() <= 1;
        box.innerHTML = head + '<p class="focus-section">このボンベの手順はすべて完了</p>' +
            '<p class="focus-text">' + (enough ? '必要量に達しました。充填を終了して浮力を測ります。' : '次のボンベをつなぎます。') + '</p>' +
            '<div class="focus-actions">' +
            (enough ? '<button type="button" class="btn btn-primary btn-huge" data-action="finish">充填を終了 → 浮力測定</button><button type="button" class="btn btn-big" data-action="next">' + (last ? '＋ボンベを追加して続ける' : '次のボンベへ（' + (state.run.current + 2) + '本目）') + '</button>'
                : '<button type="button" class="btn btn-primary btn-huge" data-action="next">' + (last ? '＋ボンベを追加して次へ' : '▶ 次のボンベへ（' + (state.run.current + 2) + '本目）') + '</button><button type="button" class="btn btn-big" data-action="finish">ここで充填を終了</button>') +
            '</div>';
        speakKey('done-' + state.run.current, 'このボンベの手順はすべて完了しました。');
        return;
    }
    var extra = '';
    if (next.input) {
        var key = pressureKey(next), val = state.run.cyl[state.run.current][key];
        extra += '<label class="focus-input"><span>' + (key === 'initialMpa' ? '開始時の一次圧' : '出口を閉めた時の一次圧') + '</span>' +
            '<input type="number" step="0.01" min="0" max="15" inputmode="decimal" data-pressure="' + key + '" value="' + escapeHtml(val) + '"><span>MPa</span></label>';
        if (key === 'finalMpa' && row && row.targetMpa != null) extra += '<p class="focus-target">目標 ' + mpa(row.targetMpa) + '</p>';
    }
    if (next.target && row) extra += row.targetMpa != null ? '<p class="focus-target">一次圧 <b>' + mpa(row.targetMpa) + '</b> まで</p>' : '<p class="focus-target">このボンベは不要（必要量に到達）</p>';
    box.innerHTML = head + '<p class="focus-section">' + escapeHtml(Core.SECTIONS[next.section]) + '</p>' +
        '<p class="focus-text">' + escapeHtml(next.text) + '</p>' + extra +
        '<div class="focus-actions"><button type="button" class="btn btn-primary btn-huge" data-action="complete" data-step="' + next.id + '"' + (stepReady(next) ? '' : ' disabled') + '>✓ 完了</button></div>';
    var spoken = next.text + (next.target && row && row.targetMpa != null ? '。目標は' + fmt(row.targetMpa, 2) + 'メガパスカル' : '');
    speakKey(state.run.current + '-' + next.id, spoken);
}
function completeStep(id) {
    var step = Core.STEPS.find(function (s) { return s.id === id; });
    if (!step) return;
    if (!stepReady(step)) { toast('一次圧を入力してください'); var i = el('fc_focus').querySelector('input'); if (i) i.focus(); return; }
    setCheck(step, true);
    refresh();
}
function undoStep() {
    var c = checks(), lastId = null;
    Object.keys(c).forEach(function (id) { if (!lastId || c[id] > c[lastId]) lastId = id; });
    if (!lastId) return;
    setCheck(Core.STEPS.find(function (s) { return s.id === lastId; }), false);
    refresh();
}

// ---------- ③ 全手順の一覧 ----------
function renderSteps() {
    var wrap = el('fc_steps'), c = checks(), r = state.run.cyl[state.run.current], next = nextStep(), row = currentRow(), html = '', section = null;
    steps().forEach(function (s) {
        if (s.section !== section) { if (section) html += '</div>'; section = s.section; html += '<div class="fc-section"><h3>' + escapeHtml(Core.SECTIONS[s.section]) + '</h3>'; }
        var done = !!c[s.id], cls = 'fc-step' + (done ? ' is-done' : '') + (next && next.id === s.id ? ' is-next' : ''), extra = '', disabled = '';
        if (s.input) {
            var key = pressureKey(s), val = r[key];
            if (!measured(val)) disabled = ' disabled';
            extra += '<span class="fc-step-input"><input type="number" step="0.01" min="0" max="15" inputmode="decimal" data-pressure="' + key + '" value="' + escapeHtml(val) + '" aria-label="' + (key === 'initialMpa' ? '開始時の一次圧' : '終了時の一次圧') + ' (MPa)"> MPa</span>';
            if (key === 'finalMpa' && row && row.targetMpa != null) extra += '<span class="fc-step-meta">目標 ' + mpa(row.targetMpa) + '</span>';
        }
        if (s.target && row) extra += row.targetMpa != null ? '<span class="fc-step-target">' + mpa(row.targetMpa) + ' まで</span>' : '<span class="fc-step-meta">このボンベは不要（必要量に到達）</span>';
        if (done) extra += '<span class="fc-step-meta">' + clock(c[s.id]) + ' 確認</span>';
        html += '<div class="' + cls + '" data-row="' + s.id + '"><input type="checkbox" id="step_' + s.id + '" data-step="' + s.id + '"' + (done ? ' checked' : '') + disabled + '><div class="fc-step-body"><label class="fc-step-text" for="step_' + s.id + '">' + escapeHtml(s.text) + '</label>' + extra + '</div></div>';
    });
    if (section) html += '</div>';
    wrap.innerHTML = html;
    el('fc_prev_cyl').disabled = state.run.current === 0 || state.run.finished;
    el('fc_next_cyl').disabled = state.run.finished;
    el('fc_next_cyl').textContent = state.run.current >= state.settings.cylinders.length - 1 ? '＋ボンベを追加して次へ' : '▶ 次のボンベへ（' + (state.run.current + 2) + '本目）';
    el('fc_finish').textContent = state.run.finished ? '充填を再開' : '充填を終了';
}

// ---------- ボンベ計画表・設定フォーム ----------
function renderPlan() {
    var body = el('fc_plan_body'), sum = el('fc_summary');
    if (!lastPlan) { body.innerHTML = ''; sum.innerHTML = ''; return; }
    var p2 = function (v) { return v == null || !Number.isFinite(Number(v)) ? '-' : fmt(v, 2); };
    body.innerHTML = lastPlan.rows.map(function (row) {
        var cls = row.state === 'done' ? 'is-done' : (row.state === 'current' && state.run.started ? 'is-current' : ''), r = state.run.cyl[row.index];
        var initial = row.state === 'done' ? p2(row.initialMpa) : (row.startMpa == null ? '-' : p2(row.startMpa) + (row.initialIsMeasured ? '' : ' <span class="is-planned">予定</span>'));
        var target = row.state === 'done' ? '-' : (row.targetMpa != null ? p2(row.targetMpa) : (row.role === 'unused' ? '不要' : '-'));
        var final = measured(r.finalMpa) ? p2(Number(r.finalMpa)) : '-';
        var use = row.state === 'done' ? litres(row.deliveredL) : (row.useL > 0 ? litres(row.useL) + ' <span class="is-planned">予定</span>' : '-');
        return '<tr class="' + cls + '"><td>' + (row.index + 1) + '</td><td>' + initial + '</td><td>' + target + '</td><td>' + final + '</td><td>' + use + '</td></tr>';
    }).join('');
    var items = [['必要ガス量', litres(lastPlan.requiredL) + (lastRequired.source === 'manual' ? '（直接入力）' : '')]];
    if (lastRequired.source === 'calc') items.push(['総重量', fmt(lastRequired.totalMassKg, 3) + ' kg'], ['純浮力', fmt(lastRequired.pureLiftKg, 3) + ' kg'], ['全浮力（計量目安）', fmt(lastRequired.totalLiftKg, 3) + ' kg']);
    items.push(['充填済み（完了ボンベ）', litres(lastPlan.filledL)], ['残り必要量', litres(lastPlan.remainingL)], ['計算過程', 'n = ' + fmt(lastPlan.exponentN, 2)]);
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
    compute(); renderStatus(); renderChips(); renderPlan(); renderFocus(); renderLift();
    renderTopup();
    if (e.type === 'change') later(function () { renderSetup(); renderSetupSummary(); });
    save();
}

// ---------- 浮力測定 ----------
function liftResolution() { return Number(state.run.lift.resolutionKg) > 0 ? Number(state.run.lift.resolutionKg) : 0.1; }
function renderLift() {
    var L = lastLift || {}, res = el('fc_lift_result'), tgt = el('fc_lift_target');
    if (L.error) { tgt.textContent = ''; res.innerHTML = '<p class="fc-error">' + escapeHtml(L.error) + '（「① ボンベ」の機体条件を確認）</p>'; el('fc_lift_record').disabled = true; return; }
    tgt.innerHTML = '目標: ②が①より <strong>' + kg(L.targetPullKg) + '</strong> 軽くなれば上昇速度 ' + rate(L.targetAscentRate) + '（総重量 ' + kg(L.totalMassKg) + '・気球 ' + kg(L.balloonKg) + '）';
    el('fc_lift_record').disabled = !L.measured;
    if (!L.measured) { res.innerHTML = ''; return; }
    var warn = !L.canFly || Math.abs(L.ascentRate - L.targetAscentRate) > 0.5;
    var html = '<div class="fc-lift-rate' + (warn ? ' is-warn' : '') + '"><span>想定上昇速度</span><strong>' + (L.canFly ? rate(L.ascentRate) : '上がらない') + '</strong></div>';
    html += '<dl class="fc-summary">' + [
        ['体重計の差（①−②）', kg(L.pullKg)],
        ['全浮力（差＋気球＋付属物）', kg(L.grossLiftKg)],
        ['純浮力（全浮力−総重量）', kg(L.pureLiftKg)],
        ['目盛り ±' + fmt(liftResolution(), 2) + ' kg の幅', L.canFly ? rate(Math.max(0, L.rateLow)) + ' 〜 ' + rate(L.rateHigh) : '-']
    ].map(function (it) { return '<dt>' + it[0] + '</dt><dd>' + it[1] + '</dd>'; }).join('') + '</dl>';
    var advice, cls;
    if (Math.abs(L.deltaPullKg) <= liftResolution()) { advice = '目標どおりです（差は目盛り以内）'; cls = 'is-ok'; }
    else if (L.deltaPullKg > 0) { advice = '浮力不足: あと約 ' + kg(L.deltaPullKg) + '（ヘリウム約 ' + litres(L.gasAdjustL) + '）足すと目標の上昇速度'; cls = 'is-warn'; }
    else { advice = '浮力過多: 目標より約 ' + kg(-L.deltaPullKg) + '（ヘリウム約 ' + litres(-L.gasAdjustL) + '）多い'; cls = 'is-warn'; }
    res.innerHTML = html + '<p class="fc-lift-advice ' + cls + '">' + advice + '</p>';
}
function onLiftInput(e) {
    var t = e.target;
    if (t.dataset.lift) { state.run.lift[t.dataset.lift] = t.value; compute(); renderLift(); renderTopup(); renderStatus(); renderChips(); save(); return; }
    if (t.dataset.topupPressure) {
        state.run.topup[t.dataset.topupPressure] = t.value;
        computeTopup(); renderStatus(); renderChips(); save();
        if (e.type === 'change') later(renderTopup); else updateTopupLive();
        return;
    }
    if (t.dataset.topupStep && e.type === 'change') {
        var c = state.run.topup.checks, step = TOPUP_STEPS.find(function (x) { return x.id === t.dataset.topupStep; });
        if (t.checked) { c[step.id] = nowIso(); log('追加充填 ✓ ' + step.label); } else { delete c[step.id]; log('追加充填 ✗ 取り消し: ' + step.label); }
        save(); later(function () { renderTopup(); renderLog(); });
    }
}

// ---------- 追加充填（浮力測定のあと、目標の上昇速度に近づける） ----------
var TOPUP_STEPS = [
    { id: 't1', label: 'バルーンにホースを締結', text: 'バルーンの口をほどき、ホースの先端を上に向けたまま、タイラップでバルーンに締結する' },
    { id: 't2', label: 'レギュレータ取り付け', text: '{cyl}のボンベにレギュレータを取り付ける（元栓が閉まっている・ネジ山の清掃・パッキンあり・各バルブが閉まっている、を確認）' },
    { id: 't3', label: '開栓・一次圧入力', text: '開栓許可を得て周りに知らせ、元栓を1秒に5°ほどで開ける。一次圧の針が止まったら入力する', input: 'startMpa' },
    { id: 't4', label: '二次圧調整', text: '圧力調整ハンドルで二次圧を 0.5 MPa に調整する（MAX 0.8 MPa）' },
    { id: 't5', label: '追加充填', text: '充填許可を得て、出口バルブをゆっくり開ける。一次圧が目標まで下がったら出口バルブを閉め、直後の一次圧を入力する', input: 'endMpa', target: true },
    { id: 't6', label: '脱圧・取り外し', text: '元栓を閉め、出口バルブを開けて一次圧・二次圧がどちらも 0 になったら閉める。圧力調整ハンドルを緩めてレギュレータを外す' },
    { id: 't7', label: '口を縛る', text: 'バルーンの口を縛り、ホースを外す' },
    { id: 't8', label: '再測定', text: 'もう一度体重計で浮力を測る（上の ② 気球を持った状態の体重を入れ直す）' }
];
function cylinderPressureNow(i) {
    var hist = state.run.topup.history.filter(function (h) { return h.cyl === i; });
    if (hist.length) return Number(hist[hist.length - 1].endMpa);
    var r = state.run.cyl[i] || {};
    if (measured(r.finalMpa)) return Number(r.finalMpa);
    if (measured(r.initialMpa)) return Number(r.initialMpa);
    return Number(state.settings.cylinders[i].pressureMpa);
}
function topupCandidates() {
    var n = state.settings.cylinders.length, cur = state.run.current, order = [cur], i;
    for (i = cur + 1; i < n; i += 1) order.push(i);
    for (i = cur - 1; i >= 0; i -= 1) order.push(i);
    return order.map(function (k) { return { index: k, volumeL: Number(state.settings.cylinders[k].volumeL), pressureMpa: cylinderPressureNow(k) }; });
}
function computeTopup() {
    lastTopup = null;
    var L = lastLift;
    if (!L || !L.measured || L.error || !(L.deltaPullKg > liftResolution())) return null;
    try {
        var o = gasOptions(), cands = topupCandidates(), plan = Core.topupPlan(o, L.gasAdjustL, cands);
        var t = state.run.topup;
        if (plan.rows.length && measured(t.startMpa)) {
            // 実際に開栓して読んだ一次圧で目標を出し直す
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
function topupNextText() {
    var L = lastLift;
    if (!L || !L.measured) return '次: ③ 浮力を測る';
    if (lastTopup && lastTopup.rows && lastTopup.rows.length) { var r = lastTopup.rows[0]; return '次: 追加充填 約 ' + litres(L.gasAdjustL) + '（' + (r.index + 1) + '本目を ' + mpa(r.targetMpa) + ' まで）'; }
    if (L.deltaPullKg < -liftResolution()) return '浮力が目標より多い（③ を参照）';
    return '目標どおり。放球準備へ';
}
function updateTopupLive() {
    var done = el('fc_topup_added'), t = state.run.topup;
    if (done) done.textContent = lastTopup && lastTopup.addedL > 0 ? '→ 入った量 約 ' + litres(lastTopup.addedL) : '';
    document.querySelectorAll('#fc_topup [data-topup-step]').forEach(function (b) {
        var step = TOPUP_STEPS.find(function (x) { return x.id === b.dataset.topupStep; });
        if (step.input && !b.checked) b.disabled = !measured(t[step.input]);
    });
    var target = el('fc_topup_target');
    if (target && lastTopup && lastTopup.rows.length) target.textContent = mpa(lastTopup.rows[0].targetMpa);
    var rec = document.querySelector('#fc_topup [data-action="topup-record"]');
    if (rec) rec.disabled = !measured(t.endMpa);
}
function renderTopup() {
    var box = el('fc_topup'), L = lastLift, t = state.run.topup;
    computeTopup();
    var history = t.history.length ? '<p class="note">これまでの追加充填: ' + t.history.map(function (h) { return (h.cyl + 1) + '本目 ' + fmt(h.startMpa, 2) + '→' + fmt(h.endMpa, 2) + ' MPa（約 ' + litres(h.addedL) + '）'; }).join('、') + '</p>' : '';
    if (!L || !L.measured || L.error) { box.innerHTML = history; return; }
    if (Math.abs(L.deltaPullKg) <= liftResolution()) {
        box.innerHTML = '<div class="card topup-card is-ok"><h3>追加充填</h3><p>目標の上昇速度 ' + rate(L.targetAscentRate) + ' になっています（差は体重計の目盛り以内）。追加充填は不要です。</p>' + history + '</div>';
        return;
    }
    if (L.deltaPullKg < 0) {
        box.innerHTML = '<div class="card topup-card"><h3>浮力が目標より多い</h3>' +
            '<p>目標より約 <b>' + kg(-L.deltaPullKg) + '</b>（ヘリウム約 ' + litres(-L.gasAdjustL) + '）多く、このままだと想定上昇速度は <b>' + (L.canFly ? rate(L.ascentRate) : '-') + '</b>（目標 ' + rate(L.targetAscentRate) + '）です。</p>' +
            '<ol class="topup-steps plain"><li>このまま放球してよいか判断する（上昇が速いと破裂高度・飛行時間が変わります）。</li>' +
            '<li>下げる場合は、バルーンの口をほどき、口を少しだけ開けてガスを少しずつ抜く。</li>' +
            '<li>口を縛り、もう一度浮力を測る（上の ② を入れ直す）。目標との差が目盛り以内になるまで繰り返す。</li></ol>' + history + '</div>';
        return;
    }
    var P = lastTopup;
    if (!P || P.error) { box.innerHTML = '<p class="fc-error">' + escapeHtml(P && P.error || '追加充填を計算できません') + '</p>'; return; }
    var first = P.rows[0];
    var head = '<div class="card topup-card"><h3>目標の上昇速度 ' + rate(L.targetAscentRate) + ' にするための追加充填</h3>' +
        '<p class="topup-need">あと約 <b>' + kg(L.deltaPullKg) + '</b> の浮力 ＝ ヘリウム約 <b>' + litres(L.gasAdjustL) + '</b></p>';
    if (!first) { box.innerHTML = head + '<p class="fc-error">一次圧が終了目標（' + mpa(Number(state.settings.gas.targetCylinderPressureMpa)) + '）より高いボンベが残っていません。① でボンベを追加してください。</p>' + history + '</div>'; return; }
    var plan = '<ul class="topup-plan">' + P.rows.map(function (r, k) { return '<li><b>' + (r.index + 1) + '本目</b>：一次圧 ' + mpa(r.startMpa) + (k === 0 && measured(t.startMpa) ? '（実測）' : '（今の値）') + ' → <b>' + (k === 0 ? '<span id="fc_topup_target">' + mpa(r.targetMpa) + '</span>' : mpa(r.targetMpa)) + '</b> まで（約 ' + litres(r.useL) + '）</li>'; }).join('') + '</ul>';
    var notes = '';
    if (P.insufficient) notes += '<p class="fc-error">残りのボンベをすべて使っても約 ' + litres(P.shortfallL) + ' 足りません。</p>';
    if (P.rows.length > 1) notes += '<p class="note">1本では足りません。' + (first.index + 1) + '本目を目標まで使ったら、同じ手順で ' + (P.rows[1].index + 1) + '本目を ' + mpa(P.rows[1].targetMpa) + ' まで入れます。</p>';
    if (first.dropMpa < 0.5) notes += '<p class="note warn">一次圧の変化が約 ' + fmt(first.dropMpa, 2) + ' MPa と小さく、圧力計では読みにくい量です。出口バルブを少しだけ開けて短時間ずつ入れ、口を縛って浮力を測り直すのを繰り返すと確実です。</p>';
    var c = t.checks, next = TOPUP_STEPS.find(function (st) { return !c[st.id]; });
    var steps = '<ol class="topup-steps">' + TOPUP_STEPS.map(function (st) {
        var done = !!c[st.id], dis = st.input && !measured(t[st.input]) && !done ? ' disabled' : '';
        var text = escapeHtml(st.text.replace('{cyl}', (first.index + 1) + '本目'));
        var extra = '';
        if (st.target) extra += '<span class="topup-target">目標 一次圧 <b>' + mpa(first.targetMpa) + '</b></span>';
        if (st.input) extra += '<span class="fc-step-input"><input type="number" step="0.01" min="0" max="15" inputmode="decimal" data-topup-pressure="' + st.input + '" value="' + escapeHtml(t[st.input]) + '" aria-label="' + (st.input === 'startMpa' ? '追加充填の開始一次圧' : '追加充填の終了一次圧') + ' (MPa)"> MPa' + (st.input === 'endMpa' ? ' <span id="fc_topup_added" class="topup-added">' + (P.addedL > 0 ? '→ 入った量 約 ' + litres(P.addedL) : '') + '</span>' : '') + '</span>';
        if (done) extra += '<span class="fc-step-meta">' + clock(c[st.id]) + ' 確認</span>';
        return '<li class="fc-step' + (done ? ' is-done' : '') + (next && next.id === st.id ? ' is-next' : '') + '"><input type="checkbox" id="topup_' + st.id + '" data-topup-step="' + st.id + '"' + (done ? ' checked' : '') + dis + '><div class="fc-step-body"><label class="fc-step-text" for="topup_' + st.id + '">' + text + '</label>' + extra + '</div></li>';
    }).join('') + '</ol>';
    box.innerHTML = head + plan + notes + '<h3>追加充填の手順</h3>' + steps +
        '<div class="setup-actions"><button type="button" class="btn btn-primary btn-big" data-action="topup-record"' + (measured(t.endMpa) ? '' : ' disabled') + '>追加充填を記録して再測定へ</button></div>' + history + '</div>';
}
function recordTopup() {
    var t = state.run.topup, P = lastTopup;
    if (!P || !P.rows.length || !measured(t.endMpa)) return;
    var cyl = P.rows[0].index, start = measured(t.startMpa) ? Number(t.startMpa) : P.rows[0].startMpa;
    t.history.push({ cyl: cyl, startMpa: start, endMpa: Number(t.endMpa), addedL: P.addedL });
    log('追加充填: ' + (cyl + 1) + '本目 一次圧 ' + mpa(start) + ' → ' + mpa(Number(t.endMpa)) + '（約 ' + litres(P.addedL) + '）');
    t.startMpa = ''; t.endMpa = ''; t.checks = {};
    state.run.lift.withKg = '';
    renderLiftInputs(); refresh();
    var input = document.querySelector('[data-lift="withKg"]');
    if (input) { input.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    toast('追加充填を記録しました。② 気球を持った状態の体重を測り直してください');
}
function recordLift() {
    var L = lastLift; if (!L || !L.measured) return;
    var l = state.run.lift;
    log('浮力測定: 保持者 ' + kg(Number(l.holderKg)) + ' / 気球込み ' + kg(Number(l.withKg)) + '（付属物 ' + (Number(l.attachedG) || 0) + ' g）→ 差 ' + kg(L.pullKg) + '・純浮力 ' + kg(L.pureLiftKg) + '・想定上昇速度 ' + (L.canFly ? rate(L.ascentRate) : '上がらない') + '（目標 ' + rate(L.targetAscentRate) + '）');
    refresh(); toast('浮力測定を記録しました');
}
function renderLiftInputs() { document.querySelectorAll('[data-lift]').forEach(function (i) { i.value = state.run.lift[i.dataset.lift]; }); }

// ---------- 記録 ----------
function renderLog() { el('fc_log').innerHTML = state.run.log.slice().reverse().map(function (item) { return '<li><time datetime="' + item.t + '">' + clock(item.t) + '</time>[' + item.cyl + '本目] ' + escapeHtml(item.text) + '</li>'; }).join(''); }
function logText() { return state.run.log.map(function (item) { return clock(item.t) + ' [' + item.cyl + '本目] ' + item.text; }).join('\n'); }
function downloadCsv() {
    var rows = [['time', 'cylinder', 'event']].concat(state.run.log.map(function (item) { return [new Date(item.t).toLocaleString('ja-JP'), item.cyl, item.text]; }));
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

// ---------- 読み上げ（両手がふさがっているとき用） ----------
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

// ---------- 操作 ----------
function refresh() { compute(); renderStatus(); renderChips(); renderSetup(); renderSetupSummary(); renderFocus(); renderSteps(); renderPlan(); renderLift(); renderTopup(); renderLog(); save(); }
function onStepsChange(e) {
    var t = e.target;
    if (t.dataset.step) { setCheck(Core.STEPS.find(function (x) { return x.id === t.dataset.step; }), t.checked); later(refresh); return; }
    if (t.dataset.pressure) { setPressure(t.dataset.pressure, t.value); later(refresh); }
}
function onPressureTyping(e) {
    var t = e.target; if (!t.dataset.pressure) return;
    state.run.cyl[state.run.current][t.dataset.pressure] = t.value;
    var row = t.closest('.fc-step'), box = row && row.querySelector('input[type="checkbox"]');
    if (box && !box.checked) box.disabled = !measured(t.value);
    var done = el('fc_focus').querySelector('[data-action="complete"]');
    if (done && t.closest('#fc_focus')) done.disabled = !measured(t.value);
    compute(); renderStatus(); renderChips(); renderPlan(); save();
}
function onStepRowClick(e) {
    // 行のどこを押してもチェックできる（数値欄・チェックボックス自身は除く）
    var row = e.target.closest('.fc-step');
    if (!row || e.target.closest('input, label')) return;
    var box = row.querySelector('input[type="checkbox"]');
    if (box && !box.disabled) box.click();
}
function addCylinder() {
    var s = state.settings;
    if (s.cylinders.length >= Core.MAX_CYLINDERS) { toast('ボンベは最大 ' + Core.MAX_CYLINDERS + ' 本です'); return false; }
    setCylinderCount(s.cylinders.length + 1);
    log('ボンベを追加（' + s.cylinders.length + '本目）');
    return true;
}
function goNext() {
    var r = state.run.cyl[state.run.current], missing = steps().filter(function (s) { return !checks()[s.id]; }).length;
    if (!measured(r.finalMpa)) { toast('「出口バルブを閉め、その時の一次圧」を入力してください'); return; }
    if (missing && !root.confirm('未チェックの項目が ' + missing + ' 件あります。次のボンベへ進みますか？')) return;
    if (state.run.current >= state.settings.cylinders.length - 1 && !addCylinder()) return;
    log('このボンベを終了し、次のボンベへ');
    state.run.current += 1; state.run.finished = false;
    log('開始');
    refresh();
    el('fc_focus').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function goPrev() { if (!root.confirm('前のボンベに戻ります。よろしいですか？')) return; log('前のボンベに戻る'); state.run.current -= 1; refresh(); }
function toggleFinish() {
    if (!state.run.finished) {
        var r = state.run.cyl[state.run.current];
        if (!measured(r.finalMpa) && !root.confirm('このボンベの終了一次圧が未入力です。このまま終了しますか？')) return;
        state.run.finished = true; compute();
        log('充填終了（合計 約 ' + litres((lastPlan ? lastPlan.filledL : 0) + currentDelivered()) + '）');
        refresh(); selectTab('lift');
    } else { state.run.finished = false; log('充填を再開'); refresh(); }
}
function resetRun() {
    if (!root.confirm('チェックと記録をすべて消して最初からやり直します（ボンベ情報・機体条件は残ります）。よろしいですか？')) return;
    state.run = emptyRun(state.settings.cylinders.length); lastSpokenKey = null;
    renderLiftInputs(); selectTab('gas'); refresh(); toast('最初からやり直します');
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
}
function onAction(e) {
    var b = e.target.closest('[data-action]'); if (!b || b.disabled) return;
    var a = b.dataset.action;
    if (a === 'start') startFilling();
    else if (a === 'go-gas') selectTab('gas');
    else if (a === 'go-check') selectTab('check');
    else if (a === 'topup-record') recordTopup();
    else if (a === 'complete') completeStep(b.dataset.step);
    else if (a === 'undo') undoStep();
    else if (a === 'next') goNext();
    else if (a === 'finish') toggleFinish();
    else if (a === 'go-lift') selectTab('lift');
}

function keepAwake() { if (!navigator.wakeLock || document.visibilityState !== 'visible') return; navigator.wakeLock.request('screen').catch(function () {}); }
function registerOffline() {
    // iPad などで「ホーム画面に追加」したときにオフラインで開けるようにする（https か localhost のときだけ動く）
    var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (secure && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
}

function init() {
    load();
    document.querySelectorAll('.rail-btn[data-tab]').forEach(function (b) { b.addEventListener('click', function () { selectTab(b.dataset.tab); }); });
    var savedTab = storageGet(STORAGE_KEY + '-tab');
    selectTab(!state.run.started ? 'gas' : (savedTab && el('fc_tab_' + savedTab) ? savedTab : 'check'));
    document.addEventListener('click', onAction);
    el('fc_setup').addEventListener('input', onSetupInput);
    el('fc_setup').addEventListener('change', onSetupInput);
    el('fc_focus').addEventListener('input', onPressureTyping);
    el('fc_focus').addEventListener('change', onStepsChange);
    el('fc_steps').addEventListener('change', onStepsChange);
    el('fc_steps').addEventListener('input', onPressureTyping);
    el('fc_steps').addEventListener('click', onStepRowClick);
    el('fc_settings').addEventListener('input', onSettingsInput);
    el('fc_settings').addEventListener('change', onSettingsInput);
    el('fc_settings').addEventListener('submit', function (e) { e.preventDefault(); });
    el('fc_next_cyl').addEventListener('click', goNext);
    el('fc_prev_cyl').addEventListener('click', goPrev);
    el('fc_finish').addEventListener('click', toggleFinish);
    el('fc_reset').addEventListener('click', resetRun);
    el('fc_import').addEventListener('click', importPredictor);
    el('fc_copy_log').addEventListener('click', copyLog);
    el('fc_download_log').addEventListener('click', downloadCsv);
    el('fc_speak').addEventListener('click', toggleSpeech);
    el('fc_lift').addEventListener('input', onLiftInput);
    el('fc_lift').addEventListener('change', onLiftInput);
    el('fc_lift_record').addEventListener('click', recordLift);
    document.addEventListener('visibilitychange', keepAwake);
    renderSettings(); renderLiftInputs(); renderSpeakButton(); refresh(); keepAwake(); registerOffline();
}
root.FillChecklistUI = { init: init };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}(typeof globalThis !== 'undefined' ? globalThis : this));
