FROM node:24-bookworm-slim

# yt-dlp (via pip) and ffmpeg are shelled out to at runtime (see server.js spawn calls)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-pip ffmpeg ca-certificates \
    && pip3 install --break-system-packages --no-cache-dir "yt-dlp[default]" \
    && rm -rf /var/lib/apt/lists/*

# YouTube requires a JS runtime to solve download challenges (otherwise HTTP 403).
# Reuse the image's Node instead of installing deno; [default] above pulls in the yt-dlp-ejs solver.
RUN printf -- '--js-runtimes node\n' > /etc/yt-dlp.conf

WORKDIR /app

# Install deps first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# server.js hardcodes PORT = 80
EXPOSE 80

CMD ["node", "server.js"]
