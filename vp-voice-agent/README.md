# vp-voice-agent

Pipecat-based Twilio Media Streams voice agent for Mindbliss Power support.

Runtime requirements:

- `OPENROUTER_API_KEY`
- `DEEPGRAM_API_KEY`
- `CARTESIA_API_KEY`
- `PIPECAT_STREAM_SECRET`
- `PIPECAT_SUPPORT_AI_URL=http://127.0.0.1:9096`
- `PIPECAT_SUPPORT_AI_SERVICE_TOKEN`
- `PIPECAT_PAYMENTS_URL=http://127.0.0.1:9095`
- `PIPECAT_PAYMENTS_SERVICE_TOKEN`

Optional:

- `PIPECAT_OPENROUTER_MODEL=openai/gpt-4o-mini`
- `CARTESIA_VOICE_ID`
- `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` for Pipecat auto hangup.
- `PIPECAT_PROXY_HOST=app.mindblisspower.com`
- `PIPECAT_ALLOWED_ORIGINS` can stay empty for Twilio Media Streams; stream access is authenticated with the shared HMAC parameters.

Activation path:

1. Deploy `vp-voice-agent` on the worker host.
2. Route `/api/support/voice/pipecat/*` to `127.0.0.1:7860`.
3. Set `PAYMENTS_VOICE_AGENT_MODE=pipecat`.
4. Set `PAYMENTS_PIPECAT_WS_URL=wss://app.mindblisspower.com/api/support/voice/pipecat/ws`.
5. Set the same HMAC value in `PAYMENTS_PIPECAT_STREAM_SECRET` and `PIPECAT_STREAM_SECRET`.

The existing Twilio Gather flow remains the default fallback until step 3 is enabled.
