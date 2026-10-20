# syntax=docker/dockerfile:1.7
# Build from the repo root: docker build -f crates/kuro-cr/Dockerfile crates/kuro-cr
FROM rust:1-slim-trixie AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/kuro-cr /kuro-cr

FROM debian:trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /kuro-cr /usr/local/bin/kuro-cr
USER 65534:65534
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["curl", "-fsS", "http://127.0.0.1:8080/healthz"]
CMD ["kuro-cr"]
