FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    NLTK_DATA=/usr/local/share/nltk_data \
    PIPECAT_HOST=0.0.0.0 \
    PIPECAT_PORT=7860 \
    PIPECAT_TRANSPORT=twilio

WORKDIR /app

RUN groupadd --system app && useradd --system --uid 10001 --gid app app

COPY requirements.txt .
RUN pip install --upgrade pip && \
    pip install -r requirements.txt && \
    python -m nltk.downloader -d /usr/local/share/nltk_data punkt_tab

COPY voice_agent ./voice_agent

USER app
EXPOSE 7860

CMD ["python", "-m", "voice_agent.bot"]
