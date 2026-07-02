from __future__ import annotations

import base64
import json
import mimetypes
import re
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parent
UPLOAD_DIR = ROOT / "uploads"
HOST = "127.0.0.1"
PORT = 8000


def safe_filename(name: str) -> str:
    stem = Path(name).stem or "image"
    suffix = Path(name).suffix.lower() or ".jpg"
    stem = re.sub(r"[^a-zA-Z0-9._-]+", "_", stem).strip("._-") or "image"
    suffix = re.sub(r"[^a-zA-Z0-9.]+", "", suffix) or ".jpg"
    return f"{stem}{suffix}"


class DemoHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        path = unquote(self.path.split("?", 1)[0])
        if path == "/":
            path = "/index.html"

        file_path = (ROOT / path.lstrip("/")).resolve()
        if not file_path.is_file() or ROOT not in file_path.parents:
            self.send_error(404)
            return

        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != "/upload":
            self.send_error(404)
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length)

        try:
            payload = json.loads(raw_body)
            image_bytes = base64.b64decode(payload["imageBase64"], validate=True)
            original_name = safe_filename(str(payload.get("filename") or "image.jpg"))
        except Exception as exc:
            self.send_json({"ok": False, "error": f"Invalid upload: {exc}"}, status=400)
            return

        UPLOAD_DIR.mkdir(exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        saved_name = f"{timestamp}-{original_name}"
        saved_path = UPLOAD_DIR / saved_name
        saved_path.write_bytes(image_bytes)

        note = str(payload.get("note") or "")
        if note:
            (UPLOAD_DIR / f"{timestamp}.txt").write_text(note, encoding="utf-8")

        self.send_json(
            {
                "ok": True,
                "filename": saved_name,
                "bytes": len(image_bytes),
                "noteSaved": bool(note),
                "path": str(saved_path),
            }
        )

    def send_json(self, data: dict, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    UPLOAD_DIR.mkdir(exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), DemoHandler)
    print(f"Serving http://{HOST}:{PORT}")
    print(f"Uploads: {UPLOAD_DIR}")
    server.serve_forever()


if __name__ == "__main__":
    main()
