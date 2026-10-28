# -*- coding: utf-8 -*-
"""一键启动「川剧变脸 · 三幕互动」集成网站。

在本目录起一个本地静态服务器，并自动打开浏览器。
必须用 localhost 打开（不能直接双击 index.html）：
  - 第三幕变脸页的摄像头按钮需要安全上下文（localhost 满足）。
  - iframe 与外壳同源，postMessage 跳转最稳。

用法：
    python run.py
    然后浏览器会自动打开 http://localhost:8000/
"""
import http.server
import os
import threading
import webbrowser

PORT = 8000

# 网站文件在 docs/ 目录（GitHub Pages 从 /docs 发布），以 docs/ 为根目录
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'docs'))


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args, **kwargs):
        pass


def _open_browser():
    webbrowser.open(f"http://localhost:{PORT}/")


def main():
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), _QuietHandler)
    print(f"[信息] 三幕集成网站: http://localhost:{PORT}/  （Ctrl+C 退出）")
    threading.Timer(0.5, _open_browser).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[退出] 已停止服务器")
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
