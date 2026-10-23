FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN bun install --production --ignore-scripts
COPY wrangler.jsonc ./
COPY migrations ./migrations
COPY public ./public
COPY src ./src
RUN mkdir /data && chown bun:bun /data
ENV DATA_DIR=/data PORT=8787
VOLUME /data
EXPOSE 8787
USER bun
CMD ["bun", "src/selfhost/main.ts"]
