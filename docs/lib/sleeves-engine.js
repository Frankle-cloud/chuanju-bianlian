/* 入戏 · 二维实时骨骼与水袖组件。无依赖，坐标输入与摄像头识别解耦。 */
(function(global){
'use strict';
const SIDES=['left','right'],clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const point=a=>({x:a[0],y:a[1]}),sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y}),add=(a,b)=>({x:a.x+b.x,y:a.y+b.y}),mul=(a,s)=>({x:a.x*s,y:a.y*s}),len=a=>Math.hypot(a.x,a.y),dist=(a,b)=>len(sub(a,b)),mix=(a,b,t)=>add(mul(a,1-t),mul(b,t)),angle=(a,b)=>Math.atan2(b.y-a.y,b.x-a.x),rot=(p,a)=>({x:p.x*Math.cos(a)-p.y*Math.sin(a),y:p.x*Math.sin(a)+p.y*Math.cos(a)}),wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const good=(p,min=.55)=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&(p.visibility??1)>=min;
function mapVideoPoint(p,w,h,mirror=false){if(!(w>0&&h>0))throw Error('视频尺寸无效');const s=Math.min(1920/w,1080/h);return{x:(1920-w*s)/2+(mirror?1-p.x:p.x)*w*s,y:(1080-h*s)/2+p.y*h*s,visibility:p.visibility??1};}
/* 将人体左右按相同镜像规则转换为稳定的画面左右；交叉手时不重新排序。 */
function fromLandmarks(lm,{width=640,height=480,mirror=true}={}){if(!lm||lm.length<17||![11,12,13,14,15,16].every(i=>good(lm[i],0)))return null;const m=i=>mapVideoPoint(lm[i],width,height,mirror);const a={shoulder:m(11),elbow:m(13),wrist:m(15)},b={shoulder:m(12),elbow:m(14),wrist:m(16)};return mirror?{left:a,right:b}:{left:b,right:a};}
class GestureLogic{
 constructor(rig){this.rig=rig;this.reset();}
 reset(){this.step=0;this.holdSince=null;this.raised=false;this.commandSince=null;this.commandSent=false;}
 lose(){this.holdSince=null;this.raised=false;}
 update(pose,now,blocked=false){if(blocked||!pose||!SIDES.every(s=>['shoulder','elbow','wrist'].every(k=>good(pose[s]?.[k],this.rig.confidence)))){this.lose();return false;}const l=pose.left,r=pose.right,span=dist(l.shoulder,r.shoulder);if(span<20){this.lose();return false;}let pass=false;if(this.step===0){pass=l.wrist.x<l.shoulder.x-.55*span&&r.wrist.x>r.shoulder.x+.55*span&&Math.abs(l.wrist.y-l.shoulder.y)<.5*span&&Math.abs(r.wrist.y-r.shoulder.y)<.5*span;}else if(this.step===1){if(l.wrist.y<l.shoulder.y-.35*span&&r.wrist.y<r.shoulder.y-.35*span){if(this.holdSince===null)this.holdSince=now;if(now-this.holdSince>=300){this.raised=true;this.holdSince=null;}}else if(!this.raised)this.holdSince=null;if(this.raised)pass=l.wrist.y>l.shoulder.y+.25*span&&r.wrist.y>r.shoulder.y+.25*span;}
 if(pass){if(this.holdSince===null)this.holdSince=now;if(now-this.holdSince>=this.rig.gestureHoldMs){this.step++;this.holdSince=null;this.raised=false;return true;}}else if(this.step===0||this.raised)this.holdSince=null;return false;}
 inCommand(p){const c=this.rig.command;return good(p,0)&&p.x>=c.x&&p.x<=c.x+c.width&&p.y>=c.y&&p.y<=c.y+c.height;}
 command(p,now){if(!p?.active||!this.inCommand(p)||this.step<2){this.commandSince=null;return{fraction:0,fire:false};}if(this.commandSent)return{fraction:1,fire:false};if(this.commandSince===null)this.commandSince=now;const fraction=clamp((now-this.commandSince)/this.rig.command.dwellMs,0,1),fire=fraction>=1;if(fire)this.commandSent=true;return{fraction,fire};}
}
class Arm{
 constructor(part){this.sign=part.shoulder[0]<768?1:-1;this.bind={shoulder:point(part.shoulder),elbow:point(part.elbow),wrist:point(part.wrist)};this.lengths=[dist(this.bind.shoulder,this.bind.elbow),dist(this.bind.elbow,this.bind.wrist)];this.rest=[angle(this.bind.shoulder,this.bind.elbow),angle(this.bind.elbow,this.bind.wrist)];this.current=this.limit(this.rest);this.target=[...this.rest];this.solve();}
 solve(){this.shoulder={...this.bind.shoulder};this.elbow=add(this.shoulder,rot({x:this.lengths[0],y:0},this.current[0]));this.wrist=add(this.elbow,rot({x:this.lengths[1],y:0},this.current[1]));}
 limit(a){const base=this.sign===1?Math.PI:0;const upper=base+clamp(wrap(a[0]-base),-100*Math.PI/180,100*Math.PI/180);const bend=clamp(this.sign*wrap(a[1]-a[0]),0,145*Math.PI/180);return[upper,upper+this.sign*bend];}
 input(p){const u=dist(p.shoulder,p.elbow),v=dist(p.elbow,p.wrist);if(u<12||v<12||u/v>3||v/u>3)return;
 const next=this.limit([angle(p.shoulder,p.elbow),angle(p.elbow,p.wrist)]);
 // Angular deadband: genuine slow movement accumulates against the held target.
 for(let i=0;i<2;i++)if(Math.abs(wrap(next[i]-this.target[i]))>3*Math.PI/180)this.target[i]=next[i];
 this.target=this.limit(this.target);
 }
 tick(dt,tau){dt=clamp(dt,0,.05);const t=1-Math.exp(-dt*1000/Math.max(tau,120));this.target=this.limit(this.target);for(let i=0;i<2;i++)this.current[i]+=clamp(wrap(this.target[i]-this.current[i])*t,-dt*3.5,dt*3.5);this.current=this.limit(this.current);this.solve();}
 deform(p){const a=this.bind,delta0=wrap(this.current[0]-this.rest[0]),delta1=wrap(this.current[1]-this.rest[1]);const upper=add(this.shoulder,rot(sub(p,a.shoulder),delta0)),lower=add(this.elbow,rot(sub(p,a.elbow),delta1));const v=sub(a.wrist,a.shoulder),t=((p.x-a.shoulder.x)*v.x+(p.y-a.shoulder.y)*v.y)/(v.x*v.x+v.y*v.y),at=this.lengths[0]/(this.lengths[0]+this.lengths[1]),w=clamp((t-at+.12)/.24,0,1);return mix(upper,lower,w*w*(3-2*w));}
}
class Cloth{
 constructor(rows,settings){this.settings=settings;const original=rows.map(r=>r.map(point));this.sourceRows=[];for(let i=0;i<original.length-1;i++)for(let j=0;j<3;j++)this.sourceRows.push([mix(original[i][0],original[i+1][0],j/3),mix(original[i][1],original[i+1][1],j/3)]);this.sourceRows.push(original.at(-1));this.centers=this.sourceRows.map(r=>mix(r[0],r[1],.5));this.rest=this.centers.slice(1).map((p,i)=>dist(p,this.centers[i]));this.reset();}
 reset(){this.quietFor=0;this.sleeping=false;this.lastRoot=null;this.nodes=this.centers.map(p=>({...p}));this.previous=this.centers.map(p=>({...p}));}
 tick(root,dt){
 if(this.lastRoot&&dist(root,this.lastRoot)<.7)this.quietFor+=dt;else{this.quietFor=0;this.sleeping=false;this.lastRoot={...root};}
 if(!this.lastRoot)this.lastRoot={...root};
 if(this.quietFor>1.2){this.sleeping=true;this.previous=this.nodes.map(p=>({...p}));return;}
 let n=this.nodes,pr=this.previous,s=this.settings;const old={...n[0]};n[0]={...root};pr[0]={...root};if(dist(old,root)>300){const delta=sub(root,old);for(let i=1;i<n.length;i++){n[i]=add(n[i],delta);pr[i]=add(pr[i],delta);}}
 const damping=Math.pow(s.damping,dt*60);for(let i=1;i<n.length;i++){const current={...n[i]},velocity=mul(sub(n[i],pr[i]),damping);n[i]=add(add(n[i],velocity),{x:0,y:s.gravity*dt*dt});pr[i]=current;}
 for(let k=0;k<s.iterations;k++){n[0]={...root};for(let i=1;i<n.length;i++){let delta=sub(n[i],n[i-1]),d=len(delta)||.001,error=(d-this.rest[i-1])/d;if(i===1)n[i]=sub(n[i],mul(delta,error));else{n[i-1]=add(n[i-1],mul(delta,.5*error));n[i]=sub(n[i],mul(delta,.5*error));}}}
 // 限制相邻段过度反折，避免袖子快速动作后卷成硬角。
 let previousAngle=Math.PI/2;for(let i=1;i<n.length;i++){const raw=angle(n[i-1],n[i]),limit=i===1?1.3:.42,a=previousAngle+clamp(wrap(raw-previousAngle),-limit,limit);n[i]=add(n[i-1],rot({x:this.rest[i-1],y:0},a));previousAngle=a;}
 }
 rows(arm){const d=wrap(arm.current[1]-arm.rest[1]);return this.sourceRows.map((row,i)=>{let rotation=d;if(i>0){const original=angle(this.centers[i-1],this.centers[i]),current=angle(this.nodes[i-1],this.nodes[i]);rotation=wrap(current-original);}return row.map(p=>add(this.nodes[i],rot(sub(p,this.centers[i]),rotation)));});}
}
// 仿射纹理三角形；接缝外扩极小距离，避免抗锯齿白线。
function triangle(ctx,img,s,d){const den=s[0].x*(s[1].y-s[2].y)+s[1].x*(s[2].y-s[0].y)+s[2].x*(s[0].y-s[1].y);if(Math.abs(den)<1e-5)return;const coeff=k=>[(d[0][k]*(s[1].y-s[2].y)+d[1][k]*(s[2].y-s[0].y)+d[2][k]*(s[0].y-s[1].y))/den,(d[0][k]*(s[2].x-s[1].x)+d[1][k]*(s[0].x-s[2].x)+d[2][k]*(s[1].x-s[0].x))/den,(d[0][k]*(s[1].x*s[2].y-s[2].x*s[1].y)+d[1][k]*(s[2].x*s[0].y-s[0].x*s[2].y)+d[2][k]*(s[0].x*s[1].y-s[1].x*s[0].y))/den];const x=coeff('x'),y=coeff('y'),center=mul(add(add(d[0],d[1]),d[2]),1/3);ctx.save();ctx.beginPath();d.forEach((p,i)=>{const v=sub(p,center),q=add(p,mul(v,.85/(len(v)||1)));i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);});ctx.closePath();ctx.clip();ctx.transform(x[0],y[0],x[1],y[1],x[2],y[2]);const sx=Math.max(0,Math.floor(Math.min(...s.map(p=>p.x)))-2),sy=Math.max(0,Math.floor(Math.min(...s.map(p=>p.y)))-2),sw=Math.min(img.width-sx,Math.ceil(Math.max(...s.map(p=>p.x)))-sx+2),sh=Math.min(img.height-sy,Math.ceil(Math.max(...s.map(p=>p.y)))-sy+2);if(sw>0&&sh>0)ctx.drawImage(img,sx,sy,sw,sh,sx,sy,sw,sh);ctx.restore();}
function gridTriangles(bounds,cols=6,rows=5){const[x,y,w,h]=bounds,out=[];for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){const a={x:x+w*i/cols,y:y+h*j/rows},b={x:x+w*(i+1)/cols,y:a.y},c={x:b.x,y:y+h*(j+1)/rows},d={x:a.x,y:c.y};out.push([a,b,c],[a,c,d]);}return out;}
function drawCloth(ctx,img,cloth,dest){for(let j=0;j<dest.length-1;j++)for(let i=0;i<2;i++){const u=i/2,v=(i+1)/2,s=[mix(...cloth.sourceRows[j],u),mix(...cloth.sourceRows[j],v),mix(...cloth.sourceRows[j+1],v),mix(...cloth.sourceRows[j+1],u)],d=[mix(...dest[j],u),mix(...dest[j],v),mix(...dest[j+1],v),mix(...dest[j+1],u)];triangle(ctx,img,[s[0],s[1],s[2]],[d[0],d[1],d[2]]);triangle(ctx,img,[s[0],s[2],s[3]],[d[0],d[2],d[3]]);}}
async function create(root,{rig,ui,image,onProgress=()=>{},onComplete=()=>{},onCommand=()=>{}}){
 const wrapEl=document.createElement('div');wrapEl.className='opera-sleeves';wrapEl.innerHTML='<canvas aria-label="实时骨骼水袖演员"></canvas><div class="sleeves-ui"></div><button class="sleeves-command" aria-label="下一幕：变脸与吐火" disabled></button><div class="sleeves-dwell"></div>';root.appendChild(wrapEl);const canvas=wrapEl.querySelector('canvas'),ctx=canvas.getContext('2d'),uiHost=wrapEl.querySelector('.sleeves-ui');uiHost.innerHTML=ui;const btn=wrapEl.querySelector('button'),bar=wrapEl.querySelector('.sleeves-dwell'),q=id=>uiHost.querySelector('[id="'+id+'"]');const img=new Image();img.src=image||rig.source.file;try{await img.decode();}catch(e){wrapEl.remove();throw Error('人物素材加载失败：'+e.message);}
 const arms={},cloths={},textures={},meshes={};for(const side of SIDES){const part=rig.parts[side];arms[side]=new Arm(part);cloths[side]=new Cloth(part.sleeveRows,rig.cloth);const cv=document.createElement('canvas');cv.width=1536;cv.height=1024;const cx=cv.getContext('2d');cx.clip(new Path2D(part.path));cx.drawImage(img,0,0);textures[side]=cv;meshes[side]=gridTriangles(part.bounds);}
 const body=document.createElement('canvas');body.width=1536;body.height=1024;const bc=body.getContext('2d');bc.clip(new Path2D(rig.parts.body.path));bc.drawImage(img,0,0);
 const logic=new GestureLogic(rig);let inputProvider=null,latest=null,lastPose=-Infinity,last=performance.now(),accum=0,raf,destroyed=false,debug=false,fit={scale:.55,x:540,y:360},lastTransform=fit,commandPointer=null,sourceLabel='等待动作输入',lastStatus='',emittedComplete=false;
 const commandRegion=rig.command;Object.assign(btn.style,{left:commandRegion.x/19.2+'%',top:commandRegion.y/10.8+'%',width:commandRegion.width/19.2+'%',height:commandRegion.height/10.8+'%'});Object.assign(bar.style,{left:commandRegion.x/19.2+'%',top:(commandRegion.y+commandRegion.height-5)/10.8+'%',height:5/10.8+'%'});
 const resize=()=>{const rect=root.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.max(1,Math.round(rect.width*dpr));canvas.height=Math.max(1,Math.round(rect.width*1080/1920*dpr));};const ro=new ResizeObserver(resize);ro.observe(root);resize();
 function uiUpdate(){for(let i=0;i<2;i++){q('step-'+i)?.setAttribute('fill',logic.step>i?'#873A2D':'none');q('step-'+i)?.setAttribute('stroke-opacity',logic.step>=i?'1':'.4');}const title=logic.step===0?'向两侧舒展双臂':logic.step===1?'双手抬起，再缓缓放下':'随心挥袖，感受流动';q('action-title').textContent=title;q('action-description').textContent=logic.step===2?'引导已完成 · 可继续体验，或前往下一幕':'保持坐姿 · 肩、肘与双手进入镜头';q('command-note').textContent=logic.step===2?'手进入此区域，停留1秒':'完成两项动作后解锁';q('command-label').setAttribute('opacity',logic.step===2?'1':'.4');btn.disabled=logic.step<2;}
 function fire(){onCommand({action:'next',from:'sleeves',to:'face-fire'});}
 const click=()=>{if(logic.step===2&&!logic.commandSent){logic.commandSent=true;fire();}};btn.addEventListener('click',click);
 function status(s){if(s!==lastStatus){q('camera-status').textContent=s;lastStatus=s;}}
 function acceptPose(pose){const now=performance.now();latest=pose;if(pose&&SIDES.every(s=>['shoulder','elbow','wrist'].every(k=>good(pose[s]?.[k],rig.confidence))))lastPose=now;for(const s of SIDES)if(pose&&['shoulder','elbow','wrist'].every(k=>good(pose[s]?.[k],rig.confidence)))arms[s].input(pose[s]);else logic.lose();}
 function frame(){const now=performance.now();if(destroyed)return;const began=performance.now();if(inputProvider){const p=inputProvider(now);if(p!==undefined)acceptPose(p);}const dt=Math.min((now-last)/1000,.05);last=now;const fresh=performance.now()-lastPose<rig.poseTimeoutMs,valid=fresh&&latest&&SIDES.every(s=>['shoulder','elbow','wrist'].every(k=>good(latest[s]?.[k],rig.confidence)));const pointer=commandPointer&&now-commandPointer.time<rig.poseTimeoutMs?commandPointer:null,blocked=pointer?.active&&logic.inCommand(pointer);
 if(!valid){logic.lose();if(now-lastPose>rig.lossHoldMs)for(const s of SIDES)arms[s].target=[...arms[s].rest];status(Number.isFinite(lastPose)?'请让肩、肘、腕重新入镜':sourceLabel);}else{if(logic.update(latest,now,blocked)){uiUpdate();onProgress({completed:logic.step,total:2});if(logic.step===2&&!emittedComplete){emittedComplete=true;onComplete();}}status(sourceLabel);}
 canvas.dataset.inputFresh=String(fresh);canvas.dataset.inputValid=String(!!valid);canvas.dataset.inputAge=String(Math.round(performance.now()-lastPose));
 const cmd=logic.command(pointer,now);bar.style.width=commandRegion.width/19.2*cmd.fraction+'%';if(cmd.fire)fire();
 for(const s of SIDES)arms[s].tick(dt,valid?rig.smoothingMs:rig.lossReturnMs);
 accum+=dt;const h=1/rig.cloth.substepsHz;while(accum>=h){for(const s of SIDES){const arm=arms[s],cloth=cloths[s],root=add(arm.wrist,rot(sub(cloth.centers[0],arm.bind.wrist),wrap(arm.current[1]-arm.rest[1])));cloth.tick(root,h);}accum-=h;}
 const rows={},points=[{x:566,y:18},{x:986,y:946}];for(const s of SIDES){rows[s]=cloths[s].rows(arms[s]);points.push(...rows[s].flat(),...meshes[s].flat().map(p=>arms[s].deform(p)));}const bounds={minX:Math.min(...points.map(p=>p.x))-20,maxX:Math.max(...points.map(p=>p.x))+20,minY:Math.min(...points.map(p=>p.y))-20,maxY:Math.max(...points.map(p=>p.y))+20},safe=rig.safeArea,desired=Math.min(.6,safe.width/(bounds.maxX-bounds.minX),safe.height/(bounds.maxY-bounds.minY));// Lock body center; only shrink if necessary. No repeated zoom-in/recentering from sleeve sway.
 const anchor={x:776,y:482},center={x:safe.x+safe.width/2,y:safe.y+safe.height/2};
 const needed=Math.min(.55,(safe.width/2)/Math.max(anchor.x-bounds.minX,bounds.maxX-anchor.x),(safe.height/2)/Math.max(anchor.y-bounds.minY,bounds.maxY-anchor.y));
 fit.scale=Math.min(fit.scale,needed);fit.x=center.x-anchor.x*fit.scale;fit.y=center.y-anchor.y*fit.scale;
 lastTransform={...fit};
 ctx.setTransform(canvas.width/1920,0,0,canvas.height/1080,0,0);ctx.clearRect(0,0,1920,1080);ctx.save();ctx.translate(fit.x,fit.y);ctx.scale(fit.scale,fit.scale);for(const s of SIDES)drawCloth(ctx,img,cloths[s],rows[s]);for(const s of SIDES)for(const tri of meshes[s])triangle(ctx,textures[s],tri,tri.map(p=>arms[s].deform(p)));ctx.drawImage(body,0,0);
 if(debug){ctx.lineWidth=4/fit.scale;for(const s of SIDES){ctx.strokeStyle=s==='left'?'#65efce':'#ffbf6b';ctx.beginPath();[arms[s].shoulder,arms[s].elbow,arms[s].wrist].forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();for(const p of [arms[s].shoulder,arms[s].elbow,arms[s].wrist]){ctx.beginPath();ctx.arc(p.x,p.y,7/fit.scale,0,Math.PI*2);ctx.fillStyle=ctx.strokeStyle;ctx.fill();}}}ctx.restore();canvas.dataset.bounds=JSON.stringify({left:bounds.minX*fit.scale+fit.x,right:bounds.maxX*fit.scale+fit.x,top:bounds.minY*fit.scale+fit.y,bottom:bounds.maxY*fit.scale+fit.y});canvas.dataset.renderMs=String(Math.round(performance.now()-began));raf=requestAnimationFrame(frame);}
 uiUpdate();raf=requestAnimationFrame(frame);
 return {element:wrapEl,canvas,
 setPose:acceptPose,
 setInputProvider(fn){inputProvider=fn;},
 setLandmarks(lm,options){this.setPose(fromLandmarks(lm,options));},
 updateCommandPointer(p){commandPointer=p?.active?{...p,time:performance.now()}:null;},
 setSourceLabel(s){sourceLabel=s;},
 showSkeleton(v){debug=!!v;},
 getProgress(){return logic.step;},
 getJointPositions(){const out={};for(const s of SIDES){out[s]={};for(const k of ['shoulder','elbow','wrist'])out[s][k]={x:arms[s][k].x*lastTransform.scale+lastTransform.x,y:arms[s][k].y*lastTransform.scale+lastTransform.y};}return out;},
 clientToStage(x,y){const r=canvas.getBoundingClientRect();return{x:(x-r.left)*1920/r.width,y:(y-r.top)*1080/r.height};},
 reset(){logic.reset();latest=null;lastPose=-Infinity;commandPointer=null;emittedComplete=false;fit.scale=.55;for(const s of SIDES){arms[s].target=[...arms[s].rest];arms[s].current=[...arms[s].rest];arms[s].solve();cloths[s].reset();}uiUpdate();},
 destroy(){destroyed=true;cancelAnimationFrame(raf);ro.disconnect();btn.removeEventListener('click',click);wrapEl.remove();}
 };
}
const API={create,fromLandmarks,mapVideoPoint,GestureLogic,Arm,Cloth};global.OperaSleeves=API;if(typeof module!=='undefined')module.exports=API;
})(typeof window==='undefined'?globalThis:window);
