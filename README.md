# 川剧变脸 · 三幕互动

川剧变脸互动网站：**锣鼓开场 · 水袖舞动 · 变脸喷火**，用摄像头 + 浏览器端 MediaPipe 手势识别驱动。

在线体验：https://frankle-cloud.github.io/chuanju-bianlian/

## 本地运行

必须用本地服务器打开（不能直接双击 `index.html`——摄像头需要安全上下文，且 iframe 同源才能稳定跳转）：

```bash
python run.py
```

`run.py` 会自动打开 http://localhost:8000/ 。首次点「开始体验」会请求摄像头权限，请允许；识别模型首次加载需稍等几秒。

## 三幕怎么玩（手势）

| 幕 | 核心手势 | 切到下一幕 |
|----|---------|-----------|
| 第一幕 · 锣鼓 | 对镜头**抬手 → 下敲**，左右手依次凑出「左→右→左→右」四拍 | 四拍完成后，把**右手**移到画面右下角「下一幕」区域，停留 1 秒 |
| 第二幕 · 水袖 | 双臂**展袖**（向两侧舒展）→ **扬袖**（双手抬起再放下） | 完成两项后，把**右手腕**移到右下「下一幕」区域，停留 1 秒 |
| 第三幕 · 变脸与喷火 | **张开手掌在脸前横向挥过**换脸；**拇指与食指捏合** 0.3 秒喷火 | 各体验一次后，手移到右下「结束」区域，停留 1 秒 |

## 无摄像头时的回退

摄像头不可用/未授权时，右上角显示「摄像头不可用」，三幕各自的鼠标/按钮测试控件仍可用：

- 锣鼓：点 `左手敲击` / `右手敲击`，或按键盘 `A` / `D`；右下「下一幕」按钮。
- 水袖：`测试展袖 → 测试抬手 → 测试放下`，或拖动肘/腕控制点。
- 变脸：`模拟挥掌 · 变脸` + `模拟捏合 · 喷火`，鼠标移动定位脸谱。

## 目录结构

网站文件在 `docs/`（GitHub Pages 从 `/docs` 发布）：

- `docs/index.html` + `docs/recognition.js` —— 外壳 + 唯一一路摄像头识别（MediaPipe）
- `docs/act1-drum.html` —— 第一幕 · 锣鼓
- `docs/act2-sleeves.html` —— 第二幕 · 水袖
- `docs/act3-finale.html` —— 第三幕 · 变脸与喷火
- `docs/lib/` —— MediaPipe 引擎（`vision_bundle.mjs`、`wasm/`）+ 锣鼓/水袖组件引擎（`drum-component.js`、`sleeves-engine.js`）
- `docs/models/` —— MediaPipe 模型文件
- `docs/sounds/` —— 击鼓音效
- `run.py` —— 一键启动本地服务器

## 已知可调参数

- 锣鼓敲击判定在 `docs/recognition.js` 的 `StrokeDetector`：抬手→下敲，阈值按手掌宽自适应（lift≈掌宽×0.35、drop≈掌宽×0.45，下限 25/30 设计像素），触发后 300ms 冷却、60–650ms 时间窗、置信度 <0.7 丢弃。手势难触发/易误触时调这里。
- 鼓棒方向默认固定（`docs/lib/drum-component.js` 的 `StickMotion`，`allowTilt` 默认 false）；确需轻微倾斜可传 `allowTilt:true`（±12° 偏移）。
- 变脸「张开手掌」「捏合」的计算参数也在 `docs/recognition.js`。
