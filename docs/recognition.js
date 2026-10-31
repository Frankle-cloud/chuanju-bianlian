// recognition.js — 三幕手势识别（外壳侧）
//
// 在 iframe 外壳（index.html）里跑唯一一路摄像头 + 浏览器端 MediaPipe，
// 每帧把「组件就绪」的数据 postMessage 给当前激活的那一幕 iframe。
// 各幕 iframe 内再加一个 message 监听器，把数据喂给各自的组件。
//
// 加载/检测循环复用 舞台/opera_stage/opera_app.js 的模式（GPU 优先 CPU 回退、
// 视频缩到 640 宽再检测、rAF + currentTime 判重）。
//
// 本模块只做「识别」：锣鼓的抬手→下敲、变脸的捏合/张开与指令手判定都在这里；
// 水袖的展袖/扬袖、变脸的挥掌/喷火状态机仍在各组件内部。
import { FilesetResolver, FaceLandmarker, HandLandmarker, PoseLandmarker } from './lib/vision_bundle.mjs';

// ===== 配置 =====
const WASM_DIR = './lib/wasm';
const MODELS = {
  face: 'models/face_landmarker.task',
  hand: 'models/hand_landmarker.task',
  pose: 'models/pose_landmarker.task',
};
const DETECT_W = 800;   // 检测用缩小宽度（越小越快，宽高比保持；捏合是精细动作，800 更稳）
const MIRROR = true;    // 自拍镜像

// 锣鼓「下一幕」指令区（与 act1-drum.html 的 DATA.config.command 一致）
const DRUM_COMMAND = { x: 1560, y: 804, width: 280, height: 88 };

// 锣鼓敲击判定：抬手→下敲由 StrokeDetector 完成，阈值按手掌宽自适应（见下方工具段）。

// 变脸手势（阈值沿用组件内置：捏合<0.28、张开>0.42；此处只算数值）
const OPEN_PALM_MIN_FINGERS = 3; // 四指中至少几根伸直算「张开手掌」

// 时序平滑（EMA）：压低逐帧抖动，避免手势在阈值附近来回跳导致漏触发。
const SMOOTH_HAND = 0.55; // 手部 landmark 平滑系数
const SMOOTH_FACE = 0.5;  // 人脸 landmark 平滑系数

// 锣鼓抬手→下敲判定（移植自设计同学 drum-tracking-adapter.js 的 StrokeDetector）。
// 输入为设计坐标 y 与设计像素手掌宽；带抬升武装、下落触发、冷却与丢手复位。
class StrokeDetector {
  constructor() { this.reset(); }
  reset() { this.last = null; this.top = null; this.base = null; this.armed = false; this.armTime = null; this.coolUntil = -Infinity; }
  update(p, now) {
    if (!p || p.confidence < 0.7 || !Number.isFinite(p.y) || !Number.isFinite(p.palmWidth) || p.palmWidth < 8) { this.reset(); return false; }
    if (this.last === null || now - this.last > 300) { this.reset(); this.last = now; this.base = this.top = p.y; return false; }
    this.last = now;
    const lift = Math.max(25, p.palmWidth * 0.35), drop = Math.max(30, p.palmWidth * 0.45);
    if (!this.armed) { this.base = Math.max(this.base, p.y); if (now >= this.coolUntil && this.base - p.y >= lift) { this.armed = true; this.top = p.y; this.armTime = now; } return false; }
    if (p.y < this.top) { this.top = p.y; this.armTime = now; }
    if (p.y - this.top >= drop) { const elapsed = now - this.armTime; this.armed = false; this.base = p.y; this.coolUntil = now + 300; return elapsed >= 60 && elapsed <= 650; }
    return false;
  }
}

// ===== 状态 =====
let faceLandmarker = null, handLandmarker = null, poseLandmarker = null;
let video = null, detCv = null, dctx = null;
let stream = null;
let running = false;
let lastVideoTime = -1;
const drumStrokes = { left: new StrokeDetector(), right: new StrokeDetector() };
const handSmooth = new Map(); // 手 id -> Float32Array(63)（21 点 xyz）
const faceSmooth = { active: false, leftEye: null, rightEye: null, mouth: null };

const statusEl = () => document.getElementById('cam-status');

// ===== 几何工具 =====
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// 手掌中心：腕(0) + 四指掌骨(5/9/13/17) 均值，比单用腕更稳。
function palmCenter(lm) {
  let x = 0, y = 0;
  for (const i of [0, 5, 9, 13, 17]) { x += lm[i].x; y += lm[i].y; }
  return { x: x / 5, y: y / 5 };
}

