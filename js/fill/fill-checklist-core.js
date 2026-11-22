(function(root,factory){
var gas=root.BalloonGas;
if(typeof module==='object'&&module.exports){gas=require('../calc/balloon-gas.js');module.exports=factory(gas);}
root.FillChecklistCore=factory(gas);
}(typeof globalThis!=='undefined'?globalThis:this,function(gas){
'use strict';
// 当日の全シーケンス（全シーケンス表_2026 後改版の A〜H）と、ボンベごとの目標一次圧・浮力の計算。
// ガス量・残圧の計算式は js/calc/balloon-gas.js（gas_calc_2026.py 準拠）をそのまま使う。
var MAX_CYLINDERS=6,MAX_PRESSURE_MPA=15,LIFT_TOLERANCE_PCT=5;

// 節（タイムラインの区切り）。D はボンベごとに繰り返す。
var SECTIONS=[
{id:'day',code:'当日',title:'現地入り・運搬'},
{id:'A',code:'A',title:'荷姿準備'},
{id:'B',code:'B',title:'バルーンの準備'},
{id:'C',code:'C',title:'ヘリウム充填準備（1本目）'},
{id:'D',code:'D',title:'ガス充填'},
{id:'F',code:'F',title:'浮力確認'},
{id:'G',code:'G',title:'バルーン締結'},
{id:'H',code:'H',title:'放球'}];

// scope: once=1回 / first=1本目のD節だけ / next=2本目以降のD節の頭（ボンベ接続）/ each=毎回 / notLast=最後のボンベ以外 / last=最後のボンベだけ
// input: initial|final（一次圧）, holderKg|withKg（体重計）, recoveryMpa（残圧の回復）
var STEPS=[
{id:'day-1',sec:'day',code:'6:40',scope:'once',text:'現地集合。ブルーシート・各荷物を運搬する',note:'持ち物リストを事前に作成しておく'},
{id:'day-2',sec:'day',code:'',scope:'once',text:'ヘリウム充填地点・作業地点にブルーシートを運搬し、風で動かないよう4隅を固定する',note:'ブルーシートは土足厳禁'},
{id:'day-3',sec:'day',code:'',scope:'once',text:'土禁エリアと土足エリアを明確に分ける'},
{id:'day-4',sec:'day',code:'',scope:'once',text:'1本につき2〜4人でヘリウムボンベを運搬し、横向きに並べる',note:'安全靴・作業用手袋の着用必須'},
{id:'A-1',sec:'A',code:'A-1',scope:'once',text:'ガス充填に使うものを用意する',note:'ホース・レギュレータ・レンチ・タイラップ・ダクトテープ・ニッパー・皮手袋・安全眼鏡・リークチェッカー・ペンチ・エアダスター・体重計'},
{id:'A-2',sec:'A',code:'A-2',scope:'once',text:'使用するボンベを決め、容積・残圧・気温・気圧を「① ボンベ」に入力しておく',note:'古い順番にボンベを使う',action:'go-gas'},
{id:'A-3',sec:'A',code:'A-3',scope:'once',text:'ペイロードや荷姿を準備する',note:'各団体のシーケンスに従う。ペイロード内の温度上昇に注意。遅延しやすいので逐次進捗を確認する'},
{id:'A-4',sec:'A',code:'A-4',scope:'once',text:'再度シミュを確認する'},
{id:'B-1',sec:'B',code:'B-1',scope:'once',text:'バルーンと締結するペイロード、道具を準備する',note:'タイラップ・ダクトテープ・ニッパーなど'},
{id:'B-2',sec:'B',code:'B-2',scope:'once',text:'バルーンを触る人は長袖・白手袋・ヘルメットを着用する',note:'バルーンに人の油分や髪が触れると劣化する'},
{id:'B-3',sec:'B',code:'B-3',scope:'once',text:'ブルーシートの上の砂利を除去する'},
{id:'B-4',sec:'B',code:'B-4',scope:'once',text:'バルーンを広げる'},
{id:'B-5',sec:'B',code:'B-5',scope:'once',text:'放球方法を現地にいる人全員に共有する'},
{id:'C-1',sec:'C',code:'C-1',scope:'once',text:'安全眼鏡を着用する'},
{id:'C-2',sec:'C',code:'C-2',scope:'once',text:'レギュレータの各バルブが閉まっていることを確認する',note:'中央の圧力調整バルブは左回りでゆるんだ状態が「閉」'},
{id:'C-7',sec:'C',code:'C-7',scope:'once',text:'ホースをレギュレータに挿入し、タイラップで固定する',note:'以後ホースは跨がない'},
{id:'C-3',sec:'C',code:'C-3',scope:'once',text:'ヘリウムボンベのキャップを外す'},
{id:'C-4',sec:'C',code:'C-4',scope:'once',text:'元栓が閉まっているかを確認する',note:'必ず close / open の矢印を見て確認する'},
{id:'C-5',sec:'C',code:'C-5',scope:'once',text:'エアダスターでボンベとレギュレータのねじ山をフラッシングする',note:'パッキンが飛ばないように注意。エアダスターは人に向けない'},
{id:'C-5b',sec:'C',code:'',scope:'once',text:'パッキンが入っていることを確認する'},
{id:'C-6',sec:'C',code:'C-6',scope:'once',text:'レギュレータをボンベに取り付ける',note:'ガスが噴出しうる方向の正面に立たない。レンチは面を挟み、正しい方向に回す。まっすぐ差し込まないと食いつかない。ゴミがあれば再度フラッシング'},
{id:'C-8',sec:'C',code:'C-8',scope:'once',text:'レギュレータの各バルブが閉まっているか再度確認する'},
{id:'C-9',sec:'C',code:'C-9',scope:'once',text:'皮手袋を着用する'},
{id:'C-9b',sec:'C',code:'',scope:'once',text:'ホースはまだ気球に入れない（先にホース内のガス置換をする）'},
{id:'C-10',sec:'C',code:'C-10',scope:'once',text:'開栓許可を得る。許可を得たら周囲に声を出して知らせる',note:'充填者の視界を妨げない。バルーンが風でねじれると3秒ほどで破裂する恐れがある'},
{id:'C-11',sec:'C',code:'C-11',scope:'once',text:'元栓をゆっくり（1秒に5°程度）開け、一次圧の指針が止まるのを確認する',note:'元栓は全開にしてから半周戻す'},
{id:'C-12',sec:'C',code:'C-12',scope:'once',text:'中央の圧力調整バルブで二次圧を 0.5〜0.8 MPa に調整する',note:'1.0 MPa でリークしたことがある'},
{id:'C-13',sec:'C',code:'C-13',scope:'once',text:'ホースの先を下に向け、出口バルブを開けて2秒ほどガスを大気開放し、閉める（異物を飛ばし、ホース内をガスに置換する）',note:'先は地面に付けない。すぐに充填しない場合は元栓を閉めておく'},
// ---- D：ボンベごと ----
{id:'N-3',sec:'D',code:'C-3',scope:'next',text:'このボンベのキャップを外す'},
{id:'N-4',sec:'D',code:'C-4',scope:'next',text:'元栓が閉まっているかを確認する',note:'必ず close / open の矢印を見て確認する'},
{id:'N-5',sec:'D',code:'C-5',scope:'next',text:'エアダスターでボンベとレギュレータのねじ山をフラッシングし、パッキンが入っていることを確認する'},
{id:'N-6',sec:'D',code:'C-6',scope:'next',text:'ホースの付いたレギュレータをこのボンベに取り付ける',note:'噴出しうる方向の正面に立たない'},
{id:'N-8',sec:'D',code:'C-8',scope:'next',text:'レギュレータの各バルブが閉まっているか確認する',note:'2本目以降でも必ず確認する'},
{id:'N-10',sec:'D',code:'C-10',scope:'next',text:'再度開栓許可を得て、周囲に声を出して知らせる'},
{id:'N-11',sec:'D',code:'C-11',scope:'next',text:'元栓をゆっくり（1秒に5°程度）開け、一次圧の指針が止まるのを確認する',note:'元栓は全開にしてから半周戻す'},
{id:'N-12',sec:'D',code:'C-12',scope:'next',text:'二次圧を 0.5〜0.8 MPa に調整する'},
{id:'D-1',sec:'D',code:'D-1',scope:'first',text:'ガス置換後のホースをタイラップでバルーンに締結する',note:'ロープ締結時に強く締めるため、タイラップは切らない'},
{id:'D-2',sec:'D',code:'D-2',scope:'each',text:'この時点の一次圧を確認して入力し、運営に伝える',input:'initial'},
{id:'D-3',sec:'D',code:'D-3',scope:'each',text:'実験代表に充填許可を得る',note:'周囲の安全を確認する'},
{id:'D-4',sec:'D',code:'D-4',scope:'each',text:'充填することを周知し、出口バルブをゆっくり全開まで開いて充填する',note:'充填中は一次圧を読み上げる'},
{id:'D-5',sec:'D',code:'D-5',scope:'first',text:'バルーンが十分に膨らむまでは、様子を見ながら流量を調整する',note:'内壁に強くガスが当たったり、ホースが中で暴れたりするとバルーンを傷つける'},
{id:'D-6',sec:'D',code:'D-6',scope:'first',text:'二人で気球の口を保持してもらう（最大約20 kgの浮力）',note:'交代は「離します」「持ちました」と声に出し、相手が掴んだのを確認してから離す'},
{id:'D-7',sec:'D',code:'D-7',scope:'first',text:'バルーンが浮上し始めたら、布手袋の4人以上に周りから支えてもらう',note:'基本は触らず、風で煽られたときに支える程度'},
{id:'D-8',sec:'D',code:'D-8',scope:'each',text:'一次圧が目標値まで下がるまで充填する',target:true},
{id:'D-9',sec:'D',code:'D-9',scope:'each',text:'出口バルブを閉め、直後の一次圧を入力する',input:'final'},
{id:'D-10',sec:'D',code:'D-10',scope:'each',text:'脱圧する：元栓を閉め、出口バルブを開け、一次圧・二次圧がともに0になったら出口バルブを閉め、圧力調整バルブも閉める（緩める）'},
{id:'D-11',sec:'D',code:'D-11',scope:'notLast',text:'レギュレータをボンベから外す（ホースは気球に付けたまま、次のボンベへ）'},
{id:'E-3',sec:'D',code:'E-3',scope:'last',text:'最後のボンベなのでレギュレータは外さない（ホースが気球につながったまま浮力確認へ）'},
// ---- F〜H ----
{id:'F-1',sec:'F',code:'F-1',scope:'once',text:'体重計に乗る人の体重を測定して入力する',input:'holderKg'},
{id:'F-2',sec:'F',code:'F-2',scope:'once',text:'その人がホースが入った状態の気球を持って体重計に乗り、入力する',input:'withKg',note:'計算と実測の差が ±5% 以内か確認する'},
{id:'F-3',sec:'F',code:'',scope:'once',text:'浮力を判定する（±5%以内か・想定上昇速度）。足りなければ「③ 浮力」の追加充填をしてから F-2 を測り直す',lift:true},
{id:'G-1',sec:'G',code:'G-1',scope:'once',text:'バルーンの口のタイラップを締めながらホースを抜く。パラシュート上端のロープを挟み込むように口を折りたたみ、ロープとバルーンを締結して、タイラップとダクトテープで固定する',note:'タイラップの端はダクトテープで飲み込むか切る。切り口でバルーンを傷つけない'},
{id:'G-2',sec:'G',code:'G-2',scope:'once',text:'ホースの端を他者が保持し、圧力調整バルブ、出口バルブの順に開けて脱圧し、閉じる'},
{id:'G-3',sec:'G',code:'G-3',scope:'once',text:'ボンベを近くで見守り、残圧とその回復具合を記録する',input:'recoveryMpa'},
{id:'H-1',sec:'H',code:'H-1',scope:'once',text:'風の向きを見て、放球する方向を決める',note:'風と平行に放球する'},
{id:'H-2',sec:'H',code:'H-2',scope:'once',text:'慌てず靴を履き、作業用手袋やヘルメットを着用し、放球地点に移動する',note:'足下にも注意を払い、ロープは絶対に跨がない'},
{id:'H-3',sec:'H',code:'H-3',scope:'once',text:'カメラやダウンリンク、フライトピンなどの最終確認を行う'},
{id:'H-4',sec:'H',code:'H-4',scope:'once',text:'バルーンを風下にして、ペイロードを持つ人は一定の間隔で一列に並ぶ',note:'ロープを指に絡めたり手に巻いたりしない。ロープが首に掛からないよう指示者は気を配る'},
{id:'H-5',sec:'H',code:'H-5',scope:'once',text:'放球許可を得る',note:'放球方法（たぐり上げる等）を放球現場の全員に周知しておく'},
{id:'H-6',sec:'H',code:'H-6',scope:'once',text:'放球する',note:'ロープは滑らせない。手を離すときは声を出して伝える'},
{id:'H-7',sec:'H',code:'H-7',scope:'once',text:'飛行シミュを放球時刻で回し直し、データを必ずダウンロードする',note:'担当者を決めておく'},
{id:'H-8',sec:'H',code:'H-8',scope:'once',text:'気温・大気圧を記録する'}];
var BY_ID={};STEPS.forEach(function(s){BY_ID[s.id]=s;});

// 実際に使うボンベの本数（最後のボンベ）を計画から決める
function lastCylinderIndex(plan,cylCount){
if(!plan)return Math.max(0,cylCount-1);
var last=0;
plan.rows.forEach(function(r){if(r.state==='done'||r.role==='full'||r.role==='partial')last=Math.max(last,r.index);});
return Math.min(last,cylCount-1);
}

// タイムラインを1列に展開する。key は once の手順なら id、ボンベごとの手順なら「n:id」（n は1始まり）。
function timeline(lastIndex){
var out=[];
SECTIONS.forEach(function(sec){
if(sec.id!=='D'){
STEPS.forEach(function(s){if(s.sec===sec.id)out.push({key:s.id,step:s,sec:sec.id,group:sec.id,cyl:null});});
return;
}
for(var i=0;i<=lastIndex;i+=1){
var isFirst=i===0,isLast=i===lastIndex;
STEPS.forEach(function(s){
if(s.sec!=='D')return;
var ok=s.scope==='each'||(s.scope==='first'&&isFirst)||(s.scope==='next'&&!isFirst)||(s.scope==='notLast'&&!isLast)||(s.scope==='last'&&isLast);
if(ok)out.push({key:(i+1)+':'+s.id,step:s,sec:'D',group:'D'+(i+1),cyl:i});
});
}
});
return out;
}
// 画面に出す区切り（D はボンベごと）
function groups(lastIndex){
var out=[];
SECTIONS.forEach(function(sec){
if(sec.id!=='D'){out.push({id:sec.id,code:sec.code,title:sec.title,cyl:null});return;}
for(var i=0;i<=lastIndex;i+=1)out.push({id:'D'+(i+1),code:'D'+(i+1),title:'ガス充填 '+(i+1)+'本目'+(i===lastIndex?'（最後）':''),cyl:i});
});
return out;
}

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
// current: これより前のボンベは使い終わり（実測値で計算）
// tolL: これ以下の残りは「入れ終わった」とみなす量。目標一次圧は 0.01 MPa 単位なので、ぴったり止めても数 L 残る。
function buildPlan(o,required,cylinders,current,tolL){
var end=Number(o.targetCylinderPressureMpa),filled=0,rows=[],tol=tolL!=null?tolL:Math.max(10,required*0.002);
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
if(left<=tol){row.role='unused';return;}
if(row.capacityL<=left+1e-6){row.role='full';row.useL=row.capacityL;row.targetMpa=end;left-=row.capacityL;return;}
var plan=gas.calculateCylinderPlan(left,singleOptions(o,row.volumeL,row.startMpa,end,row.index));
row.role='partial';row.useL=left;row.targetMpa=plan.cylinders[0].residualPressureMpa;left=0;
});
return{requiredL:required,filledL:filled,remainingL:remaining,shortfallL:left,insufficient:left>tol,rows:rows,endMpa:end,exponentN:exponentFor(o)};
}

// 必要ガス量: 機体条件から計算するか直接入力
function requiredGas(settings){
if(settings.requiredMode==='manual'){var v=num(settings.manualRequiredL);if(!(v>0))throw new RangeError('必要ガス量（L）を入力してください');return{gasVolumeL:v,source:'manual'};}
var r=gas.calculate(settings.gas);
return{gasVolumeL:r.gasVolumeL,source:'calc',totalLiftKg:r.totalLiftKg,pureLiftKg:r.pureLiftKg,totalMassKg:r.totalMassKg,burstKm:r.burst.defaultKm};
}

// 体重計による浮力測定。
// 気球を持つと体重計の値が減る。減った分 = 全浮力 − 気球質量 − 一緒に持っている物（ホース分など）。
// 上昇速度は balloon-gas と同じ v = k√L / (W+L)^(1/3)（L: 純浮力, W: 総重量）。
// 全シーケンス表 F-2：計算した全浮力と実測の差が ±5% 以内か。
function ascentRate(k,totalMassKg,pureLiftKg){return pureLiftKg>0?k*Math.sqrt(pureLiftKg)/Math.pow(totalMassKg+pureLiftKg,1/3):0;}
function liftCheck(o,m){
var holder=num(m.holderKg),withBalloon=num(m.withKg),attached=num(m.attachedG),resolution=num(m.resolutionKg);
if(!Number.isFinite(attached))attached=0;
if(!(resolution>0))resolution=0.1;
var r=gas.calculate(o),k=r.model.k,balloonKg=Number(o.balloonMassG)/1000,W=r.totalMassKg,attachedKg=attached/1000;
var targetPullKg=r.totalLiftKg-balloonKg-attachedKg;
var out={totalMassKg:W,balloonKg:balloonKg,targetAscentRate:Number(o.targetAscentRate),targetPullKg:targetPullKg,targetGrossLiftKg:r.totalLiftKg,tolerancePct:LIFT_TOLERANCE_PCT,measured:false};
if(!(holder>0)||!(withBalloon>0))return out;
function at(pull){var gross=pull+balloonKg+attachedKg,pure=gross-W;return{pullKg:pull,grossLiftKg:gross,pureLiftKg:pure,ascentRate:ascentRate(k,W,pure)};}
var c=at(holder-withBalloon),lo=at(holder-withBalloon-resolution),hi=at(holder-withBalloon+resolution);
var deltaKg=targetPullKg-c.pullKg,gasL=gas.calculateGasVolumeL(Math.abs(deltaKg),o.temperatureC,o.pressureHpa,o.densityDifferenceKgM3);
var errorPct=(c.grossLiftKg-r.totalLiftKg)/r.totalLiftKg*100;
return Object.assign(out,c,{measured:true,rateLow:lo.ascentRate,rateHigh:hi.ascentRate,deltaPullKg:deltaKg,gasAdjustL:deltaKg>=0?gasL:-gasL,canFly:c.pureLiftKg>0,errorPct:errorPct,withinTolerance:Math.abs(errorPct)<=LIFT_TOLERANCE_PCT});
}

// 浮力測定のあとの追加充填。addL [L] を、残っているボンベ（今の一次圧）から入れるときの目標一次圧。
// candidates: [{index, volumeL, pressureMpa(今の一次圧)}] を使う順に並べたもの。
// 1本目オフセットは充填開始時の補正なので、追加充填では使わない。
function topupPlan(o,addL,candidates){
var end=Number(o.targetCylinderPressureMpa),usable=candidates.filter(function(c){return Number(c.pressureMpa)>end&&Number(c.volumeL)>0;});
if(!(addL>0)||!usable.length)return{addL:addL,rows:[],shortfallL:addL>0?addL:0,insufficient:addL>0};
var o2=Object.assign({},o,{firstCylinderOffsetMpa:0});
var plan=buildPlan(o2,addL,usable.map(function(c){return{volumeL:Number(c.volumeL),pressureMpa:Number(c.pressureMpa)};}),0,1e-6);
var rows=plan.rows.filter(function(r){return r.role==='full'||r.role==='partial';}).map(function(r){var c=usable[r.index];return{index:c.index,volumeL:c.volumeL,startMpa:Number(c.pressureMpa),targetMpa:r.targetMpa,useL:r.useL,dropMpa:Number(c.pressureMpa)-r.targetMpa};});
return{addL:addL,rows:rows,shortfallL:plan.shortfallL,insufficient:plan.insufficient};
}

return{STEPS:STEPS,SECTIONS:SECTIONS,BY_ID:BY_ID,MAX_CYLINDERS:MAX_CYLINDERS,MAX_PRESSURE_MPA:MAX_PRESSURE_MPA,LIFT_TOLERANCE_PCT:LIFT_TOLERANCE_PCT,timeline:timeline,groups:groups,lastCylinderIndex:lastCylinderIndex,ascentRate:ascentRate,liftCheck:liftCheck,topupPlan:topupPlan,deliveredL:deliveredL,buildPlan:buildPlan,requiredGas:requiredGas};
}));
