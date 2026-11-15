"""Run the real Django scan endpoint with only its external dependencies mocked.

This test server never calls OpenAI or the public APIs. The mock's classification
is a fixture; the SDK, Django endpoint, evidence checks, and risk engine are real.
"""

from contextlib import nullcontext
import atexit
import json
import logging
import os
from pathlib import Path
import sys
import signal
import tempfile
from unittest.mock import patch
from wsgiref.simple_server import WSGIRequestHandler, make_server


backend_root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(backend_root / "app"))
os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings"
os.environ["WOOWANG_PRODUCTION"] = "0"
os.environ["OPENAI_API_KEY"] = "integration-test-key"
os.environ["OPENAI_MODEL"] = "gpt-6-luna"

import django
import httpx
from openai import OpenAI

from django.conf import settings

# Every HTTP test process owns a new database. Never migrate or cache responses
# into a developer's workspace database, including when the cache model changes.
test_database = tempfile.TemporaryDirectory(prefix="woowangthon-http-test-")
settings.DATABASES = {"default": {
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": str(Path(test_database.name) / "http-tests.sqlite3"),
}}
settings.ALLOWED_HOSTS = ["127.0.0.1", "localhost"]
settings.DEBUG = False
logging.disable(logging.CRITICAL)

database_cleaned = False


def cleanup_database():
    global database_cleaned
    if database_cleaned:
        return
    try:
        if "connections" in globals():
            connections.close_all()
    finally:
        test_database.cleanup()
        database_cleaned = True


atexit.register(cleanup_database)
django.setup()
logging.disable(logging.CRITICAL)

from django.core.management import call_command
from django.core.wsgi import get_wsgi_application
from django.db import connections

call_command("migrate", interactive=False, verbosity=0)
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
scanner = get_user_model().objects.create_user(
    username="integration-scanner", password="Synthetic-login-only-2468!",
)
scanner.groups.add(Group.objects.get_or_create(
    name=getattr(settings,"WOOWANG_SCANNER_GROUP","woowang-scanners"),
)[0])

EVIDENCE = "출금하려면 5만 원을 먼저 입금하세요"
NTS_RESULT = {
    "status": "completed",
    "business_status": "폐업",
    "business_status_description": "폐업자",
}
FTC_RESULT = {
    "status": "completed",
    "search_method": "BUSINESS_NUMBER",
    "match_status": "MATCH",
    "verification": {
        "business_number": "MATCH",
        "business_name": "MISMATCH",
        "representative_name": "MATCH",
    },
}


external_calls = {"nts": 0, "ftc": 0, "ai": 0}


def mock_nts_lookup(_business_number):
    external_calls["nts"] += 1
    if str(_business_number).replace("-", "") == "5555555555":
        return {"status": "completed", "business_status": "ACTIVE", "business_status_description": "계속사업자"}
    return dict(NTS_RESULT)


def mock_ftc_lookup(business_info):
    external_calls["ftc"] += 1
    if str(business_info.get("business_number", "")).replace("-", "") == "5555555555":
        return {"status": "completed", "search_method": "BUSINESS_NUMBER", "match_status": "MATCH",
                "verification": {"business_number": "MATCH", "business_name": "MATCH", "representative_name": "MATCH"}}
    if (business_info.get("displayed_business_number") == "125-86-112516"
            and not business_info.get("business_number")):
        return {"status": "completed", "search_method": "BUSINESS_NAME",
                "match_status": "NO_MATCH", "candidates": []}
    return dict(FTC_RESULT)


def mock_openai_response(request):
    external_calls["ai"] += 1
    assert request.url.path == "/v1/responses"
    payload = json.loads(request.content)
    model_input = payload["input"]
    try:
        observations = json.loads(model_input)
        if not isinstance(observations, list):
            observations = None
    except (TypeError, ValueError):
        observations = None
    context = "\n".join(item["text"] for item in observations) if observations is not None else model_input
    if "시간 초과" in context:
        raise httpx.ReadTimeout("mocked OpenAI timeout", request=request)
    signals = []
    if EVIDENCE in context:
        signals = [{
            "type": "ADVANCE_PAYMENT_REQUIRED",
            "evidence": EVIDENCE,
            "reason": "출금의 조건으로 별도의 선입금을 요구하는 모의 신호입니다.",
        }]
        if observations is not None:
            signals[0]["source_id"] = next(item["id"] for item in observations if EVIDENCE in item["text"])
    if observations is not None:
        for item in observations:
            for marker, signal_type in [
                ("후기를 작성하면 보상 적립금을 드립니다.", "REWARD_OFFER"),
                ("적립된 수익금을 확인하고 출금을 신청하세요.", "EARNINGS_DISPLAY"),
                ("계정 인증 전에는 출금이 제한됩니다.", "WITHDRAWAL_RESTRICTED"),
            ]:
                if marker in item["text"]:
                    signals.append({"type": signal_type, "source_id": item["id"], "evidence": marker,
                                    "reason": "합성 단계 기록을 반환하는 모의 신호입니다."})
    return httpx.Response(200, json={
        "id": "resp_http_integration",
        "object": "response",
        "created_at": 1794690000,
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "instructions": None,
        "metadata": {},
        "model": payload["model"],
        "output": [{
            "id": "msg_integration",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{
                "type": "output_text",
                "text": json.dumps({"signals": signals}),
                "annotations": [],
            }],
        }],
        "parallel_tool_calls": False,
        "temperature": 1,
        "tool_choice": "auto",
        "tools": [],
        "top_p": 1,
    })


def mock_client(**kwargs):
    return OpenAI(
        **kwargs,
        http_client=httpx.Client(transport=httpx.MockTransport(mock_openai_response)),
    )


class QuietHandler(WSGIRequestHandler):
    def log_message(self, *_args):
        pass


django_app = get_wsgi_application()


def application(environ, start_response):
    calls_before = dict(external_calls)

    def mark_real_backend(status, headers, exc_info=None):
        return start_response(
            status, headers + [
                ("X-Test-Backend", "django-working-copy"),
                ("X-Test-NTS-Calls", str(external_calls["nts"] - calls_before["nts"])),
                ("X-Test-FTC-Calls", str(external_calls["ftc"] - calls_before["ftc"])),
                ("X-Test-AI-Calls", str(external_calls["ai"] - calls_before["ai"])),
            ], exc_info
        )
    return django_app(environ, mark_real_backend)


def stop_test_server(_signum, _frame):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop_test_server)
try:
    with (
        patch("scan.views.scan_guard", side_effect=lambda request: nullcontext()),
        patch("access_control.views.auth_guard", return_value=None),
        patch("access_control.views.auth_session_guard", return_value=None),
        patch("access_control.authentication.token_auth_guard", return_value=None),
        patch("scan.services.lookup_nts", side_effect=mock_nts_lookup),
        patch("scan.services.lookup_ftc", side_effect=mock_ftc_lookup),
        patch("ai.services.OpenAI", side_effect=mock_client),
        patch("requests.sessions.Session.request", side_effect=AssertionError("External HTTP disabled")),
        patch("httpx.HTTPTransport.handle_request", side_effect=AssertionError("External HTTP disabled")),
        make_server("127.0.0.1", 0, application, handler_class=QuietHandler) as server,
    ):
        print(json.dumps({"port": server.server_port}), flush=True)
        server.serve_forever()
finally:
    cleanup_database()
