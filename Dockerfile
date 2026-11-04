FROM rust:1.96.0-slim-bookworm@sha256:4732ca96fd086cb9be682050c3f0176288eebaac2b80aa2bcefccfaf198e1950 AS wallet
RUN apt-get update && apt-get install -y --no-install-recommends cmake pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY shared ./shared
RUN cargo build --locked --release --bin private-recurring-wallet -j 2

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS frontend
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
COPY shared /build/shared
RUN npm run build:product

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gosu util-linux \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=wallet /build/target/release/private-recurring-wallet /usr/local/bin/prp
COPY --from=frontend /build/web/dist-product ./web/dist-product
COPY app ./app
COPY shared ./shared
COPY deploy/entrypoint.sh /usr/local/bin/tandem-entrypoint
ENV NODE_ENV=production APP_HOST=0.0.0.0 APP_STATE_DIR=/state PRP_BINARY=/usr/local/bin/prp
ENTRYPOINT ["sh", "/usr/local/bin/tandem-entrypoint"]
