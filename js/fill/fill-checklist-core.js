(function(root,factory){
var gas=root.BalloonGas;
if(typeof module==='object'&&module.exports){gas=require('../calc/balloon-gas.js');module.exports=factory(gas);}
root.FillChecklistCore=factory(gas);
}(typeof globalThis!=='undefined'?globalThis:this,function(gas){
'use strict';
// 充填チェックシートの手順定義と、ボンベごとの目標一次圧の計算。
// ガス量・残圧の計算式は js/calc/balloon-gas.js（gas_calc_2026.py 準拠）をそのまま使う。
var MAX_CYLINDERS=6,MAX_PRESSURE_MPA=15;

// scope: 'first' = 1本目だけ / 'all' = 毎回
// input: 'initial' = 開始時の一次圧を入力 / 'final' = 出口を閉めた時の一次圧を入力
var STEPS=[
{id:'a1',section:'prep',scope:'first',text:'ブルーシートを広げる'},
{id:'a2',section:'prep',scope:'first',text:'土禁エリアと土足エリアを明確に分け、土足エリアにボンベを配置する'},
{id:'a3',section:'prep',scope:'first',text:'バルーンを広げる'},
{id:'a4',section:'prep',scope:'first',text:'レギュレータにホースを取り付ける。タイラップで固定する'},
{id:'a5',section:'prep',scope:'first',text:'ホースは先にヘリウムガス置換するため、まだ気球に入れない'},
{id:'b1',section:'connect',scope:'all',text:'ヘリウムガスボンベのキャップを外す'},
{id:'b2',section:'connect',scope:'all',text:'元栓が閉まっているか確認する'},
{id:'b3',section:'connect',scope:'all',text:'エアダスターでボンベとレギュレータのネジ山を清掃する'},
{id:'b4',section:'connect',scope:'all',text:'パッキンが入っていることを確認する'},
{id:'b5',section:'connect',scope:'all',text:'レギュレータをボンベに取り付ける'},
{id:'b6',section:'connect',scope:'all',text:'レギュレータの各バルブが全て閉まっている（調整ハンドルは緩んでいる）ことを確認する'},
{id:'b7',section:'connect',scope:'all',text:'皮手袋を着用する'},
{id:'b8',section:'connect',scope:'all',text:'開栓許可を得て、開栓することを周りに知らせる'},
{id:'b9',section:'connect',scope:'all',text:'元栓を1秒に5°ほどで開栓し、一次圧の針が止まるのを確認する'},
{id:'b10',section:'connect',scope:'first',text:'ホースの先端を誰かが持っていることを確認する'},
{id:'b11',section:'connect',scope:'first',text:'以後ホースの先端は上向き、ホースは誰もまたがない'},
{id:'b12',section:'connect',scope:'all',text:'中央の圧力調整ハンドルで二次圧を 0.5 MPa に調整する（MAX 0.8 MPa）'},
{id:'b13',section:'connect',scope:'first',text:'出口バルブをゆっくり開け、3秒ほどガスを通したら閉める（ホース内置換）。他のバルブは触らない'},
{id:'c1',section:'fill',scope:'first',text:'ホースの先端を上に向けたまま、置換後のホースをタイラップでバルーンに締結する'},
{id:'c2',section:'fill',scope:'all',text:'一次圧を確認して入力する',input:'initial'},
{id:'c3',section:'fill',scope:'all',text:'充填許可を得る'},
{id:'c4',section:'fill',scope:'all',text:'出口バルブをゆっくり全開まで開く。全開になったら声に出す'},
{id:'c5',section:'fill',scope:'all',text:'バルーンが十分に膨らむまでは、バルーンの様子を見ながら調整する'},
{id:'c6',section:'fill',scope:'all',text:'一次圧が目標値まで下がるまで充填する',target:true},
{id:'d1',section:'release',scope:'all',text:'出口バルブを閉め、その時の一次圧を入力する',input:'final'},
{id:'d2',section:'release',scope:'all',text:'元栓を閉める'},
{id:'d3',section:'release',scope:'all',text:'出口バルブを開ける'},
{id:'d4',section:'release',scope:'all',text:'二次圧と一次圧がどちらも 0 になったことを確認して出口バルブを閉める'},
{id:'d5',section:'release',scope:'all',text:'圧力調整ハンドルを緩める（＝閉じる）'},
{id:'d6',section:'release',scope:'all',text:'レギュレータを外す'}];
var SECTIONS={prep:'充填準備（1本目のみ）',connect:'ボンベ接続・開栓・ホース内置換',fill:'充填',release:'脱圧してレギュレータを外す'};

function stepsFor(index){return STEPS.filter(function(s){return s.scope==='all'||index===0;});}

function num(v){return v===''||v==null?NaN:Number(v);}
function validPressure(p){return Number.isFinite(p)&&p>=0&&p<=MAX_PRESSURE_MPA;}

function exponentFor(o){return o.cylinderProcess==='adiabatic'?gas.HELIUM_GAMMA:(o.cylinderProcess==='quasi-static'?1:Number(o.polytropicN));}

// 1本だけのボンベを balloon-gas の計算に通すためのオプション（4本必須なので残りは空ボンベ）
function singleOptions(o,volumeL,p0,end,index){
var offset=index===0?Number(o.firstCylinderOffsetMpa)||0:0;
return Object.assign({},o,{targetCylinderPressureMpa:end,firstCylinderOffsetMpa:offset,cylinders:[{id:'1',volumeL:volumeL,pressureMpa:p0},{id:'2',volumeL:1,pressureMpa:0},{id:'3',volumeL:1,pressureMpa:0},{id:'4',volumeL:1,pressureMpa:0}]});
}

// 一次圧 p0 → p1 まで使ったときにボンベから出たガス量 [L, 充填時大気圧換算]
function deliveredL(o,volumeL,index,p0,p1){
if(!(p0>p1))return 0;
var offset=index===0?Number(o.firstCylinderOffsetMpa)||0:0;
if(p1<=offset)p1=offset+1e-6;
return gas.calculateCylinderPlan(1e12,singleOptions(o,volumeL,p0,p1,index)).availableGasL;
}

// required: 必要ガス量 [L]
// cylinders: [{volumeL, pressureMpa(予定の初期圧), initialMpa(実測), finalMpa(実測)}]
// current: いま扱っているボンベの番号（0始まり）
function buildPlan(o,required,cylinders,current){
var end=Number(o.targetCylinderPressureMpa),filled=0,rows=[];
cylinders.forEach(function(c,i){
var initial=num(c.initialMpa),final=num(c.finalMpa),planned=num(c.pressureMpa),done=i<current&&validPressure(initial)&&validPressure(final);
var row={index:i,volumeL:Number(c.volumeL),plannedInitialMpa:planned,initialMpa:validPressure(initial)?initial:null,finalMpa:validPressure(final)?final:null,state:i<current?'done':(i===current?'current':'upcoming'),deliveredL:0,useL:0,capacityL:0,targetMpa:null,role:'unused',initialIsMeasured:validPressure(initial)};
if(done){row.deliveredL=deliveredL(o,row.volumeL,i,initial,final);filled+=row.deliveredL;}
rows.push(row);
});
var remaining=Math.max(0,required-filled),left=remaining;
rows.forEach(function(row){
if(row.state==='done')return;
var p0=row.initialIsMeasured?row.initialMpa:row.plannedInitialMpa;
row.startMpa=validPressure(p0)?p0:null;
if(row.startMpa==null||!(row.volumeL>0)){row.role='invalid';return;}
row.capacityL=deliveredL(o,row.volumeL,row.index,row.startMpa,end);
if(left<=1e-6){row.role='unused';return;}
if(row.capacityL<=left+1e-6){row.role='full';row.useL=row.capacityL;row.targetMpa=end;left-=row.capacityL;return;}
var plan=gas.calculateCylinderPlan(left,singleOptions(o,row.volumeL,row.startMpa,end,row.index));
row.role='partial';row.useL=left;row.targetMpa=plan.cylinders[0].residualPressureMpa;left=0;
});
return{requiredL:required,filledL:filled,remainingL:remaining,shortfallL:left,insufficient:left>1e-6,rows:rows,endMpa:end,exponentN:exponentFor(o)};
}

// 必要ガス量: 機体条件から計算するか直接入力
function requiredGas(settings){
if(settings.requiredMode==='manual'){var v=num(settings.manualRequiredL);if(!(v>0))throw new RangeError('必要ガス量（L）を入力してください');return{gasVolumeL:v,source:'manual'};}
var r=gas.calculate(settings.gas);
return{gasVolumeL:r.gasVolumeL,source:'calc',totalLiftKg:r.totalLiftKg,pureLiftKg:r.pureLiftKg,totalMassKg:r.totalMassKg,burstKm:r.burst.defaultKm};
}

// 体重計による浮力測定。
// 気球を持つと体重計の値が減る。減った分 = 全浮力 − 気球質量 − 一緒に持っている物。
// 上昇速度は balloon-gas と同じ v = k√L / (W+L)^(1/3)（L: 純浮力, W: 総重量）。
function ascentRate(k,totalMassKg,pureLiftKg){return pureLiftKg>0?k*Math.sqrt(pureLiftKg)/Math.pow(totalMassKg+pureLiftKg,1/3):0;}
function liftCheck(o,m){
var holder=num(m.holderKg),withBalloon=num(m.withKg),attached=num(m.attachedG),resolution=num(m.resolutionKg);
if(!Number.isFinite(attached))attached=0;
if(!(resolution>0))resolution=0.1;
var r=gas.calculate(o),k=r.model.k,balloonKg=Number(o.balloonMassG)/1000,W=r.totalMassKg,attachedKg=attached/1000;
var targetPullKg=r.totalLiftKg-balloonKg-attachedKg;
var out={totalMassKg:W,balloonKg:balloonKg,targetAscentRate:Number(o.targetAscentRate),targetPullKg:targetPullKg,targetGrossLiftKg:r.totalLiftKg,measured:false};
if(!(holder>0)||!(withBalloon>0))return out;
function at(pull){var gross=pull+balloonKg+attachedKg,pure=gross-W;return{pullKg:pull,grossLiftKg:gross,pureLiftKg:pure,ascentRate:ascentRate(k,W,pure)};}
var c=at(holder-withBalloon),lo=at(holder-withBalloon-resolution),hi=at(holder-withBalloon+resolution);
var deltaKg=targetPullKg-c.pullKg,gasL=gas.calculateGasVolumeL(Math.abs(deltaKg),o.temperatureC,o.pressureHpa,o.densityDifferenceKgM3);
return Object.assign(out,c,{measured:true,rateLow:lo.ascentRate,rateHigh:hi.ascentRate,deltaPullKg:deltaKg,gasAdjustL:deltaKg>=0?gasL:-gasL,canFly:c.pureLiftKg>0});
}

return{STEPS:STEPS,ascentRate:ascentRate,liftCheck:liftCheck,SECTIONS:SECTIONS,MAX_CYLINDERS:MAX_CYLINDERS,MAX_PRESSURE_MPA:MAX_PRESSURE_MPA,stepsFor:stepsFor,deliveredL:deliveredL,buildPlan:buildPlan,requiredGas:requiredGas};
}));