// 归一化(0~1) → 1920×1080 设计坐标：contain 居中（黑边）+ 可选镜像（只翻 x）。
// 与三个组件的 mapVideoPoint 完全一致。
function mapVideoPoint(x, y, vw, vh, mirrored) {
  const s = Math.min(1920 / vw, 1080 / vh);
  return {
    x: (1920 - vw * s) / 2 + (mirrored ? 1 - x : x) * vw * s,
    y: (1080 - vh * s) / 2 + y * vh * s,
  };
}

function isInRegion(p, r) {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

// MediaPipe handedness 是解剖左右（"Left"/"Right"）；自拍镜像后解剖左手在画面左侧。
// 返回稳定画面身份 side（'left'/'right'），未知返回 null。
function handednessToSide(categoryName) {
  if (categoryName === 'Left') return MIRROR ? 'left' : 'right';
  if (categoryName === 'Right') return MIRROR ? 'right' : 'left';
  return null;
}

// 手掌宽度：食指根(5)到小指根(17)欧氏距离，先按原图像素计算再除以视频宽（归一化）。
function palmWidthNormalized(lm, vw, vh) {
  return dist({ x: lm[5].x * vw, y: lm[5].y * vh }, { x: lm[17].x * vw, y: lm[17].y * vh }) / vw;
}

// ===== 手势特征 =====
// 捏合比：食指尖(8)到拇指尖(4)的距离 / 食指根(5)到小指根(17)的距离，越小越紧。
function pinchRatio(lm) {
  return dist(lm[4], lm[8]) / (dist(lm[5], lm[17]) || 1e-6);
}

function fingerExtended(lm, tip, pip, mcp) {
  return dist(lm[tip], lm[mcp]) > dist(lm[pip], lm[mcp]) * 1.3;
}

// 张开手掌：四指（食/中/无名/小指）伸直判定，至少 OPEN_PALM_MIN_FINGERS 根算开掌。
// 用 MCP 指根作参考（比腕距离更稳）：伸直时 tip→mcp 约为 pip→mcp 的 ~2 倍。
function openPalm(lm) {
  const fingers = [[8, 6, 5], [12, 10, 9], [16, 14, 13], [20, 18, 17]];
  let n = 0;
  for (const [tip, pip, mcp] of fingers) if (fingerExtended(lm, tip, pip, mcp)) n++;
  return n >= OPEN_PALM_MIN_FINGERS;
}

// 人脸眼心 = 外内眼角中点；口部取上/下唇中点。
function mid(lm, i, j) { return { x: (lm[i].x + lm[j].x) / 2, y: (lm[i].y + lm[j].y) / 2 }; }

// ===== 平滑工具 =====
function flatten(lm) {
  const a = new Float32Array(63);
  for (let i = 0; i < 21; i++) { a[i * 3] = lm[i].x; a[i * 3 + 1] = lm[i].y; a[i * 3 + 2] = lm[i].z; }
  return a;
}
function unflatten(a) {
  const lm = [];
  for (let i = 0; i < 21; i++) lm.push({ x: a[i * 3], y: a[i * 3 + 1], z: a[i * 3 + 2] });
  return lm;
}
function smoothArr(prev, next, k) {
  if (!prev || prev.length !== 63) return next.slice();
  const out = new Float32Array(63);
  for (let i = 0; i < 63; i++) out[i] = prev[i] + (next[i] - prev[i]) * k;
  return out;
}
function smoothPt(prev, next, k) {
  if (!prev) return next;
  return { x: prev.x + (next.x - prev.x) * k, y: prev.y + (next.y - prev.y) * k };
}

// ===== 模型 / 摄像头 =====
async function createWithDelegate(make, modelPath, opts) {
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return await make({ ...opts, baseOptions: { modelAssetPath: modelPath, delegate } });
    } catch (e) { /* 换下一个 delegate */ }
  }
  throw new Error('模型加载失败（GPU/CPU 均不可用）：' + modelPath);
}

async function initModels() {
  const vision = await FilesetResolver.forVisionTasks(WASM_DIR);
  faceLandmarker = await createWithDelegate(
    (o) => FaceLandmarker.createFromOptions(vision, o), MODELS.face,
    { runningMode: 'VIDEO', numFaces: 1 });
  handLandmarker = await createWithDelegate(
    (o) => HandLandmarker.createFromOptions(vision, o), MODELS.hand,
    { runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.5 });
  poseLandmarker = await createWithDelegate(
    (o) => PoseLandmarker.createFromOptions(vision, o), MODELS.pose,
    { runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: 0.5 });
}

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

// ===== 发送 =====
function postTo(iframeId, data) {
  const el = document.getElementById(iframeId);
  if (el && el.contentWindow) el.contentWindow.postMessage(data, '*');
}

