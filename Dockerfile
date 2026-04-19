FROM python:3.11-slim AS builder

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY pipeline/ pipeline/
COPY config/ config/
COPY web/ web/

RUN mkdir -p data/raw data/processed web/data

# Build the atlas for Nigeria by default (override with --build-arg COUNTRY=BGD etc.)
ARG COUNTRY=NGA
RUN python -m pipeline.build --country ${COUNTRY} --limit 200

# ---- serve ----
FROM python:3.11-slim

WORKDIR /app
COPY --from=builder /app/web/ web/
COPY --from=builder /app/data/ data/

EXPOSE 8787

CMD ["python", "-m", "http.server", "8787", "--directory", "web"]
