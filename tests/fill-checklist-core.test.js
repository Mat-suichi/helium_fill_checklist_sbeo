const test = require('node:test');
const assert = require('node:assert/strict');
const gas = require('../js/calc/balloon-gas.js');
const core = require('../js/fill/fill-checklist-core.js');

const options = () => Object.assign({}, gas.DEFAULTS);
const cylinders = (n) => Array.from({ length: n }, () => ({ volumeL: 47, pressureMpa: 14 }));
function close(actual, expected, tolerance, label) { assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`); }

test('timeline follows the 2026 sequence sheet from arrival to release', () => {
    const tl = core.timeline(1);
    const keys = tl.map((t) => t.key);
    const order = ['day-1', 'A-1', 'B-4', 'C-1', 'C-13', '1:D-1', '1:D-8', '2:N-6', '2:D-8', 'F-2', 'G-1', 'H-6'];
    order.reduce((prev, k) => { const i = keys.indexOf(k); assert.ok(i > prev, `${k} order`); return i; }, -1);
    assert.equal(new Set(keys).size, keys.length, 'keys are unique');
});

test('cylinder sections: first ties the hose, later ones reconnect, only the last keeps the regulator', () => {
    const tl = core.timeline(2);
    const of = (n) => tl.filter((t) => t.cyl === n).map((t) => t.step.id);
    assert.ok(of(0).includes('D-1') && of(0).includes('D-6') && !of(0).includes('N-6'));
    assert.ok(of(1).includes('N-6') && !of(1).includes('D-1') && !of(1).includes('D-6'));
    assert.ok(of(0).includes('D-11') && of(1).includes('D-11') && !of(0).includes('E-3'));
    assert.ok(!of(2).includes('D-11') && of(2).includes('E-3'));
    assert.deepEqual(core.groups(2).map((g) => g.id), ['day', 'A', 'B', 'C', 'D1', 'D2', 'D3', 'F', 'G', 'H']);
});

test('last cylinder index comes from the plan', () => {
    const o = options();
    const required = gas.calculate(o).gasVolumeL;
    const plan = core.buildPlan(o, required, cylinders(4), 0);
    assert.equal(core.lastCylinderIndex(plan, 4), 1);
    assert.equal(core.lastCylinderIndex(core.buildPlan(o, 1000, cylinders(4), 0), 4), 0);
});

test('lift check reports the ±5% difference from the calculated gross lift', () => {
    const o = options();
    const target = core.liftCheck(o, {});
    const exact = core.liftCheck(o, { holderKg: 60, withKg: 60 - target.targetPullKg });
    close(exact.errorPct, 0, 1e-9, 'exact');
    assert.equal(exact.withinTolerance, true);
    const low = core.liftCheck(o, { holderKg: 60, withKg: 60 - target.targetPullKg + 0.5 });
    assert.ok(low.errorPct < -5 && low.withinTolerance === false);
});

test('initial plan matches the existing gas calculator targets', () => {
    const o = options();
    const required = gas.calculate(o).gasVolumeL;
    const reference = gas.calculate(o).cylinders.cylinders;
    const plan = core.buildPlan(o, required, cylinders(4), 0);
    plan.rows.forEach((row, i) => {
        close(row.capacityL, reference[i].capacityL, 1e-6, `capacity ${i}`);
        assert.equal(row.targetMpa, reference[i].residualPressureMpa);
    });
    assert.equal(plan.rows[0].role, 'full');
    assert.equal(plan.rows[1].role, 'partial');
    assert.equal(plan.insufficient, false);
});

test('measured pressures re-plan the remaining cylinders', () => {
    const o = options();
    const required = gas.calculate(o).gasVolumeL;
    const cyl = cylinders(3);
    cyl[0].initialMpa = 14; cyl[0].finalMpa = 0.2; cyl[1].initialMpa = 13.5;
    const plan = core.buildPlan(o, required, cyl, 1);
    close(plan.filledL, core.deliveredL(o, 47, 0, 14, 0.2), 1e-9, 'filled');
    close(plan.remainingL, required - plan.filledL, 1e-9, 'remaining');
    assert.equal(plan.rows[1].role, 'partial');
    assert.ok(plan.rows[1].targetMpa < 13.5 && plan.rows[1].targetMpa > 12);
    assert.equal(plan.rows[2].role, 'unused');
});

test('stopping a cylinder early moves the remainder to the next one', () => {
    const o = options();
    const required = 12000;
    const cyl = cylinders(3);
    cyl[0].initialMpa = 14; cyl[0].finalMpa = 3;
    const plan = core.buildPlan(o, required, cyl, 1);
    assert.equal(plan.rows[1].role, 'full');
    assert.equal(plan.rows[1].targetMpa, 0.2);
    assert.equal(plan.rows[2].role, 'partial');
});

test('shortfall is reported when cylinders run out', () => {
    const plan = core.buildPlan(options(), 20000, cylinders(2), 0);
    assert.equal(plan.insufficient, true);
    assert.ok(plan.shortfallL > 0);
});

test('manual required gas volume is validated', () => {
    assert.equal(core.requiredGas({ requiredMode: 'manual', manualRequiredL: '5000' }).gasVolumeL, 5000);
    assert.throws(() => core.requiredGas({ requiredMode: 'manual', manualRequiredL: '' }), /必要ガス量/);
});

test('scale lift measurement reproduces the target ascent rate', () => {
    const o = options();
    const target = core.liftCheck(o, {});
    assert.equal(target.measured, false);
    const ref = gas.calculate(o);
    close(target.targetPullKg, ref.totalLiftKg - o.balloonMassG / 1000, 1e-12, 'target pull');
    const m = core.liftCheck(o, { holderKg: 60, withKg: 60 - target.targetPullKg, attachedG: 0, resolutionKg: 0.1 });
    close(m.ascentRate, o.targetAscentRate, 1e-9, 'ascent rate');
    close(m.pureLiftKg, ref.pureLiftKg, 1e-9, 'pure lift');
    assert.ok(m.rateLow < m.ascentRate && m.ascentRate < m.rateHigh);
    close(m.deltaPullKg, 0, 1e-9, 'delta');
});

test('attached items and low lift are handled', () => {
    const o = options();
    const withTie = core.liftCheck(o, { holderKg: 60, withKg: 56, attachedG: 100 });
    const without = core.liftCheck(o, { holderKg: 60, withKg: 56, attachedG: 0 });
    close(withTie.grossLiftKg - without.grossLiftKg, 0.1, 1e-9, 'attached mass');
    const low = core.liftCheck(o, { holderKg: 60, withKg: 59 });
    assert.equal(low.canFly, false);
    assert.equal(low.ascentRate, 0);
    assert.ok(low.deltaPullKg > 0 && low.gasAdjustL > 0);
});

test('top-up plan gives the primary pressure to stop at for the missing gas', () => {
    const o = options();
    const lift = core.liftCheck(o, { holderKg: 62.4, withKg: 57.8 });
    assert.ok(lift.deltaPullKg > 0 && lift.gasAdjustL > 0);
    const plan = core.topupPlan(o, lift.gasAdjustL, [{ index: 1, volumeL: 47, pressureMpa: 13.1 }, { index: 2, volumeL: 47, pressureMpa: 14 }]);
    assert.equal(plan.rows.length, 1);
    assert.equal(plan.rows[0].index, 1);
    assert.ok(plan.rows[0].targetMpa < 13.1 && plan.rows[0].targetMpa > 12);
    close(core.deliveredL(Object.assign({}, o, { firstCylinderOffsetMpa: 0 }), 47, 1, 13.1, plan.rows[0].targetMpa), lift.gasAdjustL, 15, 'delivered matches request');
});

test('top-up skips empty cylinders and reports shortfall', () => {
    const o = options();
    const plan = core.topupPlan(o, 500, [{ index: 0, volumeL: 47, pressureMpa: 0.2 }, { index: 1, volumeL: 47, pressureMpa: 1.0 }]);
    assert.equal(plan.rows[0].index, 1);
    assert.equal(plan.insufficient, true);
    assert.ok(plan.shortfallL > 0);
    assert.equal(core.topupPlan(o, 100, [{ index: 0, volumeL: 47, pressureMpa: 0.2 }]).insufficient, true);
});

test('stopping exactly at the rounded target does not pull in another cylinder', () => {
    const o = options();
    const required = gas.calculate(o).gasVolumeL;
    const cyl = cylinders(3);
    cyl[1].pressureMpa = 13.5;
    const first = core.buildPlan(o, required, cyl, 0);
    cyl[0].initialMpa = 14; cyl[0].finalMpa = first.rows[0].targetMpa;
    cyl[1].initialMpa = 13.5; cyl[1].finalMpa = first.rows[1].targetMpa;
    const after = core.buildPlan(o, required, cyl, 2);
    assert.ok(after.remainingL > 0, 'a few litres remain from rounding');
    assert.equal(after.rows[2].role, 'unused');
    assert.equal(core.lastCylinderIndex(after, 3), 1);
});