// ===== 音效 =====
// 击鼓：左/右手用不同采样，在父页面播放（父页面已被「开始体验」点击激活，规避 iframe 自动播放拦截）。
const drumHitAudios = {
  left: new Audio('sounds/drum_hit.wav'),
  right: new Audio('sounds/drum_hit_right.wav'),
};
function playDrumHit(side) {
  const a = drumHitAudios[side] || drumHitAudios.left;
  try { a.currentTime = 0; } catch (e) {}
  a.play().catch(() => {});
}

// ===== 每幕处理 =====
function processDrum(vw, vh) {
  injectStream('if-act1');
  const now = performance.now();
  const handResult = handLandmarker.detectForVideo(detCv, now);
  const lms = (handResult && handResult.landmarks) || [];
  const hands = [], hits = [];
  let command = { x: 0, y: 0, active: false };
  const scale = Math.min(1920 / vw, 1080 / vh);

  // 平滑后再算掌心/手掌宽/置信度（与变脸幕一致，避免鼓棒逐帧抖动）
  const seen = new Set();
  const detected = [];
  for (let i = 0; i < lms.length; i++) {
    const hlm = lms[i];
    const hlist = handResult.handedness || handResult.handednesses;
    const hc = hlist && hlist[i] && hlist[i][0];
    const id = hc ? hc.categoryName : ('hand' + i);
    seen.add(id);
    const sm = smoothArr(handSmooth.get(id), flatten(hlm), SMOOTH_HAND);
    handSmooth.set(id, sm);
    const lm = unflatten(sm);
    const pc = palmCenter(lm);
    detected.push({
      p: mapVideoPoint(pc.x, pc.y, vw, vh, MIRROR),
      side: handednessToSide(hc && hc.categoryName),
      confidence: hc ? hc.score : 0,
      pw: palmWidthNormalized(lm, vw, vh) * vw * scale, // 手掌宽（设计像素）
    });
  }
  for (const id of handSmooth.keys()) if (!seen.has(id)) handSmooth.delete(id);

  // 稳定画面左右：优先 handedness（自拍镜像后解剖左=画面左），交叉手不重排；
  // 仅在 handedness 冲突/缺失时按 x 兜底分配空位（保留原「单手按 x 归边」语义）。
  let left = null, right = null;
  for (const d of detected) {
    if (d.side === 'left' && !left) left = d;
    else if (d.side === 'right' && !right) right = d;
  }
  const rest = detected.filter(d => d !== left && d !== right).sort((a, b) => a.p.x - b.p.x);
  if (!left && !right && rest.length === 1) {
    if (rest[0].p.x < 960) left = rest[0]; else right = rest[0];
  } else {
    if (!left) left = rest.shift() || null;
    if (!right) right = rest.shift() || null;
  }

  if (left) {
    hands.push({ side: 'left', x: left.p.x, y: left.p.y, visible: true });
    if (drumStrokes.left.update({ y: left.p.y, palmWidth: left.pw, confidence: left.confidence }, now)) hits.push('left');
  } else {
    hands.push({ side: 'left', visible: false });
    drumStrokes.left.reset();
  }

  if (right) {
    hands.push({ side: 'right', x: right.p.x, y: right.p.y, visible: true });
    const inRegion = isInRegion(right.p, DRUM_COMMAND);
    command = { x: right.p.x, y: right.p.y, active: inRegion };
    // 画面右侧是「指令手」：进入右下指令区时暂停它的敲击判定，并复位状态避免离开误触。
    if (!inRegion) {
      if (drumStrokes.right.update({ y: right.p.y, palmWidth: right.pw, confidence: right.confidence }, now)) hits.push('right');
    } else {
      drumStrokes.right.reset();
    }
  } else {
    hands.push({ side: 'right', visible: false });
    drumStrokes.right.reset();
  }

  for (const s of hits) playDrumHit(s);
  postTo('if-act1', { type: 'opera:input', act: 'drum', hands, hits, command });
}

function processSleeves(vw, vh) {
  injectStream('if-act2');
  const ts = performance.now();
  const poseResult = poseLandmarker.detectForVideo(detCv, ts);
  const landmarks = (poseResult && poseResult.landmarks && poseResult.landmarks[0]) || null;

  // 「下一幕」指令指针：与第一/三幕一致，用右手掌心（画面右侧）而非手腕，更易对准按钮。
  let command = { x: 0, y: 0, active: false };
  const handResult = handLandmarker.detectForVideo(detCv, ts);
  const hl = (handResult && handResult.landmarks) || [];
  const hlist = handResult && (handResult.handedness || handResult.handednesses);
  for (let i = 0; i < hl.length; i++) {
    const hc = hlist && hlist[i] && hlist[i][0];
    if (!hc || handednessToSide(hc.categoryName) !== 'right') continue;
    const sm = smoothArr(handSmooth.get(hc.categoryName), flatten(hl[i]), SMOOTH_HAND);
    handSmooth.set(hc.categoryName, sm);
    const lm = unflatten(sm);
    const pc = palmCenter(lm);
    const p = mapVideoPoint(pc.x, pc.y, vw, vh, MIRROR);
    command = { x: p.x, y: p.y, active: openPalm(lm) };
    break;
  }

  postTo('if-act2', { type: 'opera:input', act: 'sleeves', landmarks, command, width: vw, height: vh });
}

