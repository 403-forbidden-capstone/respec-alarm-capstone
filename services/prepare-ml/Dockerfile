FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ./
# Deploy requires the two trained CBM files. No training CSV is bundled.
COPY models/v4_age_only/c1_mae.cbm ./models/v4_age_only/c1_mae.cbm
COPY models/v4_age_only/w4_mae.cbm ./models/v4_age_only/w4_mae.cbm
ENV CATBOOST_MODEL_DIR=/app/models/v4_age_only
EXPOSE 8091
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8091}"]
