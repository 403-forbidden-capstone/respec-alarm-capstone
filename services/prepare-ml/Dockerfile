FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py survey_v2_model.py ./

# Ship application code only. Provision C1/W4 .cbm artifacts on the host and
# mount /app/models/v4_age_only read-only at runtime (no binaries in GHCR/Git).
ENV CATBOOST_MODEL_DIR=/app/models/v4_age_only PORT=8091
EXPOSE 8091

# A running Uvicorn process is not enough: both models must load successfully.
# The Python standard library is available in the image; no curl dependency.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import json,os,urllib.request; response=urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8091')+'/health',timeout=3); assert json.load(response).get('ok') is True" || exit 1

CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port ${PORT:-8091}"]
