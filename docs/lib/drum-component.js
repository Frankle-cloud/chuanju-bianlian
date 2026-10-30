/* 川剧锣鼓组件：无框架、无摄像头依赖。所有坐标为1920×1080设计坐标。 */
(function(global){
'use strict';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const NS='http://www.w3.org/2000/svg';
class Logic{
 constructor(config){this.config=config;this.reset();}
 reset(){this.progress=0;this.lastHit=-Infinity;this.dwellStart=null;this.latched=false;}
 hit(side,now){if(!['left','right'].includes(side)||now-this.lastHit<this.config.hitCooldownMs)return null;this.lastHit=now;const correct=this.config.sequence[this.progress]===side;if(correct)this.progress++;return {side,correct,progress:this.progress,complete:this.progress===this.config.sequence.length};}
 command(p,now){const c=this.config.command,inside=!!p?.active&&p.x>=c.x&&p.x<=c.x+c.width&&p.y>=c.y&&p.y<=c.y+c.height;if(!inside||this.progress<this.config.sequence.length){this.dwellStart=null;this.latched=false;return {fraction:0,fire:false};}if(this.latched)return {fraction:1,fire:false};if(this.dwellStart===null)this.dwellStart=now;const fraction=Math.min(1,(now-this.dwellStart)/c.dwellMs),fire=fraction===1;if(fire)this.latched=true;return {fraction,fire};}
}
function mapVideoPoint(x,y,videoWidth,videoHeight,mirrored=false){if(!(videoWidth>0&&videoHeight>0))throw Error('视频宽高必须大于0');const s=Math.min(1920/videoWidth,1080/videoHeight);return{x:(1920-videoWidth*s)/2+(mirrored?1-x:x)*videoWidth*s,y:(1080-videoHeight*s)/2+y*videoHeight*s};}
// One writer owns pose and strike animation; all coordinates remain stage pixels.
class StickMotion{
 constructor(c,{allowTilt=false}={}){this.c=c;this.allowTilt=allowTilt;this.reset();}
 reset(){this.p={...this.c.anchor,angleDeg:this.c.angleDeg||0,visible:true};this.target={...this.p};this.start=-Infinity;this.snapshot=null;}
 input(p){
 if(Number.isFinite(p.x)&&Math.abs(p.x-this.target.x)>3)this.target.x=clamp(p.x,0,1920);
 if(Number.isFinite(p.y)&&Math.abs(p.y-this.target.y)>3)this.target.y=clamp(p.y,0,1080);
 this.target.angleDeg=(this.c.angleDeg||0)+(this.allowTilt&&Number.isFinite(p.angleDeg)?clamp(p.angleDeg,-12,12):0);
 if(typeof p.visible==='boolean'){this.target.visible=p.visible;if(!p.visible){this.start=-Infinity;this.snapshot=null;}}
 }
 strike(now){this.start=now;this.snapshot={...this.p};}
 tick(now,dt){const elapsed=now-this.start,active=elapsed>=0&&elapsed<260;
 if(!active){const f=1-Math.exp(-clamp(dt,0,.05)/.12);for(const k of ['x','y','angleDeg'])this.p[k]+=(this.target[k]-this.p[k])*f;}
 this.p.visible=this.target.visible;
 const q=active?Math.sin(Math.PI*elapsed/260):0,base=active?this.snapshot:this.p;
 // A short vertical stroke keeps the pre-painted perspective and heading stable.
 return {...base,y:base.y+q*70,visible:this.p.visible};
 }
}
function create(root,options){
 const {config,ui,assets={},onHit=()=>{},onComplete=()=>{},onCommand=()=>{}}=options;
 const logic=new Logic(config),svg=document.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 1920 1080');svg.classList.add('opera-drum');svg.setAttribute('aria-label','川剧锣鼓互动区');root.appendChild(svg);
 const make=(tag,attrs,parent=svg)=>{const el=document.createElementNS(NS,tag);Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,v));parent.appendChild(el);return el;};
 const drum=make('g',{'data-part':'drum'}),d=config.drum;make('image',{x:d.x,y:d.y,width:d.width,height:d.height,href:assets[d.file]||d.file},drum);
 const sticks={},groups={};for(const side of ['left','right']){const c=config.sticks[side];sticks[side]=new StickMotion(c,{allowTilt:!!options.allowTilt});groups[side]=make('g',{'data-side':side});make('image',{x:-c.width*c.pivotNormalized[0],y:-c.height*c.pivotNormalized[1],width:c.width,height:c.height,href:assets[c.file]||c.file},groups[side]);}
 const uiRoot=new DOMParser().parseFromString(ui,'image/svg+xml').documentElement;if(uiRoot.querySelector('parsererror'))throw Error('UI SVG无法解析');const overlay=make('g',{'data-part':'ui'});for(const el of Array.from(uiRoot.children))overlay.appendChild(document.importNode(el,true));
 const q=id=>overlay.querySelector('[id="'+id+'"]');
 const c=config.command,progressBar=make('rect',{x:c.x,y:c.y+c.height-5,height:5,width:0,fill:'#D7B57A'});
 const button=make('rect',{x:c.x,y:c.y,width:c.width,height:c.height,fill:'transparent',tabindex:0,role:'button','aria-label':'完成四拍后进入下一幕'});button.style.cursor='pointer';
 let destroyed=false,commandSent=false,raf,drumStart=-Infinity,lastFrame=performance.now();const guides=make('g',{display:'none','pointer-events':'none'});const dots={};for(const side of ['left','right'])dots[side]=make('circle',{r:10,fill:'#7ee5da',stroke:'#fff','stroke-width':2},guides);
 function updateUI(){for(let i=0;i<4;i++){q('beat-'+i)?.setAttribute('fill',i<logic.progress?'#873A2D':'#25251F');q('beat-'+i)?.setAttribute('stroke',i<logic.progress?'#D7B57A':'#777269');}q('command-label')?.setAttribute('opacity',logic.progress===4?'1':'.45');button.setAttribute('aria-disabled',logic.progress<4?'true':'false');if(q('command-note'))q('command-note').textContent=logic.progress===4?'进入区域停留1秒，前往水袖':'完成四拍后进入此区域';}
 function frame(){if(destroyed)return;const now=performance.now(),dt=(now-lastFrame)/1000;lastFrame=now;
 for(const side of ['left','right']){const p=sticks[side].tick(now,dt);groups[side].setAttribute('transform',`translate(${p.x} ${p.y}) rotate(${p.angleDeg})`);groups[side].setAttribute('visibility',p.visible?'visible':'hidden');dots[side].setAttribute('cx',p.x);dots[side].setAttribute('cy',p.y);}
 const t=now-drumStart;drum.setAttribute('transform',`translate(0 ${t>=0&&t<180?Math.sin(t/18)*2*(1-t/180):0})`);raf=requestAnimationFrame(frame);}
 function command(){if(logic.progress===4&&!commandSent){commandSent=true;onCommand({action:'next',from:'drum',to:'sleeves'});}}
 function key(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();command();}}
 button.addEventListener('click',command);button.addEventListener('keydown',key);updateUI();raf=requestAnimationFrame(frame);
 return {svg,config,
 setHand(side,p){if(!sticks[side])throw Error('side必须为left或right');sticks[side].input(p);},
 hit(side){const now=performance.now(),result=logic.hit(side,now);if(!result)return false;sticks[side].strike(now);drumStart=now;updateUI();onHit(result);if(result.correct&&result.progress===4)onComplete(result);return result;},
 setProgress(n){logic.progress=Math.max(0,Math.min(4,Math.floor(Number(n)||0)));logic.dwellStart=null;logic.latched=false;progressBar.setAttribute('width',0);updateUI();},
 updateCommandPointer(p){const r=logic.command(p,performance.now());progressBar.setAttribute('width',r.fraction*c.width);if(r.fire)command();return r;},
 isInCommandRegion(p){return p.x>=c.x&&p.x<=c.x+c.width&&p.y>=c.y&&p.y<=c.y+c.height;},
 setStatus(text){if(q('camera-status'))q('camera-status').textContent=text;},
 showAnchors(value){guides.setAttribute('display',value?'inline':'none');},
 clientToStage(x,y){const matrix=svg.getScreenCTM();if(!matrix)return null;return new DOMPoint(x,y).matrixTransform(matrix.inverse());},
 reset(){logic.reset();commandSent=false;for(const side of ['left','right']){sticks[side].reset();}progressBar.setAttribute('width',0);updateUI();},
 getProgress(){return logic.progress;},
 destroy(){destroyed=true;cancelAnimationFrame(raf);button.removeEventListener('click',command);button.removeEventListener('keydown',key);svg.remove();}
 };
}
const API={create,Logic,mapVideoPoint,StickMotion};global.OperaDrum=API;if(typeof module!=='undefined')module.exports=API;
})(typeof window==='undefined'?globalThis:window);
