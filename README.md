# 川剧变脸 · 三幕互动

川剧变脸互动网站：**锣鼓开场 · 水袖舞动 · 变脸喷火**，用摄像头 + MediaPipe 手势识别驱动。

在线体验：https://frankle-cloud.github.io/chuanju-bianlian/

## 本地运行

必须用本地服务器打开（不能直接双击 `index.html`）：

```bash
python run.py
```

`run.py` 会自动打开 http://localhost:8000/ 。

## 结构

网站文件在 `docs/`（GitHub Pages 从 `/docs` 发布）：

- `docs/index.html` + `docs/recognition.js` —— 外壳 + 唯一一路摄像头识别（MediaPipe）
- `docs/act1-drum.html` —— 第一幕 · 锣鼓
- `docs/act2-sleeves.html` —— 第二幕 · 水袖
- `docs/act3-finale.html` —— 第三幕 · 变脸与喷火
- `docs/lib/` `docs/models/` —— MediaPipe 引擎与模型
- `docs/sounds/` —— 击鼓音效
