/* Face mesh texture renderer. No detector, CDN, or extra camera. */
(function(g){
'use strict';
const D=g.OPERA_MESH_DATA;
const DEFAULTS={coverageX:1.055,coverageY:1.045,smoothingMs:32,lighting:.20,headScale:1.30,headOffsetY:0};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function mapPoint(p,w,h,mirror,W=1920,H=1080){const s=Math.min(W/w,H/h);return{x:(W-w*s)/2+(mirror?1-p.x:p.x)*w*s,y:(H-h*s)/2+p.y*h*s,z:(p.z||0)*w*s};}
function valid(lm){return Array.isArray(lm)&&lm.length>=468&&lm.slice(0,468).every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Number.isFinite(p.z));}
// Only expand the perimeter. The eye, nose and lip anchors stay put.
const weights=D.vertices.map(([x,y])=>{const r=Math.max(Math.abs(x)/7.7,Math.abs(y+.57)/8.8);return Math.pow(clamp((r-.47)/.53,0,1),2);});
for(const i of [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246,263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466])weights[i]=0;
function geometry(lm,w,h,mirror,settings=DEFAULTS){
 const p=lm.slice(0,468).map(q=>mapPoint(q,w,h,mirror)),c=p[168];
 const dx=p[454].x-p[234].x,dy=p[454].y-p[234].y,L=Math.hypot(dx,dy)||1,ux=dx/L,uy=dy/L;
 return p.map((q,i)=>{const x=q.x-c.x,y=q.y-c.y,u=x*ux+y*uy,v=-x*uy+y*ux;
  return{x:q.x+weights[i]*(u*(settings.coverageX-1)*ux-v*(settings.coverageY-1)*uy),y:q.y+weights[i]*(u*(settings.coverageX-1)*uy+v*(settings.coverageY-1)*ux),z:q.z};});
}
function create(settings={}){
 const config={...DEFAULTS,...settings};const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
 const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false,preserveDrawingBuffer:true});
 let lost=false,points=null,last=0,images=[],textures=[],index=-1;
 const api={canvas,config,available:!!gl,reason:gl?'':'浏览器未启用 WebGL',setImages,update,draw,clear,reset,dispose,getPoints:()=>points};
 if(!gl)return api;
 function shader(type,src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
 const program=gl.createProgram();
 const vs=shader(gl.VERTEX_SHADER,'attribute vec3 position;attribute vec2 uv;attribute float light;varying vec2 vUV;varying float vLight;void main(){gl_Position=vec4(position.x/960.0-1.0,1.0-position.y/540.0,position.z/1920.0,1.0);vUV=uv;vLight=light;}');
 const fs=shader(gl.FRAGMENT_SHADER,'precision mediump float;uniform sampler2D image;varying vec2 vUV;varying float vLight;void main(){vec4 c=texture2D(image,vUV);if(c.a<0.08)discard;gl_FragColor=vec4(c.rgb*vLight,c.a);}');
 gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
 gl.useProgram(program);gl.uniform1i(gl.getUniformLocation(program,'image'),0);
 const buffer=gl.createBuffer(),uvBuffer=gl.createBuffer(),lightBuffer=gl.createBuffer(),ib=gl.createBuffer();
 gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(D.triangles.flat()),gl.STATIC_DRAW);
 function attr(buf,name,size,data,usage){gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.bufferData(gl.ARRAY_BUFFER,data,usage);const a=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,size,gl.FLOAT,false,0,0);}
 gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.CULL_FACE);gl.clearColor(0,0,0,0);
 // No blending inside the surface: depth resolves front and rear triangles. The final 2D composite uses its alpha.
 canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();lost=true;api.available=false;api.reason='显卡上下文丢失，请刷新页面';});
 function setImages(list){images=list;if(!gl||lost)return;for(const t of textures)gl.deleteTexture(t);textures=list.map(im=>{const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,im);for(const key of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,key,gl.LINEAR);for(const key of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,key,gl.CLAMP_TO_EDGE);return t;});}
 function reset(){points=null;last=0;clear();}
 function clear(){if(gl&&!lost)gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
 function update(lm,w,h,mirror,now=performance.now()){
  if(!valid(lm)||!(w>0&&h>0)){reset();return false;}
  const next=geometry(lm,w,h,mirror,config),dt=now-last;
  const jump=points?Math.hypot(next[1].x-points[1].x,next[1].y-points[1].y):Infinity;
  const alpha=!points||dt>250||jump>180?1:1-Math.exp(-Math.max(1,dt)/config.smoothingMs);
  points=next.map((p,i)=>{const old=points&&points[i];return old?{x:old.x+(p.x-old.x)*alpha,y:old.y+(p.y-old.y)*alpha,z:old.z+(p.z-old.z)*alpha}:p;});last=now;return true;
 }
 function draw(maskIndex){
  clear();if(!gl||lost||!points||!textures[maskIndex])return false;
  gl.useProgram(program);gl.viewport(0,0,canvas.width,canvas.height);
  attr(buffer,'position',3,new Float32Array(points.flatMap(p=>[p.x,p.y,p.z])),gl.DYNAMIC_DRAW);
  if(index!==maskIndex){attr(uvBuffer,'uv',2,new Float32Array(D.uvs[maskIndex].flat()),gl.STATIC_DRAW);index=maskIndex;}
  // Area-weighted normals reconstructed in the same pixel metric (z scales with video width).
  const normals=points.map(()=>[0,0,0]);
  for(const [a,b,c] of D.triangles){const A=points[a],B=points[b],C=points[c],u=[B.x-A.x,B.y-A.y,B.z-A.z],v=[C.x-A.x,C.y-A.y,C.z-A.z];let n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];if(n[2]>0)n=n.map(x=>-x);for(const i of [a,b,c])for(let j=0;j<3;j++)normals[i][j]+=n[j];}
  const lights=normals.map(n=>{const l=Math.hypot(...n)||1;const diffuse=clamp((-.25*n[0]-.35*n[1]-.903*n[2])/l,0,1);return 1-config.lighting*(1-diffuse);});
  attr(lightBuffer,'light',1,new Float32Array(lights),gl.DYNAMIC_DRAW);
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,textures[maskIndex]);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.drawElements(gl.TRIANGLES,D.triangles.length*3,gl.UNSIGNED_SHORT,0);
  return true;
 }
 function dispose(){reset();if(!gl||lost)return;for(const t of textures)gl.deleteTexture(t);for(const b of [buffer,uvBuffer,lightBuffer,ib])gl.deleteBuffer(b);gl.deleteProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);}
 return api;
}
function synthetic(yaw=0,pitch=0,roll=0){const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch),cr=Math.cos(roll),sr=Math.sin(roll);return D.vertices.map(([x,y,z])=>{let X=x*cy+z*sy,Z=-x*sy+z*cy,Y=y*cp-Z*sp;Z=y*sp+Z*cp;let xx=X*cr-Y*sr,yy=X*sr+Y*cr;const perspective=65/(65-Z);return{x:.5+xx*perspective*.018,y:.58-yy*perspective*.032,z:-Z*.018};});}
function safeCreate(settings={}){try{return create(settings);}catch(e){console.warn('Face mesh initialization failed:',e);return{config:{...DEFAULTS,...settings},available:false,reason:e.message,setImages(){},update(){return false;},draw(){return false;},clear(){},reset(){},dispose(){},getPoints(){return null;}};}}
g.OperaFaceMesh={create:safeCreate,geometry,mapPoint,valid,synthetic,defaults:DEFAULTS};if(typeof module!=='undefined')module.exports=g.OperaFaceMesh;
})(typeof window!=='undefined'?window:globalThis);