function processFinale(vw, vh) {
  const ts = performance.now();
  const faceResult = faceLandmarker.detectForVideo(detCv, ts);
  const handResult = handLandmarker.detectForVideo(detCv, ts);

  let face = null;
  const fl = faceResult && faceResult.faceLandmarks;
  if (fl && fl.length) {
    const lm = fl[0];
    const le = smoothPt(faceSmooth.leftEye, mid(lm, 33, 133), SMOOTH_FACE);
    const re = smoothPt(faceSmooth.rightEye, mid(lm, 263, 362), SMOOTH_FACE);
    const mo = smoothPt(faceSmooth.mouth, mid(lm, 13, 14), SMOOTH_FACE);
    faceSmooth.active = true;
    faceSmooth.leftEye = le; faceSmooth.rightEye = re; faceSmooth.mouth = mo;
    face = { leftEye: le, rightEye: re, mouth: mo,
      landmarks: lm.map(p => ({ x:p.x, y:p.y, z:p.z })) };
  } else {
    faceSmooth.active = false;
    faceSmooth.leftEye = faceSmooth.rightEye = faceSmooth.mouth = null;
  }

  const hands = [];
  const hl = handResult && handResult.landmarks;
  const seen = new Set();
  if (hl) {
    hl.forEach((hlm, i) => {
      const hlist = handResult.handedness || handResult.handednesses;
      const hc = hlist && hlist[i] && hlist[i][0];
      const id = hc ? hc.categoryName : ('hand' + i);
      seen.add(id);
      const sm = smoothArr(handSmooth.get(id), flatten(hlm), SMOOTH_HAND);
      handSmooth.set(id, sm);
      const lm = unflatten(sm);
      const pc = palmCenter(lm);
      hands.push({ id, x: pc.x, y: pc.y, pinchRatio: pinchRatio(lm), openPalm: openPalm(lm) });
    });
  }
  for (const id of handSmooth.keys()) if (!seen.has(id)) handSmooth.delete(id);

  // 把同一路摄像头流注入第三幕的 <video> 作镜像背景。
  injectStream('if-act3');

  postTo('if-act3', { type: 'opera:input', act: 'finale', frame: { face, hands }, width: vw, height: vh });
}

function injectStream(iframeId) {
  if (!stream) return;
  const f = document.getElementById(iframeId);
  if (!f || !f.contentDocument) return;
  const v = f.contentDocument.querySelector('video');
  if (v && v.srcObject !== stream) { v.srcObject = stream; v.classList.add('on'); }
}

// ===== 主循环 =====
function activeFrameKey() {
  for (const id of ['if-act1', 'if-act2', 'if-act3']) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) return { id, el };
  }
  return null;
}

function processFrame() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const dw = DETECT_W, dh = Math.round(DETECT_W * vh / vw);
  if (detCv.width !== dw || detCv.height !== dh) { detCv.width = dw; detCv.height = dh; }
  dctx.drawImage(video, 0, 0, dw, dh);

  const a = activeFrameKey();
  if (!a) return; // 首页 / 结束页不识别
  if (a.id === 'if-act1') processDrum(vw, vh);
  else if (a.id === 'if-act2') processSleeves(vw, vh);
  else if (a.id === 'if-act3') processFinale(vw, vh);
}

function loop() {
  if (!running) return;
  if (video && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try { processFrame(); } catch (e) { /* 单帧异常不打断 */ }
  }
  requestAnimationFrame(loop);
}

// ===== 启动 / 停止 =====
async function opusStart() {
  if (running) return;
  if (!video) {
    video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    detCv = document.createElement('canvas');
    dctx = detCv.getContext('2d');
  }
  const st = statusEl();
  try {
    if (!faceLandmarker) {
      if (st) st.textContent = '加载识别模型…';
      await initModels();
    }
    if (!stream) {
      if (st) st.textContent = '请求摄像头权限…';
      await startCamera();
    }
    running = true;
    if (st) st.textContent = '摄像头识别中';
    requestAnimationFrame(loop);
  } catch (e) {
    console.error(e);
    if (st) st.textContent = '摄像头不可用（可改用鼠标测试控件）';
    running = false;
  }
}

function opusStop() {
  running = false;
  const st = statusEl();
  if (st) st.textContent = '摄像头未开启';
}

window.opusStart = opusStart;
window.opusStop = opusStop;
