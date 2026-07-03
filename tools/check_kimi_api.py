import getpass
import json
import urllib.error
import urllib.request


BASE_URL = "https://api.moonshot.cn/v1"


def request_json(method, url, api_key, payload=None):
    data = None
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, body
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return exc.code, body


def print_response(title, status, body):
    print(f"\n=== {title} ===")
    print(f"HTTP {status}")
    try:
        parsed = json.loads(body)
        print(json.dumps(parsed, ensure_ascii=False, indent=2))
    except json.JSONDecodeError:
        print(body)


def main():
    api_key = getpass.getpass("Moonshot API key: ").strip()
    model = input("Model [kimi-k2.6]: ").strip() or "kimi-k2.6"

    status, body = request_json("GET", f"{BASE_URL}/models", api_key)
    print_response("GET /models", status, body)

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "你是一个简洁的中文助手。"},
            {"role": "user", "content": "只回复两个字：你好"},
        ],
        "temperature": 0.2,
        "max_completion_tokens": 64,
    }
    status, body = request_json("POST", f"{BASE_URL}/chat/completions", api_key, payload)
    print_response("POST /chat/completions basic", status, body)

    eval_payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "只输出 JSON。"},
            {"role": "user", "content": "输出 {\"score\": 1, \"note\": \"ok\"}"},
        ],
        "temperature": 0,
        "max_completion_tokens": 128,
        "response_format": {"type": "json_object"},
        "thinking": {"type": "enabled"},
    }
    status, body = request_json("POST", f"{BASE_URL}/chat/completions", api_key, eval_payload)
    print_response("POST /chat/completions eval-like", status, body)


if __name__ == "__main__":
    main()
