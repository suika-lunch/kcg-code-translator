FROM oven/bun:1
WORKDIR /app
COPY . .
RUN bun install
RUN bun tsdown
 
ARG PORT=3000
EXPOSE $PORT
 
CMD ["bun", "start"]