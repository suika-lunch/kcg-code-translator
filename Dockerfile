FROM oven/bun:1
WORKDIR /app
COPY . .
RUN bun install
RUN bun tsdown
 
ARG PORT
EXPOSE ${PORT:-3000}
 
CMD ["bun", "dist/index.js"]