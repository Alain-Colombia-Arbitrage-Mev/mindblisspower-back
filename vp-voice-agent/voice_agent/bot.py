from __future__ import annotations

import hashlib
import hmac
import os
import re
import sys
import time
from typing import Any

import aiohttp
from dotenv import load_dotenv
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame, TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.openrouter.llm import OpenRouterLLMService
from pipecat.transports.base_transport import BaseTransport
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams
from pipecat.workers.runner import WorkerRunner


load_dotenv(override=False)


SYSTEM_PROMPT = """Eres el agente de soporte telefonico de Mindbliss Power.
Respondes solo solicitudes de soporte sobre acceso, OTP, telefono, pagos, KYC,
arbol binario, referidos, comisiones, rangos, wallet, retiros o errores de la app.

Reglas:
- Para preguntas de soporte, usa siempre la funcion consultar_soporte antes de responder.
- Si el usuario pide otra cosa, di brevemente que solo puedes atender soporte.
- No prometas reembolsos, pagos, cambios de cuenta, activaciones ni resultados financieros.
- Si falta informacion o requiere validacion manual, escala a un agente humano.
- Tus respuestas se leen en voz alta: maximo dos frases, sin markdown, tablas ni listas.
"""

SUPPORT_KEYWORDS = (
    "codigo",
    "otp",
    "sms",
    "verificacion",
    "validar",
    "login",
    "acceso",
    "entrar",
    "contrasena",
    "telefono",
    "celular",
    "whatsapp",
    "pago",
    "comprar",
    "checkout",
    "stripe",
    "tarjeta",
    "rechazada",
    "fallido",
    "recibo",
    "reembolso",
    "chargeback",
    "contracargo",
    "kyc",
    "documento",
    "pasaporte",
    "identidad",
    "arbol",
    "binario",
    "posicion",
    "derrame",
    "referido",
    "referidos",
    "sponsor",
    "estructura",
    "red",
    "comision",
    "comisiones",
    "bono",
    "rango",
    "nivel",
    "pv",
    "wallet",
    "saldo",
    "retiro",
    "withdrawal",
    "bmp",
    "error",
    "404",
    "no carga",
    "no abre",
    "bug",
    "fallo",
    "problema",
    "soporte",
    "ayuda",
    "ticket",
)

NON_SUPPORT_KEYWORDS = (
    "newsletter",
    "unsubscribe",
    "publicidad",
    "guest post",
    "backlink",
    "alianza",
    "partnership",
    "vacante",
    "empleo",
    "curriculum",
    "prensa",
    "media kit",
    "seo services",
)


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name, "").strip().lower()
    if value in {"1", "true", "yes", "on", "enabled"}:
        return True
    if value in {"0", "false", "no", "off", "disabled"}:
        return False
    return default


def clean_text(value: Any, limit: int) -> str:
    text = "" if value is None else str(value)
    text = text.replace("\x00", "").strip()
    text = "".join(ch for ch in text if ch in "\n\r\t" or ord(ch) >= 32)
    if limit > 0 and len(text) > limit:
        text = text[:limit]
    return text


def clean_field(value: Any, limit: int) -> str:
    return " ".join(clean_text(value, limit).split())


def normalize_text(value: str) -> str:
    text = value.lower()
    replacements = {
        "á": "a",
        "é": "e",
        "í": "i",
        "ó": "o",
        "ú": "u",
        "ü": "u",
        "ñ": "n",
    }
    for src, dst in replacements.items():
        text = text.replace(src, dst)
    text = re.sub(r"[\r\n\t.,;:()[\]{}¿?¡!]+", " ", text)
    return " ".join(text.split())


def looks_like_support(message: str) -> bool:
    text = normalize_text(message)
    if not text:
        return False
    positive = any(keyword in text for keyword in SUPPORT_KEYWORDS)
    negative = any(keyword in text for keyword in NON_SUPPORT_KEYWORDS)
    return positive and not (negative and not positive)


def normalize_channel(value: Any) -> str:
    if str(value).strip().lower() == "whatsapp_call":
        return "whatsapp_call"
    return "voice"


def stream_payload(call_sid: str, ts: str, channel: str) -> str:
    return f"{clean_field(call_sid, 80)}|{ts.strip()}|{normalize_channel(channel)}"


