FROM node:24-bookworm-slim

# Match the database major version for downloadable, restorable pg_dump archives.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl --fail --silent --show-error https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node sql ./sql
COPY --chown=node:node public ./public
COPY --chown=node:node deploy/entrypoint.sh ./deploy/entrypoint.sh
COPY --chown=node:node scripts/demo-cards.js ./scripts/demo-cards.js
RUN install -d -m 700 -o node -g node /app/uploads
USER node
EXPOSE 3000
CMD ["sh", "/app/deploy/entrypoint.sh"]
