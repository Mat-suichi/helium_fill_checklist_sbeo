const test = require('node:test');
const assert = require('node:assert/strict');
const gas = require('../js/calc/balloon-gas.js');
const core = require('../js/fill/fill-checklist-core.js');

const options = () => Object.assign({}, gas.DEFAULTS);
const cylinders = (n) => Array.from({ length: n }, () => ({ volumeL: 47, pressureMpa: 14 }));
function close(actual, expected, tolerance, label) { assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`); }

test('second and later cylinders skip hose purge and balloon tie steps', () => {
    const first = core.stepsFor(0).map((s) => s.id);
    const second = core.stepsFor(1).map((s) => s.id);
    assert.ok(first.includes('a1') && first.includes('b13') && first.includes('c1'));
    assert.ok(!second.some((id) => /^a/.test(id)) && !second.includes('b13') && !second.includes('c1'));
    assert.ok(second.includes('c2') && second.includes('d4'));
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