def sign_stream(secret: str, call_sid: str, ts: str, channel: str) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        stream_payload(call_sid, ts, channel).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def flatten_call_body(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        return {}
    out = dict(body)
    for key in ("customParameters", "custom_parameters", "parameters"):
        nested = body.get(key)
        if isinstance(nested, dict):
            out.update(nested)
    return out


def validate_stream_context(runner_args: RunnerArguments) -> dict[str, str]:
    require_signature = env_bool("PIPECAT_REQUIRE_STREAM_SIGNATURE", True)
    call_data = getattr(runner_args, "call_data", None)
    body = flatten_call_body(getattr(call_data, "body", {}) if call_data else {})

    call_sid_raw = getattr(call_data, "call_id", "") if call_data else ""
    if not call_sid_raw:
        call_sid_raw = body.get("mb_call_sid") or body.get("call_sid") or body.get("CallSid")
    call_sid = clean_field(call_sid_raw, 80)
    channel = normalize_channel(body.get("mb_channel", "voice"))
    ts = clean_field(body.get("mb_ts", ""), 20)
    provided_sig = clean_field(body.get("mb_sig", ""), 128)
    secret = os.getenv("PIPECAT_STREAM_SECRET") or os.getenv("PAYMENTS_PIPECAT_STREAM_SECRET", "")

    if not require_signature:
        return {"call_sid": call_sid or f"local-{int(time.time())}", "channel": channel}
    if not secret:
        raise RuntimeError("PIPECAT_STREAM_SECRET required")
    if not call_sid or not ts or not provided_sig:
        raise RuntimeError("missing signed stream parameters")
    try:
        ts_int = int(ts)
    except ValueError as exc:
        raise RuntimeError("invalid stream timestamp") from exc
    ttl = int(os.getenv("PIPECAT_STREAM_SIG_TTL_SEC", "300"))
    if abs(int(time.time()) - ts_int) > ttl:
        raise RuntimeError("expired stream signature")
    expected = sign_stream(secret, call_sid, ts, channel)
    if not hmac.compare_digest(expected, provided_sig):
        raise RuntimeError("invalid stream signature")
    return {"call_sid": call_sid, "channel": channel}


def require_env(names: tuple[str, ...]) -> None:
    missing = [name for name in names if not os.getenv(name)]
    if missing:
        raise RuntimeError("missing voice agent env: " + ", ".join(missing))


def pseudo_voice_email(call_sid: str) -> str:
    local = re.sub(r"[^a-z0-9]+", "-", call_sid.lower()).strip("-")
    return f"voice+{local or 'unknown'}@support.mindblisspower.local"


async def post_json(url: str, headers: dict[str, str], payload: dict[str, Any], timeout_sec: int) -> dict[str, Any]:
    timeout = aiohttp.ClientTimeout(total=timeout_sec)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, headers=headers, json=payload) as resp:
            if resp.status < 200 or resp.status >= 300:
                body = await resp.text()
                raise RuntimeError(f"status {resp.status}: {clean_field(body, 160)}")
            data = await resp.json(content_type=None)
            if not isinstance(data, dict):
                raise RuntimeError("invalid json response")
            return data


async def call_support_ai(message: str, call_sid: str) -> dict[str, Any]:
    base_url = (
        os.getenv("PIPECAT_SUPPORT_AI_URL")
        or os.getenv("SUPPORT_AI_URL")
        or "http://127.0.0.1:9096"
    ).rstrip("/")
    token = (
        os.getenv("PIPECAT_SUPPORT_AI_SERVICE_TOKEN")
        or os.getenv("SUPPORT_AI_SERVICE_TOKEN")
        or os.getenv("SERVICE_TOKEN")
        or ""
    )
    if not token:
        raise RuntimeError("support ai token missing")
    return await post_json(
        f"{base_url}/api/support/chat",
        {
            "Content-Type": "application/json",
            "X-VP-Service-Token": token,
            "X-VP-User-Email": pseudo_voice_email(call_sid),
        },
        {"message": message},
        45,
    )


async def record_voice_turn(
    call_sid: str,
    channel: str,
    user_message: str,
    ai_answer: str,
    final: bool = False,
) -> dict[str, Any]:
    base_url = (
        os.getenv("PIPECAT_PAYMENTS_URL")
        or os.getenv("PAYMENTS_INTERNAL_URL")
        or "http://127.0.0.1:9095"
    ).rstrip("/")
    token = os.getenv("PIPECAT_PAYMENTS_SERVICE_TOKEN") or os.getenv("PAYMENTS_SERVICE_TOKEN") or ""
    if not token:
        logger.warning("PIPECAT_PAYMENTS_SERVICE_TOKEN missing; voice turn not persisted")
        return {}
    try:
        return await post_json(
            f"{base_url}/internal/support/voice/turn",
            {"Content-Type": "application/json", "X-VP-Service-Token": token},
            {
                "call_sid": call_sid,
                "channel": channel,
                "user_message": user_message,
                "ai_answer": ai_answer,
                "final": final,
            },
            10,
        )
    except Exception as exc:
        logger.warning(f"voice turn persist failed: {exc}")
        return {}


