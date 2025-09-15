FROM oven/bun:1
WORKDIR /app
COPY . .
RUN bun install --production
 
ARG PORT=3000
EXPOSE $PORT
 
CMD ["bun", "index.ts"]