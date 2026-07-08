from __future__ import annotations

import os
from pathlib import Path
import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .auth import router as auth_router
from .database import init_session_factory
from .expression import ExpressionEngine
from .strategy import StrategySelector
from .ai_client import (
    AIClient,
    EVALUATOR_API_KEY, EVALUATOR_BASE_URL, EVALUATOR_MODEL,
)
from . import debug_log
from .admin import create_admin_router
from .evaluation import create_evaluation_router
from .experiment import create_experiment_router
from .pages import router as pages_router
from .websocket import create_websocket_router

ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "static"

app = FastAPI(title="Co-Writing Emotion AI Study")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.include_router(pages_router)
app.include_router(auth_router)

db_session_factory = init_session_factory(str(ROOT_DIR / "data" / "experiment.db"))
expression_engine = ExpressionEngine()
ai_client = AIClient()

eval_ai_client = None
if EVALUATOR_API_KEY:
    eval_ai_client = AIClient(
        model=EVALUATOR_MODEL,
        api_key=EVALUATOR_API_KEY,
        base_url=EVALUATOR_BASE_URL,
    )

app.include_router(create_admin_router(db_session_factory, expression_engine))
app.include_router(create_evaluation_router(eval_ai_client))

selectors: dict[str, StrategySelector] = {}
app.include_router(create_experiment_router(ROOT_DIR, db_session_factory, expression_engine, selectors, eval_ai_client))
app.include_router(create_websocket_router(db_session_factory, expression_engine, selectors, ai_client))


@app.on_event("startup")
async def startup():
    expression_engine.start()
    print("ExpressionEngine started.")

@app.on_event("shutdown")
async def shutdown():
    expression_engine.stop()

@app.get("/api/model-health")
async def model_health():
    return await debug_log._pyfeat_health()

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