def make_support_tool(stream_ctx: dict[str, str]):
    async def consultar_soporte(params: FunctionCallParams, pregunta: str):
        """Consulta soporte de Mindbliss Power para resolver una solicitud del usuario.

        Args:
            pregunta: La pregunta o problema de soporte expresado por el usuario.
        """

        call_sid = stream_ctx["call_sid"]
        channel = stream_ctx["channel"]
        question = clean_text(pregunta, 1800)
        if not looks_like_support(question):
            answer = "Solo puedo atender solicitudes de soporte de Mindbliss Power."
            await record_voice_turn(call_sid, channel, question, answer)
            await params.result_callback(
                {"answer": answer, "support_request": False, "escalate": True, "ticket_id": 0}
            )
            return

        try:
            result = await call_support_ai(question, call_sid)
            answer = clean_text(result.get("answer"), 900)
            escalate = bool(result.get("escalate"))
            if not answer:
                answer = "Esa consulta la tiene que revisar un agente de soporte."
                escalate = True
        except Exception as exc:
            logger.warning(f"support ai failed: {exc}")
            answer = "El asistente no esta disponible en este momento; te conecto con soporte."
            result = {"sources": [], "escalate": True}
            escalate = True

        persisted = await record_voice_turn(call_sid, channel, question, answer)
        ticket_id = int(persisted.get("ticket_id") or 0)
        await params.result_callback(
            {
                "answer": answer,
                "support_request": True,
                "escalate": escalate,
                "ticket_id": ticket_id,
                "sources_count": len(result.get("sources") or []),
            }
        )

    return consultar_soporte


async def run_bot(
    transport: BaseTransport,
    runner_args: RunnerArguments,
    stream_ctx: dict[str, str],
    testing: bool,
) -> None:
    require_env(("OPENROUTER_API_KEY", "DEEPGRAM_API_KEY", "CARTESIA_API_KEY"))

    stt = DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"])
    tts = CartesiaTTSService(
        api_key=os.environ["CARTESIA_API_KEY"],
        settings=CartesiaTTSService.Settings(
            voice=os.getenv("CARTESIA_VOICE_ID", "71a7ad14-091c-4e8e-a314-022ece01c121"),
        ),
        push_silence_after_stop=testing,
    )
    llm = OpenRouterLLMService(
        api_key=os.environ["OPENROUTER_API_KEY"],
        settings=OpenRouterLLMService.Settings(
            model=os.getenv("PIPECAT_OPENROUTER_MODEL", "openai/gpt-4o-mini"),
            system_instruction=SYSTEM_PROMPT,
        ),
    )

    @llm.event_handler("on_function_calls_started")
    async def on_function_calls_started(service, function_calls):
        await tts.queue_frame(TTSSpeakFrame("Voy a revisar soporte."))

    context = LLMContext(tools=[make_support_tool(stream_ctx)])
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )
    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,
            audio_out_sample_rate=8000,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        idle_timeout_secs=runner_args.pipeline_idle_timeout_secs,
    )
    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint, force_gc=True)
    await runner.add_workers(worker)

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info(f"voice client connected call_sid={stream_ctx['call_sid']}")
        context.add_message(
            {
                "role": "developer",
                "content": "Saluda en una frase como soporte de Mindbliss Power y pide el problema.",
            }
        )
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info(f"voice client disconnected call_sid={stream_ctx['call_sid']}")
        await runner.cancel()

    await runner.run()


async def bot(runner_args: RunnerArguments, testing: bool | None = False):
    """Pipecat runner entry point."""

    stream_ctx = validate_stream_context(runner_args)
    transport_params = {
        "twilio": lambda: FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    }
    transport = await create_transport(runner_args, transport_params)
    await run_bot(transport, runner_args, stream_ctx, bool(testing))


def configure_argv_from_env() -> None:
    if len(sys.argv) > 1:
        return
    sys.argv.extend(
        [
            "--host",
            os.getenv("PIPECAT_HOST", "0.0.0.0"),
            "--port",
            os.getenv("PIPECAT_PORT", "7860"),
            "-t",
            os.getenv("PIPECAT_TRANSPORT", "twilio"),
        ]
    )
    proxy = os.getenv("PIPECAT_PROXY_HOST")
    if proxy:
        sys.argv.extend(["-x", proxy])
    for origin in filter(None, (o.strip() for o in os.getenv("PIPECAT_ALLOWED_ORIGINS", "").split(","))):
        sys.argv.extend(["--allowed-origins", origin])


if __name__ == "__main__":
    configure_argv_from_env()
    from pipecat.runner.run import main

    main()
