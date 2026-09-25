FROM oven/bun:1.3

WORKDIR /app
COPY . .

# Build the site here, where memory is plentiful, so the container only serves it.
RUN bun install --frozen-lockfile && cd apps/web && bun run build

ENV SKIP_BUILD=1 PORT=10000
EXPOSE 10000

CMD ["bun", "run", "start"]
