# Self-host the migration web UI at a URL.
#
# Build context is this folder (bulk-file-migration/). Runs in "hosted mode":
# set UI_ACCESS_KEY so the UI requires a login and binds to all interfaces.
#
#   docker build -t sf-org-migrator-ui .
#   docker run -p 4599:4599 \
#     -e UI_ACCESS_KEY="choose-a-strong-key" \
#     -e SOURCE_AUTH_URL="force://..." \
#     -e TARGET_AUTH_URL="force://..." \
#     -v $(pwd)/work:/app/work \
#     sf-org-migrator-ui
FROM node:22-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# App source (.dockerignore keeps secrets/state out of the image).
COPY . .

# Default port for local `docker run`; hosts that inject PORT (Render/Railway/
# Heroku) override it automatically.
EXPOSE 4599

# Hosted mode is enabled by passing UI_ACCESS_KEY at runtime.
CMD ["node", "cli.js", "ui"]
